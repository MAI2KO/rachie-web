import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import {
  BookingWindowOperatorError,
  formatBookingWindowResult,
  parseBookingWindowArguments,
  setCommunityBookingState,
} from "../server/bootstrap/booking-window-operator.mjs";
import {
  runBookingCommunityBootstrap,
  validateBookingBootstrapConfig,
} from "../server/bootstrap/booking-community-bootstrap.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();

function configuration(profile) {
  return validateBookingBootstrapConfig({
    schemaVersion: 1,
    profile,
    community: {
      code: "9999",
      displayName: profile === "wos" ? "WOS staging 9999" : "Kingshot staging 9999",
      discordGuild: { id: "999999999999999999", displayName: "Shared staging guild" },
    },
    booking: { enabled: true, open: false },
    timeZone: "Europe/London",
    services: [
      { code: "construction", bookingDate: "2026-09-01", requirements: ["fc"], slots: [{ displayTimeLabel: "09:00", localStartTime: "09:00" }] },
      { code: "research", bookingDate: "2026-09-02", requirements: ["shards"], slots: [{ displayTimeLabel: "10:00", localStartTime: "10:00" }] },
      { code: "troop", bookingDate: "2026-09-03", requirements: ["speedups"], slots: [{ displayTimeLabel: "11:00", localStartTime: "11:00" }] },
    ],
  });
}

async function withProfile(pool, profile, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile',$1,true)", [profile]);
    const result = await work(client);
    await client.query("ROLLBACK");
    return result;
  } finally {
    client.release();
  }
}

async function state(pool, profile) {
  return withProfile(pool, profile, async (client) => (await client.query(
    `SELECT c.bookings_open,w.status,c.version AS community_version,w.version AS window_version,
            c.updated_at AS community_updated_at,w.updated_at AS window_updated_at
     FROM booking_communities c
     JOIN booking_windows w ON w.game_profile=c.game_profile AND w.community_id=c.id
     WHERE c.game_profile=$1 AND c.location_code='9999'`,
    [profile],
  )).rows[0]);
}

async function unrelatedSnapshot(pool) {
  const result = await pool.query(
    `SELECT
       (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY game_profile,discord_guild_id)
        FROM booking_discord_guilds row_data) AS guilds,
       (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY game_profile,community_id)
        FROM booking_settings row_data) AS settings,
       (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY game_profile,service_code)
        FROM minister_services row_data) AS services,
       (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY game_profile,id)
        FROM booking_service_dates row_data) AS service_dates,
       (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY game_profile,id)
        FROM appointment_slots row_data) AS slots,
       (SELECT count(*)::int FROM booking_participants) AS registrations,
       (SELECT count(*)::int FROM minister_bookings) AS bookings`,
  );
  return result.rows[0];
}

test("booking-window arguments require profile, community, and exactly one state", () => {
  assert.deepEqual(
    parseBookingWindowArguments(["--profile", "wos", "--community", "9999", "--open"]),
    { profile: "wos", communityCode: "9999", open: true },
  );
  assert.deepEqual(
    parseBookingWindowArguments(["--profile", "kingshot", "--community", "9999", "--close"]),
    { profile: "kingshot", communityCode: "9999", open: false },
  );
  for (const argv of [
    [],
    ["--profile", "invalid", "--community", "9999", "--open"],
    ["--profile", "wos", "--community", "9999"],
    ["--profile", "wos", "--community", "9999", "--open", "--close"],
    ["--profile", "wos", "--community", "bad code", "--open"],
  ]) {
    assert.throws(() => parseBookingWindowArguments(argv), (error) =>
      error instanceof BookingWindowOperatorError && error.code === "invalid_arguments");
  }
});

test("booking-window result formatting is concise and does not expose secrets", () => {
  assert.equal(formatBookingWindowResult({ profile: "wos", communityCode: "9999", previousState: "closed", desiredState: "open", changed: true }),
    "Profile: wos\nCommunity: 9999\nBooking state: closed -> open\nResult: updated\n");
  assert.equal(formatBookingWindowResult({ profile: "wos", communityCode: "9999", previousState: "open", desiredState: "open", changed: false }),
    "Profile: wos\nCommunity: 9999\nBooking state: already open\nResult: no change\n");
});

