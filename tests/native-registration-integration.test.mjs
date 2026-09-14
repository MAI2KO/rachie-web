import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { reconcileAuthoritativePlayerMirrors } from "../server/native-booking/player-mirror-reconciliation-core.mjs";
import { createProfileScopedBookingRepository } from "../server/native-booking/repository-core.mjs";
import {
  createRegistrationService,
  RegistrationIdempotencyConflictError,
  synchronizeAuthoritativePrimary,
} from "../server/native-booking/registration-service-core.mjs";

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();

async function withProfile(pool, gameProfile, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile', $1, true)", [
      gameProfile,
    ]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function context(profile, communityId, discordUserId) {
  return {
    gameProfile: profile,
    community: { id: communityId },
    discordUser: { id: discordUserId },
  };
}

test(
  "native participant registration is transactional and profile-scoped",
  { skip: !testDatabaseUrl && "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const schema = `registration_test_${randomUUID().replaceAll("-", "")}`;
    const runtimeRole = `registration_runtime_${randomUUID().replaceAll("-", "")}`;
    const runtimePassword = `test_${randomUUID()}`;
    const adminPool = new pg.Pool({ connectionString: testDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const migrationPool = new pg.Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schema}`,
    });
    let runtimePool;

    try {
      const migrations = await loadMigrations(
        fileURLToPath(new URL("../db/migrations/", import.meta.url)),
      );
      await runMigrations(migrationPool, migrations);
      await adminPool.query(
        `CREATE ROLE ${runtimeRole}
         LOGIN PASSWORD '${runtimePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      await adminPool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
      await adminPool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE
         ON ALL TABLES IN SCHEMA ${schema} TO ${runtimeRole}`,
      );
      const runtimeUrl = new URL(testDatabaseUrl);
      runtimeUrl.username = runtimeRole;
      runtimeUrl.password = runtimePassword;
      runtimePool = new pg.Pool({
        connectionString: runtimeUrl.toString(),
        options: `-c search_path=${schema}`,
      });

      const roleShape = await runtimePool.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      assert.deepEqual(roleShape.rows, [
        { rolsuper: false, rolbypassrls: false },
      ]);

      const wosCommunity = randomUUID();
      const kingshotCommunity = randomUUID();
      await withProfile(runtimePool, "wos", (client) =>
        client.query(
          `INSERT INTO booking_communities
             (game_profile, id, location_code, display_name)
           VALUES ('wos', $1, '1001', 'State 1001')`,
          [wosCommunity],
        ),
      );
      await withProfile(runtimePool, "kingshot", (client) =>
        client.query(
          `INSERT INTO booking_communities
             (game_profile, id, location_code, display_name)
           VALUES ('kingshot', $1, '2002', 'Kingdom 2002')`,
          [kingshotCommunity],
        ),
      );

      const wosRepository = createProfileScopedBookingRepository(
        "wos",
        runtimePool,
      );
      const kingshotRepository = createProfileScopedBookingRepository(
        "kingshot",
        runtimePool,
      );

      await t.test("create, replay, update, and audit share one transaction", async () => {
        const service = createRegistrationService({
          context: context("wos", wosCommunity, "wos-user"),
          repository: wosRepository,
        });
        const firstPayload = {
          playerId: "123456",
          inGameName: "First Name",
          alliance: "ABC",
        };
        const created = await service.upsert(
          firstPayload,
          "registration-create-0001",
        );
        assert.equal(created.status, 201);
        const replay = await service.upsert(
          firstPayload,
          "registration-create-0001",
        );
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.body, created.body);
        await assert.rejects(
          service.upsert(
            { ...firstPayload, alliance: "XYZ" },
            "registration-create-0001",
          ),
          RegistrationIdempotencyConflictError,
        );

        const updated = await service.upsert(
          {
            playerId: "123456",
            inGameName: "Updated Name",
            alliance: "Z9Z",
          },
          "registration-update-0001",
        );
        assert.equal(updated.status, 200);

        const rows = await withProfile(runtimePool, "wos", (client) =>
          client.query(
            `SELECT discord_user_id, player_id, in_game_name, alliance
             FROM booking_participants
             WHERE community_id = $1`,
            [wosCommunity],
          ),
        );
        assert.deepEqual(rows.rows, [
          {
            discord_user_id: "wos-user",
            player_id: "123456",
            in_game_name: "Updated Name",
            alliance: "Z9Z",
          },
        ]);
        const audit = await withProfile(runtimePool, "wos", (client) =>
          client.query(
            `SELECT event_type, before_data, after_data
             FROM booking_change_events
             WHERE community_id = $1
             ORDER BY created_at, id`,
            [wosCommunity],
          ),
        );
        assert.equal(audit.rowCount, 2);
        assert.deepEqual(
          audit.rows.map((row) => row.event_type).sort(),
          ["participant_registered", "participant_registration_updated"],
        );
        assert.ok(audit.rows.every((row) => row.after_data.playerId));
        assert.doesNotMatch(
          JSON.stringify(audit.rows),
          /session|cookie|oauth|token/i,
        );
        const outbox = await withProfile(runtimePool, "wos", (client) =>
          client.query("SELECT count(*)::int AS count FROM booking_outbox"),
        );
        assert.equal(outbox.rows[0].count, 0);
      });

      await t.test("concurrent identical requests create and audit exactly once", async () => {
        const service = createRegistrationService({
          context: context("wos", wosCommunity, "concurrent-user"),
          repository: wosRepository,
        });
        const payload = {
          playerId: "222222",
          inGameName: "Concurrent",
          alliance: "CON",
        };
        const results = await Promise.all([
          service.upsert(payload, "concurrent-register-0001"),
          service.upsert(payload, "concurrent-register-0001"),
        ]);
        assert.equal(results.filter((result) => result.replayed).length, 1);
        assert.deepEqual(results[0].body, results[1].body);

        const counts = await withProfile(runtimePool, "wos", async (client) => ({
          participants: await client.query(
            `SELECT count(*)::int AS count FROM booking_participants
             WHERE discord_user_id = 'concurrent-user'`,
          ),
          events: await client.query(
            `SELECT count(*)::int AS count FROM booking_change_events
             WHERE actor_id = 'concurrent-user'`,
          ),
        }));
        assert.equal(counts.participants.rows[0].count, 1);
        assert.equal(counts.events.rows[0].count, 1);
      });

      await t.test("trusted authoritative primary sync demotes the previous character", async () => {
        const service = createRegistrationService({
          context: context("wos", wosCommunity, "primary-user"),
          repository: wosRepository,
        });
        await service.upsert({ playerId: "333331", inGameName: "Main", alliance: "PRI" },
          "primary-main-register-0001", { isPrimary: true });
        await service.upsert({ playerId: "333332", inGameName: "Alt", alliance: "PRI" },
          "primary-alt-register-0001", { isPrimary: false });
        await synchronizeAuthoritativePrimary({
          gameProfile: "wos", discordUserId: "primary-user", playerId: "333332",
          repository: wosRepository,
        });
        const rows = await withProfile(runtimePool, "wos", (client) => client.query(
          `SELECT player_id,is_primary FROM booking_participants
            WHERE community_id=$1 AND discord_user_id='primary-user'
            ORDER BY player_id`, [wosCommunity],
        ));
        assert.deepEqual(rows.rows, [
          { player_id: "333331", is_primary: false },
          { player_id: "333332", is_primary: true },
        ]);
        assert.equal((await withProfile(runtimePool, "kingshot", (client) => client.query(
          "SELECT count(*)::int AS count FROM booking_participants WHERE discord_user_id='primary-user'",
        ))).rows[0].count, 0);
      });

      await t.test("mirror reconciliation creates without booking, reward, event, notification, or topology side effects", async () => {
        const secondCommunity = randomUUID();
        await withProfile(runtimePool, "wos", (client) => client.query(
          `INSERT INTO booking_communities
             (game_profile,id,location_code,display_name)
           VALUES ('wos',$1,'1002','State 1002')`, [secondCommunity],
        ));
        for (const communityId of [wosCommunity, secondCommunity]) {
          await createRegistrationService({
            context: context("wos", communityId, "4444444"), repository: wosRepository,
          }).upsert({ playerId: "444441", inGameName: "Old Main", alliance: "OLD" },
          `reconcile-existing-${communityId}`, { isPrimary: false });
        }
        const sideEffectCounts = () => withProfile(runtimePool, "wos", async (client) => {
          const tables = ["minister_bookings", "player_points_ledger", "community_points_ledger",
            "booking_change_events", "booking_outbox", "booking_discord_notifications",
            "booking_discord_guilds"];
          const result = {};
          for (const table of tables) {
            result[table] = (await client.query(`SELECT count(*)::int AS count FROM ${table}`))
              .rows[0].count;
          }
          return result;
        });
        const before = await sideEffectCounts();
        const accounts = [
          { discordUserId: "4444444", playerId: "444441", inGameName: "Main",
            allianceAbbreviation: "PRI", communityCode: "1001", isPrimary: true },
          { discordUserId: "4444444", playerId: "444442", inGameName: "Alt",
            allianceAbbreviation: "ALT", communityCode: "1001", isPrimary: false },
        ];
        const dryRun = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos",
          accounts, dryRun: true, repository: wosRepository });
        assert.equal(dryRun.mutations, 0);
        assert.equal(dryRun.plannedCreates, 1);
        assert.deepEqual(await sideEffectCounts(), before);
        const executed = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos",
          accounts, dryRun: false, repository: wosRepository });
        assert.ok(executed.mutations > 0);
        const repeated = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos",
          accounts, dryRun: false, repository: wosRepository });
        assert.equal(repeated.mutations, 0);
        assert.deepEqual(await sideEffectCounts(), before);
        const rows = await withProfile(runtimePool, "wos", (client) => client.query(
          `SELECT community.location_code,participant.player_id,participant.in_game_name,
                  participant.alliance,participant.is_primary
             FROM booking_participants AS participant
             JOIN booking_communities AS community
               ON community.game_profile=participant.game_profile
              AND community.id=participant.community_id
            WHERE participant.discord_user_id='4444444'
            ORDER BY participant.player_id,community.location_code`,
        ));
        assert.deepEqual(rows.rows, [
          { location_code: "1001", player_id: "444441", in_game_name: "Main",
            alliance: "PRI", is_primary: true },
          { location_code: "1002", player_id: "444441", in_game_name: "Main",
            alliance: "PRI", is_primary: true },
          { location_code: "1001", player_id: "444442", in_game_name: "Alt",
            alliance: "ALT", is_primary: false },
        ]);
        assert.equal((await withProfile(runtimePool, "kingshot", (client) => client.query(
          "SELECT count(*)::int AS count FROM booking_participants WHERE discord_user_id='4444444'",
        ))).rows[0].count, 0);
      });

      await t.test("ownership and player IDs are community/profile safe", async () => {
        const otherWos = createRegistrationService({
          context: context("wos", wosCommunity, "other-wos-user"),
          repository: wosRepository,
        });
        const kingshot = createRegistrationService({
          context: context("kingshot", kingshotCommunity, "kingshot-user"),
          repository: kingshotRepository,
        });
        await otherWos.upsert(
          { playerId: "654321", inGameName: "Other WOS", alliance: "ABC" },
          "registration-update-0001",
        );
        await kingshot.upsert(
          { playerId: "654321", inGameName: "Kingshot", alliance: "ABC" },
          "registration-update-0001",
        );

        const wosRows = await withProfile(runtimePool, "wos", (client) =>
          client.query(
            `SELECT discord_user_id, player_id
             FROM booking_participants
             WHERE discord_user_id <> '4444444'
             ORDER BY discord_user_id,player_id`,
          ),
        );
        assert.deepEqual(wosRows.rows, [
          { discord_user_id: "concurrent-user", player_id: "222222" },
          { discord_user_id: "other-wos-user", player_id: "654321" },
          { discord_user_id: "primary-user", player_id: "333331" },
          { discord_user_id: "primary-user", player_id: "333332" },
          { discord_user_id: "wos-user", player_id: "123456" },
        ]);
        const kingshotRows = await withProfile(
          runtimePool,
          "kingshot",
          (client) =>
            client.query(
              "SELECT discord_user_id, player_id FROM booking_participants",
            ),
        );
        assert.deepEqual(kingshotRows.rows, [
          { discord_user_id: "kingshot-user", player_id: "654321" },
        ]);
      });

      await t.test("audit failure rolls participant and idempotency back", async () => {
        await migrationPool.query(
          `CREATE FUNCTION fail_rollback_user_audit() RETURNS trigger
           LANGUAGE plpgsql AS $$
           BEGIN
             IF NEW.actor_id = 'rollback-user' THEN
               RAISE EXCEPTION 'forced audit failure';
             END IF;
             RETURN NEW;
           END;
           $$`,
        );
        await migrationPool.query(
          `CREATE TRIGGER fail_rollback_user_audit_trigger
           BEFORE INSERT ON booking_change_events
           FOR EACH ROW EXECUTE FUNCTION fail_rollback_user_audit()`,
        );
        const rollbackService = createRegistrationService({
          context: context("wos", wosCommunity, "rollback-user"),
          repository: wosRepository,
        });
        await assert.rejects(
          rollbackService.upsert(
            { playerId: "777", inGameName: "Rollback", alliance: "RBK" },
            "rollback-register-0001",
          ),
          /forced audit failure/,
        );
        const counts = await withProfile(runtimePool, "wos", async (client) => ({
          participants: await client.query(
            `SELECT count(*)::int AS count FROM booking_participants
             WHERE discord_user_id = 'rollback-user'`,
          ),
          idempotency: await client.query(
            `SELECT count(*)::int AS count FROM booking_idempotency_keys
             WHERE operation <> 'player_mirror_reconciliation'
               AND correlation_id NOT IN (
               SELECT correlation_id FROM booking_change_events
             )`,
          ),
        }));
        assert.equal(counts.participants.rows[0].count, 0);
        assert.equal(counts.idempotency.rows[0].count, 0);
      });
    } finally {
      await runtimePool?.end();
      await migrationPool.end();
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
      await adminPool.end();
    }
  },
);
