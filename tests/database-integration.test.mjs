import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import {
  loadMigrations,
  runMigrations,
} from "../server/database/migrations.mjs";
import {
  configurePostgresTypeParsers,
} from "../server/database/postgres-types.mjs";
import {
  createProfileScopedBookingRepository,
} from "../server/native-booking/repository-core.mjs";
import {
  createNativeBookingReadService,
  NativeBookingCommunityNotFoundError,
  NativeBookingServiceNotFoundError,
} from "../server/native-booking/read-service-core.mjs";
import { createRegistrationService } from "../server/native-booking/registration-service-core.mjs";

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();

configurePostgresTypeParsers(pg.types);

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

test(
  "native booking PostgreSQL constraints",
  { skip: !testDatabaseUrl && "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const schema = `booking_test_${randomUUID().replaceAll("-", "")}`;
    const runtimeRole = `booking_runtime_${randomUUID().replaceAll("-", "")}`;
    const runtimePassword = `test_${randomUUID()}`;
    const adminPool = new pg.Pool({ connectionString: testDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const migrationPool = new pg.Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schema}`,
    });
    let runtimePool;
    const migrations = await loadMigrations(
      fileURLToPath(new URL("../db/migrations/", import.meta.url)),
    );

    try {
      await t.test("concurrent migrations apply exactly once", async () => {
        const results = await Promise.all([
          runMigrations(migrationPool, migrations),
          runMigrations(migrationPool, migrations),
        ]);
        assert.equal(
          results.flatMap((result) => result.applied).filter((v) => v === "0001")
            .length,
          1,
        );
        assert.deepEqual(
          (await runMigrations(migrationPool, migrations)).applied,
          [],
        );
        await assert.rejects(
          runMigrations(migrationPool, [
            { ...migrations[0], checksum: "0".repeat(64) },
            ...migrations.slice(1),
          ]),
          /has been modified/,
        );
      });

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
      const runtimeDatabaseUrl = new URL(testDatabaseUrl);
      runtimeDatabaseUrl.username = runtimeRole;
      runtimeDatabaseUrl.password = runtimePassword;
      runtimePool = new pg.Pool({
        connectionString: runtimeDatabaseUrl.toString(),
        options: `-c search_path=${schema}`,
      });

      await t.test("runtime role is non-superuser without BYPASSRLS", async () => {
        const result = await runtimePool.query(
          `SELECT rolsuper, rolbypassrls
           FROM pg_roles
           WHERE rolname = current_user`,
        );
        assert.deepEqual(result.rows, [
          { rolsuper: false, rolbypassrls: false },
        ]);
      });

      await t.test("migration created all native booking tables", async () => {
        const result = await migrationPool.query(
          `SELECT table_name
           FROM information_schema.tables
           WHERE table_schema = $1 AND table_type = 'BASE TABLE'
           ORDER BY table_name`,
          [schema],
        );
        assert.deepEqual(
          result.rows.map((row) => row.table_name),
          [
            "app_schema_migrations",
            "appointment_slots",
            "booking_approval_discord_messages",
            "booking_approval_events",
            "booking_approval_request_answers",
            "booking_approval_requests",
            "booking_change_events",
            "booking_communities",
            "booking_discord_guilds",
            "booking_discord_notifications",
            "booking_guest_share_links",
            "booking_idempotency_keys",
            "booking_integration_nonces",
            "booking_outbox",
            "booking_participants",
            "booking_requirement_answers",
            "booking_service_dates",
            "booking_settings",
            "booking_slot_blocks",
            "booking_windows",
            "minister_bookings",
            "minister_services",
            "website_auth_session_communities",
            "website_auth_session_selection",
            "website_auth_sessions",
            "website_discord_identities",
            "website_oauth_states",
            "website_rate_limit_buckets",
          ],
        );
      });

      const wosCommunity = randomUUID();
      const wosCommunityTwo = randomUUID();
      const kingshotCommunity = randomUUID();

      await withProfile(runtimePool, "wos", (client) =>
        client.query(
          `INSERT INTO booking_communities
             (game_profile, id, location_code, display_name)
           VALUES
             ('wos', $1, '1001', 'WOS test'),
             ('wos', $2, '1002', 'WOS test two')`,
          [wosCommunity, wosCommunityTwo],
        ),
      );
      await withProfile(runtimePool, "kingshot", (client) =>
        client.query(
          `INSERT INTO booking_communities
             (game_profile, id, location_code, display_name)
           VALUES ('kingshot', $1, '2002', 'Kingshot test')`,
          [kingshotCommunity],
        ),
      );

      await t.test("profile repositories cannot read the other profile", async () => {
        const wosRepository = createProfileScopedBookingRepository(
          "wos",
          runtimePool,
        );
        const kingshotRepository = createProfileScopedBookingRepository(
          "kingshot",
          runtimePool,
        );

        assert.equal((await wosRepository.findCommunityById(wosCommunity)).game_profile, "wos");
        assert.equal(await wosRepository.findCommunityById(kingshotCommunity), null);
        assert.equal(
          (await kingshotRepository.findCommunityById(kingshotCommunity)).game_profile,
          "kingshot",
        );
        assert.equal(await kingshotRepository.findCommunityById(wosCommunity), null);
      });

      await t.test("runtime RLS blocks cross-profile reads, updates, and deletes", async () => {
        const wosRows = await withProfile(runtimePool, "wos", (client) =>
          client.query(
            "SELECT game_profile, id FROM booking_communities ORDER BY id",
          ),
        );
        assert.equal(wosRows.rowCount, 2);
        assert.ok(wosRows.rows.every((row) => row.game_profile === "wos"));

        const kingshotRows = await withProfile(
          runtimePool,
          "kingshot",
          (client) =>
            client.query(
              "SELECT game_profile, id FROM booking_communities ORDER BY id",
            ),
        );
        assert.deepEqual(kingshotRows.rows, [
          { game_profile: "kingshot", id: kingshotCommunity },
        ]);

        const wosAgainstKingshot = await withProfile(
          runtimePool,
          "wos",
          async (client) => ({
            update: await client.query(
              `UPDATE booking_communities
               SET display_name = 'cross-profile update'
               WHERE id = $1`,
              [kingshotCommunity],
            ),
            delete: await client.query(
              "DELETE FROM booking_communities WHERE id = $1",
              [kingshotCommunity],
            ),
          }),
        );
        assert.equal(wosAgainstKingshot.update.rowCount, 0);
        assert.equal(wosAgainstKingshot.delete.rowCount, 0);

        const kingshotAgainstWos = await withProfile(
          runtimePool,
          "kingshot",
          async (client) => ({
            update: await client.query(
              `UPDATE booking_communities
               SET display_name = 'cross-profile update'
               WHERE id = $1`,
              [wosCommunity],
            ),
            delete: await client.query(
              "DELETE FROM booking_communities WHERE id = $1",
              [wosCommunity],
            ),
          }),
        );
        assert.equal(kingshotAgainstWos.update.rowCount, 0);
        assert.equal(kingshotAgainstWos.delete.rowCount, 0);

        await assert.rejects(
          withProfile(runtimePool, "wos", (client) =>
            client.query(
              `UPDATE booking_communities
               SET game_profile = 'kingshot'
               WHERE id = $1`,
              [wosCommunityTwo],
            ),
          ),
          /row-level security/i,
        );
        await assert.rejects(
          withProfile(runtimePool, "kingshot", (client) =>
            client.query(
              `INSERT INTO booking_communities
                 (game_profile, id, location_code, display_name)
               VALUES ('wos', $1, 'invalid-profile', 'Invalid')`,
              [randomUUID()],
            ),
          ),
          /row-level security/i,
        );

        const ownerRows = await migrationPool.query(
          `SELECT game_profile, display_name
           FROM booking_communities
           WHERE id IN ($1, $2)
           ORDER BY game_profile`,
          [wosCommunity, kingshotCommunity],
        );
        assert.deepEqual(ownerRows.rows, [
          { game_profile: "kingshot", display_name: "Kingshot test" },
          { game_profile: "wos", display_name: "WOS test" },
        ]);
      });

      await t.test("composite foreign keys reject both cross-profile directions", async () => {
        await assert.rejects(
          withProfile(runtimePool, "wos", (client) =>
            client.query(
              `INSERT INTO booking_discord_guilds
                 (game_profile, discord_guild_id, community_id, discord_guild_name)
               VALUES ('wos', 'guild-cross-profile', $1, 'Invalid')`,
              [kingshotCommunity],
            ),
          ),
          /foreign key|violates row-level security/i,
        );
        await assert.rejects(
          withProfile(runtimePool, "kingshot", (client) =>
            client.query(
              `INSERT INTO booking_discord_guilds
                 (game_profile, discord_guild_id, community_id, discord_guild_name)
               VALUES ('kingshot', 'guild-cross-profile-reverse', $1, 'Invalid')`,
              [wosCommunity],
            ),
          ),
          /foreign key|violates row-level security/i,
        );
      });

      await t.test("transactions roll back atomically", async () => {
        const rolledBackCommunity = randomUUID();
        await assert.rejects(
          withProfile(runtimePool, "wos", async (client) => {
            await client.query(
              `INSERT INTO booking_communities
                 (game_profile, id, location_code, display_name)
               VALUES ('wos', $1, 'rollback', 'Rollback')`,
              [rolledBackCommunity],
            );
            throw new Error("force rollback");
          }),
          /force rollback/,
        );
        const repository = createProfileScopedBookingRepository(
          "wos",
          runtimePool,
        );
        assert.equal(await repository.findCommunityById(rolledBackCommunity), null);
      });

      await t.test("idempotency keys and participant identities are constrained", async () => {
        const key = "registration-one";
        await withProfile(runtimePool, "wos", async (client) => {
          await client.query(
            `INSERT INTO booking_idempotency_keys
               (game_profile, community_id, idempotency_key, operation,
                request_hash, correlation_id)
             VALUES ('wos', $1, $2, 'register', $3, 'correlation-one')`,
            [wosCommunity, key, "a".repeat(64)],
          );
          await client.query(
            `INSERT INTO booking_participants
               (game_profile, id, community_id, player_id, in_game_name,
                alliance, source, idempotency_key, correlation_id)
             VALUES ('wos', $1, $2, 'shared-player', 'Manual', 'TAG',
                     'manual', $3, 'correlation-one')`,
            [randomUUID(), wosCommunity, key],
          );
        });

        await assert.rejects(
          withProfile(runtimePool, "wos", (client) =>
            client.query(
              `INSERT INTO booking_idempotency_keys
                 (game_profile, community_id, idempotency_key, operation,
                  request_hash, correlation_id)
               VALUES ('wos', $1, $2, 'different', $3, 'correlation-two')`,
              [wosCommunity, key, "b".repeat(64)],
            ),
          ),
          /duplicate key/i,
        );

        await assert.rejects(
          withProfile(runtimePool, "wos", (client) =>
            client.query(
              `INSERT INTO booking_participants
                 (game_profile, id, community_id, player_id, in_game_name,
                  alliance, source, idempotency_key, correlation_id)
               VALUES ('wos', $1, $2, 'player-two', 'Discordless', 'TAG',
                       'discord', $3, 'correlation-one')`,
              [randomUUID(), wosCommunity, key],
            ),
          ),
          /check constraint/i,
        );
      });

      await t.test("Discord registration is community-unique while player IDs are not global", async () => {
        await withProfile(runtimePool, "wos", async (client) => {
          for (const [communityId, key] of [
            [wosCommunity, "discord-registration-one"],
            [wosCommunity, "discord-registration-duplicate"],
            [wosCommunityTwo, "discord-registration-other-community"],
          ]) {
            await client.query(
              `INSERT INTO booking_idempotency_keys
                 (game_profile, community_id, idempotency_key, operation,
                  request_hash, correlation_id)
               VALUES ('wos', $1, $2, 'register', $3, $4)`,
              [communityId, key, "d".repeat(64), `correlation-${key}`],
            );
          }

          await client.query(
            `INSERT INTO booking_participants
               (game_profile, id, community_id, discord_user_id, player_id,
                in_game_name, alliance, source, idempotency_key, correlation_id)
             VALUES ('wos', $1, $2, 'discord-user-one', 'discord-player',
                     'Discord Player', 'TAG', 'discord',
                     'discord-registration-one', 'discord-one')`,
            [randomUUID(), wosCommunity],
          );
        });

        await assert.rejects(
          withProfile(runtimePool, "wos", (client) =>
            client.query(
              `INSERT INTO booking_participants
                 (game_profile, id, community_id, discord_user_id, player_id,
                  in_game_name, alliance, source, idempotency_key, correlation_id)
               VALUES ('wos', $1, $2, 'discord-user-one', 'different-player',
                       'Duplicate Discord', 'TAG', 'discord',
                       'discord-registration-duplicate', 'discord-duplicate')`,
              [randomUUID(), wosCommunity],
            ),
          ),
          /duplicate key/i,
        );

        await withProfile(runtimePool, "wos", (client) =>
          client.query(
            `INSERT INTO booking_participants
               (game_profile, id, community_id, discord_user_id, player_id,
                in_game_name, alliance, source, idempotency_key, correlation_id)
             VALUES ('wos', $1, $2, 'discord-user-one', 'shared-player',
                     'Other Community', 'TAG', 'discord',
                     'discord-registration-other-community', 'discord-other')`,
            [randomUUID(), wosCommunityTwo],
          ),
        );

        const repeatedPlayerIds = await withProfile(
          runtimePool,
          "wos",
          (client) =>
            client.query(
              `SELECT community_id
               FROM booking_participants
               WHERE player_id = 'shared-player'
               ORDER BY community_id`,
            ),
        );
        assert.deepEqual(
          new Set(repeatedPlayerIds.rows.map((row) => row.community_id)),
          new Set([wosCommunity, wosCommunityTwo]),
        );
      });

      await t.test("slot, block, booking, reschedule, and time rules are enforced", async () => {
        const windowId = randomUUID();
        const serviceDateId = randomUUID();
        const slotOne = randomUUID();
        const slotTwo = randomUUID();
        const slotThree = randomUUID();
        const participantOne = randomUUID();
        const participantTwo = randomUUID();
        const bookingOne = randomUUID();
        const idempotencyKeys = [
          "participant-slot-one",
          "participant-slot-two",
          "booking-slot-one",
          "booking-slot-conflict",
          "booking-player-conflict",
          "block-slot-two",
          "block-slot-two-conflict",
          "reschedule-replacement",
        ];

        await withProfile(runtimePool, "wos", async (client) => {
          await client.query(
            `INSERT INTO booking_windows
               (game_profile, id, community_id, created_by_actor_type)
             VALUES ('wos', $1, $2, 'system')`,
            [windowId, wosCommunity],
          );
          await client.query(
            `INSERT INTO booking_service_dates
               (game_profile, id, community_id, window_id, service_code, booking_date)
             VALUES ('wos', $1, $2, $3, 'construction', DATE '2026-08-20')`,
            [serviceDateId, wosCommunity, windowId],
          );
          await client.query(
            `INSERT INTO appointment_slots
               (game_profile, id, community_id, window_id, service_date_id,
                service_code, booking_date, ordinal, display_time_label,
                local_start_time, time_zone, starts_at, ends_at)
             VALUES
               ('wos', $1, $3, $4, $5, 'construction', DATE '2026-08-20', 0, '00:00',
                NULL, NULL, NULL, NULL),
               ('wos', $2, $3, $4, $5, 'construction', DATE '2026-08-20', 1, '00:30',
                NULL, NULL, NULL, NULL),
               ('wos', $6, $3, $4, $5, 'construction', DATE '2026-08-20', 2, '09:30',
                TIME '09:30:00', 'Europe/London', TIMESTAMPTZ '2026-08-20 08:30:00+00',
                TIMESTAMPTZ '2026-08-20 09:00:00+00')`,
            [
              slotOne,
              slotTwo,
              wosCommunity,
              windowId,
              serviceDateId,
              slotThree,
            ],
          );

          for (const key of idempotencyKeys) {
            await client.query(
              `INSERT INTO booking_idempotency_keys
                 (game_profile, community_id, idempotency_key, operation,
                  request_hash, correlation_id)
               VALUES ('wos', $1, $2, 'test', $3, $4)`,
              [wosCommunity, key, "c".repeat(64), `correlation-${key}`],
            );
          }

          await client.query(
            `INSERT INTO booking_participants
               (game_profile, id, community_id, player_id, in_game_name,
                alliance, source, idempotency_key, correlation_id)
             VALUES
               ('wos', $1, $3, 'player-one', 'Player One', 'TAG', 'manual',
                'participant-slot-one', 'participant-one'),
               ('wos', $2, $3, 'player-two', 'Player Two', 'TAG', 'manual',
                'participant-slot-two', 'participant-two')`,
            [participantOne, participantTwo, wosCommunity],
          );

          await client.query(
            `INSERT INTO minister_bookings
               (game_profile, id, community_id, window_id, service_date_id,
                service_code, booking_date, slot_id, participant_id,
                player_id_snapshot, in_game_name_snapshot, alliance_snapshot,
                display_time_label_snapshot, source, actor_type,
                idempotency_key, correlation_id)
             VALUES
               ('wos', $1, $2, $3, $4, 'construction', DATE '2026-08-20',
                $5, $6, 'player-one', 'Player One', 'TAG', '00:00',
                'admin', 'admin', 'booking-slot-one', 'booking-one')`,
            [
              bookingOne,
              wosCommunity,
              windowId,
              serviceDateId,
              slotOne,
              participantOne,
            ],
          );
        });

        await assert.rejects(
          withProfile(runtimePool, "wos", (client) =>
            client.query(
              `INSERT INTO appointment_slots
                 (game_profile, id, community_id, window_id, service_date_id,
                  service_code, booking_date, ordinal, display_time_label)
               VALUES ('wos', $1, $2, $3, $4, 'construction',
                       DATE '2026-08-20', 0, 'duplicate ordinal')`,
              [randomUUID(), wosCommunity, windowId, serviceDateId],
            ),
          ),
          /duplicate key/i,
        );

        await assert.rejects(
          withProfile(runtimePool, "wos", (client) =>
            client.query(
              `INSERT INTO minister_bookings
                 (game_profile, id, community_id, window_id, service_date_id,
                  service_code, booking_date, slot_id, participant_id,
                  player_id_snapshot, in_game_name_snapshot, alliance_snapshot,
                  display_time_label_snapshot, source, actor_type,
                  idempotency_key, correlation_id)
               VALUES ('wos', $1, $2, $3, $4, 'construction', DATE '2026-08-20',
                       $5, $6, 'player-two', 'Player Two', 'TAG', '00:00',
                       'admin', 'admin', 'booking-slot-conflict', 'slot-conflict')`,
              [
                randomUUID(),
                wosCommunity,
                windowId,
                serviceDateId,
                slotOne,
                participantTwo,
              ],
            ),
          ),
          /duplicate key/i,
        );

        await assert.rejects(
          withProfile(runtimePool, "wos", (client) =>
            client.query(
              `INSERT INTO minister_bookings
                 (game_profile, id, community_id, window_id, service_date_id,
                  service_code, booking_date, slot_id, participant_id,
                  player_id_snapshot, in_game_name_snapshot, alliance_snapshot,
                  display_time_label_snapshot, source, actor_type,
                  idempotency_key, correlation_id)
               VALUES ('wos', $1, $2, $3, $4, 'construction', DATE '2026-08-20',
                       $5, $6, 'player-one', 'Player One', 'TAG', '00:30',
                       'admin', 'admin', 'booking-player-conflict', 'player-conflict')`,
              [
                randomUUID(),
                wosCommunity,
                windowId,
                serviceDateId,
                slotTwo,
                participantOne,
              ],
            ),
          ),
          /duplicate key/i,
        );

        await withProfile(runtimePool, "wos", (client) =>
          client.query(
            `INSERT INTO booking_slot_blocks
               (game_profile, id, community_id, window_id, slot_id, source,
                actor_type, idempotency_key, correlation_id)
             VALUES ('wos', $1, $2, $3, $4, 'admin', 'admin',
                     'block-slot-two', 'block-one')`,
            [randomUUID(), wosCommunity, windowId, slotTwo],
          ),
        );

        await assert.rejects(
          withProfile(runtimePool, "wos", (client) =>
            client.query(
              `INSERT INTO booking_slot_blocks
                 (game_profile, id, community_id, window_id, slot_id, source,
                  actor_type, idempotency_key, correlation_id)
               VALUES ('wos', $1, $2, $3, $4, 'admin', 'admin',
                       'block-slot-two-conflict', 'block-conflict')`,
              [randomUUID(), wosCommunity, windowId, slotTwo],
            ),
          ),
          /duplicate key/i,
        );

        const replacementBooking = randomUUID();
        await assert.rejects(
          withProfile(runtimePool, "wos", async (client) => {
            await client.query(
              `UPDATE minister_bookings
               SET status = 'replaced', cancelled_at = now(), version = version + 1
               WHERE game_profile = 'wos' AND id = $1`,
              [bookingOne],
            );
            await client.query(
              `INSERT INTO minister_bookings
                 (game_profile, id, community_id, window_id, service_date_id,
                  service_code, booking_date, slot_id, participant_id,
                  player_id_snapshot, in_game_name_snapshot, alliance_snapshot,
                  display_time_label_snapshot, source, actor_type,
                  idempotency_key, correlation_id, rescheduled_from_booking_id)
               VALUES ('wos', $1, $2, $3, $4, 'construction', DATE '2026-08-20',
                       $5, $6, 'player-one', 'Player One', 'TAG', '09:30',
                       'admin', 'admin', 'reschedule-replacement',
                       'reschedule-correlation', $7)`,
              [
                replacementBooking,
                wosCommunity,
                windowId,
                serviceDateId,
                slotThree,
                participantOne,
                bookingOne,
              ],
            );
            throw new Error("force reschedule rollback");
          }),
          /force reschedule rollback/,
        );

        const rescheduleState = await withProfile(
          runtimePool,
          "wos",
          (client) =>
            client.query(
              `SELECT id, status
               FROM minister_bookings
               WHERE id IN ($1, $2)
               ORDER BY id`,
              [bookingOne, replacementBooking],
            ),
        );
        assert.deepEqual(rescheduleState.rows, [
          { id: bookingOne, status: "confirmed" },
        ]);

        const timeRoundTrip = await withProfile(
          runtimePool,
          "wos",
          async (client) => {
            await client.query("SET LOCAL TIME ZONE 'Pacific/Auckland'");
            return client.query(
              `SELECT booking_date, local_start_time, time_zone, starts_at, ends_at
               FROM appointment_slots
               WHERE id = $1`,
              [slotThree],
            );
          },
        );
        assert.equal(timeRoundTrip.rows[0].booking_date, "2026-08-20");
        assert.equal(timeRoundTrip.rows[0].local_start_time, "09:30:00");
        assert.equal(timeRoundTrip.rows[0].time_zone, "Europe/London");
        assert.equal(
          timeRoundTrip.rows[0].starts_at.toISOString(),
          "2026-08-20T08:30:00.000Z",
        );
        assert.equal(
          timeRoundTrip.rows[0].ends_at.toISOString(),
          "2026-08-20T09:00:00.000Z",
        );

        await withProfile(runtimePool, "wos", async (client) => {
          await client.query(
            `UPDATE booking_communities
             SET bookings_open = true
             WHERE id = $1`,
            [wosCommunity],
          );
          await client.query(
            `UPDATE booking_windows
             SET status = 'open', opened_at = now()
             WHERE id = $1`,
            [windowId],
          );
          await client.query(
            `INSERT INTO booking_settings
               (game_profile, community_id, construction_fc_required,
                construction_speedups_required, research_shards_required)
             VALUES ('wos', $1, true, true, true)`,
            [wosCommunity],
          );
          await client.query(
            `UPDATE minister_services
             SET active = false
             WHERE service_code = 'troop'`,
          );
          await client.query(
            `UPDATE booking_participants
             SET discord_user_id = 'trusted-discord-user'
             WHERE id = $1`,
            [participantOne],
          );
          await client.query(
            `UPDATE booking_participants
             SET discord_user_id = 'other-discord-user'
             WHERE id = $1`,
            [participantTwo],
          );
        });

        const wosRepository = createProfileScopedBookingRepository(
          "wos",
          runtimePool,
        );
        const readService = createNativeBookingReadService({
          gameProfile: "wos",
          communityId: wosCommunity,
          repository: wosRepository,
        });
        const publicContext = await readService.getContext();
        assert.equal(publicContext.bookingsOpen, true);
        assert.equal(publicContext.windowState, "open");
        assert.deepEqual(
          publicContext.services.map((service) => service.code),
          ["construction", "research"],
        );
        assert.equal(publicContext.services[0].date, "2026-08-20");
        assert.equal(publicContext.requirements.construction.fcRequired, true);

        const publicAvailability =
          await readService.getAvailability("construction");
        assert.deepEqual(publicAvailability, {
          service: {
            code: "construction",
            displayLabel: "Construction",
          },
          date: "2026-08-20",
          bookingsOpen: true,
          slots: [
            { slotId: slotThree, displayTime: "09:30", ordinal: 2 },
          ],
        });
        assert.doesNotMatch(
          JSON.stringify(publicAvailability),
          /player|participant|discord|alliance/i,
        );
        await assert.rejects(
          readService.getAvailability("troop"),
          NativeBookingServiceNotFoundError,
        );

        const participantBookings =
          await readService.getParticipantBookingsForDiscordUser(
            "trusted-discord-user",
          );
        assert.deepEqual(participantBookings, {
          registration: {
            status: "registered",
            playerId: "player-one",
            inGameName: "Player One",
            alliance: "TAG",
          },
          bookings: [
            {
              bookingId: bookingOne,
              serviceCode: "construction",
              date: "2026-08-20",
              displayTime: "00:00",
              ordinal: 0,
            },
          ],
        });
        assert.doesNotMatch(
          JSON.stringify(participantBookings),
          /other-discord-user|player-two|Player Two/,
        );

        const snapshotBeforeRegistrationUpdate = await withProfile(
          runtimePool,
          "wos",
          (client) =>
            client.query(
              `SELECT player_id_snapshot, in_game_name_snapshot,
                      alliance_snapshot
               FROM minister_bookings
               WHERE id = $1`,
              [bookingOne],
            ),
        );
        const registrationService = createRegistrationService({
          context: {
            gameProfile: "wos",
            community: { id: wosCommunity },
            discordUser: { id: "trusted-discord-user" },
          },
          repository: wosRepository,
        });
        await registrationService.upsert(
          {
            playerId: "987654",
            inGameName: "Updated Player",
            alliance: "NEW",
          },
          "snapshot-update-0001",
        );
        assert.deepEqual(
          await readService.getParticipantBookingsForDiscordUser(
            "trusted-discord-user",
          ),
          {
            registration: {
              status: "registered",
              playerId: "987654",
              inGameName: "Updated Player",
              alliance: "NEW",
            },
            bookings: participantBookings.bookings,
          },
        );
        const snapshotAfterRegistrationUpdate = await withProfile(
          runtimePool,
          "wos",
          (client) =>
            client.query(
              `SELECT player_id_snapshot, in_game_name_snapshot,
                      alliance_snapshot
               FROM minister_bookings
               WHERE id = $1`,
              [bookingOne],
            ),
        );
        assert.deepEqual(
          snapshotAfterRegistrationUpdate.rows,
          snapshotBeforeRegistrationUpdate.rows,
        );
        assert.deepEqual(
          await readService.getParticipantBookingsForDiscordUser(
            "not-registered",
          ),
          { registration: { status: "unregistered" }, bookings: [] },
        );

        const kingshotRepository = createProfileScopedBookingRepository(
          "kingshot",
          runtimePool,
        );
        const crossProfileService = createNativeBookingReadService({
          gameProfile: "kingshot",
          communityId: wosCommunity,
          repository: kingshotRepository,
        });
        await assert.rejects(
          crossProfileService.getContext(),
          NativeBookingCommunityNotFoundError,
        );
        const kingshotService = createNativeBookingReadService({
          gameProfile: "kingshot",
          communityId: kingshotCommunity,
          repository: kingshotRepository,
        });
        const kingshotContext = await kingshotService.getContext();
        assert.equal(kingshotContext.bookingsOpen, false);
        assert.equal(kingshotContext.windowState, "unavailable");

        await withProfile(runtimePool, "wos", (client) =>
          client.query(
            `UPDATE booking_windows
             SET status = 'closed', closed_at = now()
             WHERE id = $1`,
            [windowId],
          ),
        );
        const closedContext = await readService.getContext();
        assert.equal(closedContext.bookingsOpen, false);
        assert.equal(closedContext.windowState, "closed");
        assert.deepEqual(
          (await readService.getAvailability("construction")).slots,
          [],
        );
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