test("booking-window PostgreSQL integration", { skip: !testDatabaseUrl && "TEST_DATABASE_URL is not configured" }, async (t) => {
  const schema = `booking_window_test_${randomUUID().replaceAll("-", "")}`;
  const runtimeRole = `booking_window_runtime_${randomUUID().replaceAll("-", "")}`;
  const runtimePassword = `pw_${randomUUID()}`;
  const adminPool = new pg.Pool({ connectionString: testDatabaseUrl });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const operatorPool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
  let runtimePool;

  try {
    const migrations = await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url)));
    await runMigrations(operatorPool, migrations);
    await runBookingCommunityBootstrap({ pool: operatorPool, config: configuration("wos") });
    await runBookingCommunityBootstrap({ pool: operatorPool, config: configuration("kingshot") });

    await adminPool.query(
      `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await adminPool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
    await adminPool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${runtimeRole}`);
    const runtimeUrl = new URL(testDatabaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtimePool = new pg.Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${schema}` });

    const unrelatedBefore = await unrelatedSnapshot(operatorPool);

    await t.test("opens and closes WOS idempotently while the same Kingshot code stays isolated", async () => {
      const opened = await setCommunityBookingState({ pool: operatorPool, profile: "wos", communityCode: "9999", open: true });
      assert.deepEqual(opened, { profile: "wos", communityCode: "9999", previousState: "closed", desiredState: "open", changed: true });
      const wosOpenState = await state(operatorPool, "wos");
      assert.equal(wosOpenState.bookings_open, true);
      assert.equal(wosOpenState.status, "open");
      assert.equal(wosOpenState.community_version, 2);
      assert.equal(wosOpenState.window_version, 2);
      assert.equal((await state(operatorPool, "kingshot")).bookings_open, false);
      assert.equal((await state(operatorPool, "kingshot")).status, "closed");

      const beforeRepeat = await state(operatorPool, "wos");
      const repeatOpen = await setCommunityBookingState({ pool: operatorPool, profile: "wos", communityCode: "9999", open: true });
      assert.equal(repeatOpen.changed, false);
      assert.deepEqual(await state(operatorPool, "wos"), beforeRepeat);

      const closed = await setCommunityBookingState({ pool: operatorPool, profile: "wos", communityCode: "9999", open: false });
      assert.deepEqual(closed, { profile: "wos", communityCode: "9999", previousState: "open", desiredState: "closed", changed: true });
      const beforeCloseRepeat = await state(operatorPool, "wos");
      const repeatClose = await setCommunityBookingState({ pool: operatorPool, profile: "wos", communityCode: "9999", open: false });
      assert.equal(repeatClose.changed, false);
      assert.deepEqual(await state(operatorPool, "wos"), beforeCloseRepeat);
    });

    await t.test("opens and closes Kingshot equivalently", async () => {
      const opened = await setCommunityBookingState({ pool: operatorPool, profile: "kingshot", communityCode: "9999", open: true });
      assert.equal(opened.previousState, "closed");
      assert.equal((await state(operatorPool, "kingshot")).status, "open");
      const closed = await setCommunityBookingState({ pool: operatorPool, profile: "kingshot", communityCode: "9999", open: false });
      assert.equal(closed.previousState, "open");
      assert.equal((await state(operatorPool, "kingshot")).status, "closed");
    });

    await t.test("unknown communities are rejected", async () => {
      await assert.rejects(
        setCommunityBookingState({ pool: operatorPool, profile: "wos", communityCode: "missing", open: true }),
        (error) => error instanceof BookingWindowOperatorError && error.code === "unknown_community",
      );
    });

    await t.test("the runtime role is refused", async () => {
      await assert.rejects(
        setCommunityBookingState({ pool: runtimePool, profile: "wos", communityCode: "9999", open: true }),
        (error) => error instanceof BookingWindowOperatorError && error.code === "insufficient_role",
      );
    });

    await t.test("a failure between the two state updates rolls the transaction back", async () => {
      await assert.rejects(
        setCommunityBookingState({
          pool: operatorPool,
          profile: "wos",
          communityCode: "9999",
          open: true,
          injectFailureAfterCommunityUpdate: true,
        }),
        /Injected booking-window failure/,
      );
      assert.equal((await state(operatorPool, "wos")).bookings_open, false);
      assert.equal((await state(operatorPool, "wos")).status, "closed");
    });

    await t.test("dates, slots, services, guilds, registrations, and bookings are unchanged", async () => {
      assert.deepEqual(await unrelatedSnapshot(operatorPool), unrelatedBefore);
    });
  } finally {
    if (runtimePool) await runtimePool.end();
    await operatorPool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.query(`DROP ROLE ${runtimeRole}`);
    await adminPool.end();
  }
});
