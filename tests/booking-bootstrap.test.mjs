import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import {
  assertBookingBootstrapSafety,
  BookingBootstrapError,
  runBookingCommunityBootstrap,
  validateBookingBootstrapConfig,
} from "../server/bootstrap/booking-community-bootstrap.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();

function configuration(profile, suffix = "001") {
  return {
    schemaVersion: 1,
    profile,
    community: {
      code: `${profile.toUpperCase()}-${suffix}`,
      displayName: `${profile} bootstrap ${suffix}`,
      discordGuild: { id: `${profile === "wos" ? "1" : "2"}2345678901234${suffix}`, displayName: `${profile} guild` },
    },
    booking: { enabled: true, open: false },
    timeZone: "Europe/London",
    services: [
      { code: "construction", bookingDate: "2026-09-01", requirements: ["fc", "speedups"], slots: [
        { displayTimeLabel: "09:00", localStartTime: "09:00" },
        { displayTimeLabel: "09:30", localStartTime: "09:30" },
      ] },
      { code: "research", bookingDate: "2026-09-02", requirements: ["shards"], slots: [
        { displayTimeLabel: "10:00", localStartTime: "10:00" },
      ] },
      { code: "troop", bookingDate: "2026-09-03", requirements: ["speedups"], slots: [
        { displayTimeLabel: "11:00", localStartTime: "11:00" },
      ] },
    ],
  };
}

async function profileQuery(pool, profile, sql, values = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile',$1,true)", [profile]);
    const result = await client.query(sql, values);
    await client.query("ROLLBACK");
    return result;
  } finally {
    client.release();
  }
}

test("bootstrap configuration validation rejects malformed input before database work", () => {
  assert.equal(validateBookingBootstrapConfig(configuration("wos")).profile, "wos");
  for (const mutate of [
    (value) => { value.profile = "unknown"; },
    (value) => { value.community.code = "bad code"; },
    (value) => { value.community.discordGuild.id = "not-a-guild"; },
    (value) => { value.timeZone = "Mars/Olympus"; },
    (value) => { value.services[0].code = "invalid"; },
    (value) => { value.services[0].requirements = ["hours"]; },
    (value) => { value.services[0].slots[0].localStartTime = "9am"; },
    (value) => { value.services[0].slots.push({ ...value.services[0].slots[0] }); },
    (value) => { value.services[1].bookingDate = value.services[0].bookingDate; },
    (value) => { value.services[1] = structuredClone(value.services[0]); },
    (value) => { delete value.community.displayName; },
  ]) {
    const malformed = configuration("wos");
    mutate(malformed);
    assert.throws(() => validateBookingBootstrapConfig(malformed), (error) => error instanceof BookingBootstrapError && error.code === "invalid_config");
  }
});

test("remote bootstrap needs the environment gate and confirmation flag", () => {
  const remote = "postgresql://operator:secret@db.internal.example:5432/app";
  assert.throws(() => assertBookingBootstrapSafety(remote, { confirmRemote: true, environment: {} }), /BOOKING_BOOTSTRAP_ENABLED/);
  assert.throws(() => assertBookingBootstrapSafety(remote, { environment: { BOOKING_BOOTSTRAP_ENABLED: "true" } }), /confirm-remote-bootstrap/);
  assert.deepEqual(assertBookingBootstrapSafety(remote, {
    confirmRemote: true,
    environment: { BOOKING_BOOTSTRAP_ENABLED: "true" },
  }), { remote: true });
  assert.deepEqual(assertBookingBootstrapSafety("postgresql://operator:secret@127.0.0.1:5432/app", {
    environment: { BOOKING_BOOTSTRAP_ENABLED: "true" },
  }), { remote: false });
});

test("booking bootstrap PostgreSQL integration", { skip: !testDatabaseUrl && "TEST_DATABASE_URL is not configured" }, async (t) => {
  const schema = `bootstrap_test_${randomUUID().replaceAll("-", "")}`;
  const restrictedRole = `bootstrap_runtime_${randomUUID().replaceAll("-", "")}`;
  const restrictedPassword = `pw_${randomUUID()}`;
  const adminPool = new pg.Pool({ connectionString: testDatabaseUrl });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const bootstrapPool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
  const migrations = await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url)));
  let restrictedPool;

  try {
    await runMigrations(bootstrapPool, migrations);
    await adminPool.query(
      `CREATE ROLE ${restrictedRole} LOGIN PASSWORD '${restrictedPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await adminPool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${restrictedRole}`);
    await adminPool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${restrictedRole}`);
    const restrictedUrl = new URL(testDatabaseUrl);
    restrictedUrl.username = restrictedRole;
    restrictedUrl.password = restrictedPassword;
    restrictedPool = new pg.Pool({ connectionString: restrictedUrl.toString(), options: `-c search_path=${schema}` });

    await t.test("valid WOS and Kingshot configurations bootstrap with the administrative role", async () => {
      const wos = validateBookingBootstrapConfig(configuration("wos", "101"));
      const kingshot = validateBookingBootstrapConfig(configuration("kingshot", "202"));
      const wosPlan = await runBookingCommunityBootstrap({ pool: bootstrapPool, config: wos });
      const kingshotPlan = await runBookingCommunityBootstrap({ pool: bootstrapPool, config: kingshot });
      assert.equal(wosPlan.community, "create");
      assert.equal(kingshotPlan.community, "create");
      assert.equal(wosPlan.dates.create, 3);
      assert.equal(kingshotPlan.slots.create, 4);
    });

    await t.test("repeat is idempotent", async () => {
      const config = validateBookingBootstrapConfig(configuration("wos", "101"));
      const plan = await runBookingCommunityBootstrap({ pool: bootstrapPool, config });
      assert.equal(plan.community, "existing");
      assert.equal(plan.guildMapping, "existing");
      assert.equal(plan.settings, "existing");
      assert.equal(plan.operations.length, 0);
      assert.deepEqual(plan.dates, { existing: 3, create: 0 });
      assert.deepEqual(plan.slots, { existing: 4, create: 0 });
    });

    await t.test("dry-run plans creates but makes no changes", async () => {
      const config = validateBookingBootstrapConfig(configuration("wos", "303"));
      const plan = await runBookingCommunityBootstrap({ pool: bootstrapPool, config, dryRun: true });
      assert.equal(plan.community, "create");
      const count = await profileQuery(bootstrapPool, config.profile, "SELECT count(*)::int AS count FROM booking_communities WHERE location_code=$1", [config.community.code]);
      assert.equal(count.rows[0].count, 0);
    });

    await t.test("guild conflict is rejected", async () => {
      const input = configuration("wos", "404");
      input.community.discordGuild.id = configuration("wos", "101").community.discordGuild.id;
      const config = validateBookingBootstrapConfig(input);
      await assert.rejects(runBookingCommunityBootstrap({ pool: bootstrapPool, config }), (error) =>
        error instanceof BookingBootstrapError && error.code === "configuration_conflict" && error.details.some((detail) => /different community/.test(detail)));
    });

    await t.test("cross-profile community-code collision is rejected", async () => {
      const input = configuration("kingshot", "505");
      input.community.code = configuration("wos", "101").community.code;
      const config = validateBookingBootstrapConfig(input);
      await assert.rejects(runBookingCommunityBootstrap({ pool: bootstrapPool, config }), (error) =>
        error instanceof BookingBootstrapError && error.details.some((detail) => /another profile/.test(detail)));
    });

    await t.test("safe mutable display, open-state, guild-name, and requirement reconciliation works", async () => {
      const input = configuration("wos", "101");
      input.community.displayName = "Updated public name";
      input.community.discordGuild.displayName = "Updated guild name";
      input.booking.open = true;
      input.services[0].requirements = ["rfc"];
      const config = validateBookingBootstrapConfig(input);
      const plan = await runBookingCommunityBootstrap({ pool: bootstrapPool, config });
      assert.equal(plan.community, "update");
      assert.equal(plan.guildMapping, "update");
      assert.equal(plan.settings, "update");
      const client = await bootstrapPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.game_profile','wos',true)");
        const result = await client.query(
          `SELECT c.display_name,c.bookings_open,g.discord_guild_name,s.construction_fc_required,s.construction_rfc_required
           FROM booking_communities c JOIN booking_discord_guilds g ON g.game_profile=c.game_profile AND g.community_id=c.id
           JOIN booking_settings s ON s.game_profile=c.game_profile AND s.community_id=c.id
           WHERE c.location_code=$1`,
          [config.community.code],
        );
        assert.deepEqual(result.rows[0], {
          display_name: "Updated public name", bookings_open: true, discord_guild_name: "Updated guild name",
          construction_fc_required: false, construction_rfc_required: true,
        });
        await client.query("ROLLBACK");
      } finally { client.release(); }
    });

    await t.test("structural drift is rejected", async () => {
      const input = configuration("wos", "101");
      input.community.displayName = "Updated public name";
      input.community.discordGuild.displayName = "Updated guild name";
      input.booking.open = true;
      input.services[0].requirements = ["rfc"];
      input.services[0].slots[0].displayTimeLabel = "Changed label";
      const config = validateBookingBootstrapConfig(input);
      await assert.rejects(runBookingCommunityBootstrap({ pool: bootstrapPool, config }), (error) =>
        error instanceof BookingBootstrapError && error.details.some((detail) => /Structural drift/.test(detail)));
    });

    await t.test("existing bookings make structural drift explicitly unsafe", async () => {
      const client = await bootstrapPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.game_profile','wos',true)");
        const fixture = (await client.query(
          `SELECT c.id AS community_id,w.id AS window_id,d.id AS date_id,d.service_code,d.booking_date,
                  s.id AS slot_id,s.display_time_label
           FROM booking_communities c JOIN booking_windows w ON w.community_id=c.id AND w.game_profile=c.game_profile
           JOIN booking_service_dates d ON d.window_id=w.id AND d.game_profile=w.game_profile
           JOIN appointment_slots s ON s.service_date_id=d.id AND s.game_profile=d.game_profile
           WHERE c.location_code=$1 ORDER BY d.service_code,s.ordinal LIMIT 1`,
          [configuration("wos", "101").community.code],
        )).rows[0];
        const key = `bootstrap-test-${randomUUID()}`;
        const participantId = randomUUID();
        await client.query(
          `INSERT INTO booking_idempotency_keys
             (game_profile,community_id,idempotency_key,operation,request_hash,correlation_id,status)
           VALUES ('wos',$1,$2,'test',$3,'bootstrap-test','completed')`,
          [fixture.community_id, key, "a".repeat(64)],
        );
        await client.query(
          `INSERT INTO booking_participants
             (game_profile,id,community_id,player_id,in_game_name,alliance,source,idempotency_key,correlation_id)
           VALUES ('wos',$1,$2,'player','Player','Alliance','admin',$3,'bootstrap-test')`,
          [participantId, fixture.community_id, key],
        );
        await client.query(
          `INSERT INTO minister_bookings
             (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,slot_id,
              participant_id,player_id_snapshot,in_game_name_snapshot,alliance_snapshot,display_time_label_snapshot,
              source,actor_type,idempotency_key,correlation_id)
           VALUES ('wos',$1,$2,$3,$4,$5,$6,$7,$8,'player','Player','Alliance',$9,'admin','admin',$10,'bootstrap-test')`,
          [randomUUID(), fixture.community_id, fixture.window_id, fixture.date_id, fixture.service_code,
            fixture.booking_date, fixture.slot_id, participantId, fixture.display_time_label, key],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }

      const input = configuration("wos", "101");
      input.community.displayName = "Updated public name";
      input.community.discordGuild.displayName = "Updated guild name";
      input.booking.open = true;
      input.services[0].requirements = ["rfc"];
      input.services[0].slots[0].displayTimeLabel = "Changed label";
      const config = validateBookingBootstrapConfig(input);
      await assert.rejects(runBookingCommunityBootstrap({ pool: bootstrapPool, config }), (error) =>
        error instanceof BookingBootstrapError && error.details.some((detail) => /existing booking record/.test(detail)));
    });

    await t.test("injected failure rolls back every write", async () => {
      const config = validateBookingBootstrapConfig(configuration("kingshot", "606"));
      await assert.rejects(runBookingCommunityBootstrap({ pool: bootstrapPool, config, injectFailureAfter: 2 }), /Injected bootstrap failure/);
      const count = await profileQuery(bootstrapPool, config.profile, "SELECT count(*)::int AS count FROM booking_communities WHERE location_code=$1", [config.community.code]);
      assert.equal(count.rows[0].count, 0);
    });

    await t.test("restricted runtime role cannot bootstrap", async () => {
      const config = validateBookingBootstrapConfig(configuration("wos", "707"));
      await assert.rejects(runBookingCommunityBootstrap({ pool: restrictedPool, config }), (error) =>
        error instanceof BookingBootstrapError && error.code === "insufficient_role");
    });
  } finally {
    if (restrictedPool) await restrictedPool.end();
    await bootstrapPool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.query(`DROP ROLE ${restrictedRole}`);
    await adminPool.end();
  }
});
