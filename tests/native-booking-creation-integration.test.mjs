import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { configurePostgresTypeParsers } from "../server/database/postgres-types.mjs";
import { createBookingCreationService, BookingIdempotencyConflictError } from "../server/native-booking/booking-creation-service-core.mjs";
import { createNativeBookingReadService } from "../server/native-booking/read-service-core.mjs";
import { createProfileScopedBookingRepository } from "../server/native-booking/repository-core.mjs";
import { createRegistrationService } from "../server/native-booking/registration-service-core.mjs";

const databaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();
configurePostgresTypeParsers(pg.types);

async function withProfile(pool, profile, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile', $1, true)", [profile]);
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

const context = (profile, communityId, userId) => ({ gameProfile: profile, community: { id: communityId }, discordUser: { id: userId } });

test("native booking creation is atomic under restricted PostgreSQL RLS", { skip: !databaseUrl && "TEST_DATABASE_URL is not configured" }, async (t) => {
  const schema = `booking_create_${randomUUID().replaceAll("-", "")}`;
  const role = `booking_create_role_${randomUUID().replaceAll("-", "")}`;
  const password = `test_${randomUUID()}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const owner = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  let runtime;
  try {
    const migrations = await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url)));
    await runMigrations(owner, migrations);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    const url = new URL(databaseUrl); url.username = role; url.password = password;
    runtime = new pg.Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` });
    assert.deepEqual((await runtime.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows, [{ rolsuper: false, rolbypassrls: false }]);

    const fixtures = {};
    for (const profile of ["wos", "kingshot"]) {
      const communityId = randomUUID();
      const windowId = randomUUID();
      const dateId = randomUUID();
      fixtures[profile] = { communityId, windowId, slots: [] };
      await withProfile(runtime, profile, async (client) => {
        await client.query(`INSERT INTO booking_communities (game_profile,id,location_code,display_name,bookings_open) VALUES ($1,$2,$3,$4,true)`, [profile, communityId, profile === "wos" ? "1001" : "2002", profile === "wos" ? "State 1001" : "Kingdom 2002"]);
        await client.query(`INSERT INTO booking_settings (game_profile,community_id,construction_fc_required,construction_rfc_required,construction_speedups_required,research_shards_required) VALUES ($1,$2,true,true,true,true)`, [profile, communityId]);
        await client.query(`INSERT INTO booking_windows (game_profile,id,community_id,status,opens_at,closes_at,created_by_actor_type) VALUES ($1,$2,$3,'open',now()-interval '1 hour',now()+interval '1 day','system')`, [profile, windowId, communityId]);
        await client.query(`INSERT INTO booking_service_dates (game_profile,id,community_id,window_id,service_code,booking_date) VALUES ($1,$2,$3,$4,'construction','2026-08-20')`, [profile, dateId, communityId, windowId]);
        for (let ordinal = 0; ordinal < 12; ordinal++) {
          const slot = randomUUID(); fixtures[profile].slots.push(slot);
          await client.query(`INSERT INTO appointment_slots (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,ordinal,display_time_label) VALUES ($1,$2,$3,$4,$5,'construction','2026-08-20',$6,$7)`, [profile, slot, communityId, windowId, dateId, ordinal, `${String(ordinal).padStart(2, "0")}:00`]);
        }
      });
    }

    const repositories = Object.fromEntries(["wos", "kingshot"].map((profile) => [profile, createProfileScopedBookingRepository(profile, runtime)]));
    async function register(profile, userId, playerId = userId.replace(/\D/g, "").slice(0, 10) || "123") {
      const service = createRegistrationService({ context: context(profile, fixtures[profile].communityId, userId), repository: repositories[profile] });
      await service.upsert({ playerId, inGameName: `Player ${userId}`, alliance: "ABC" }, `register-${userId}-0001`);
    }
    function bookingService(profile, userId) { return createBookingCreationService({ context: context(profile, fixtures[profile].communityId, userId), repository: repositories[profile] }); }
    const choice = (profile, index, requirements = { fc: 10, rfc: 2, speedups: 7 }) => ({ serviceCode: "construction", slotId: fixtures[profile].slots[index], requirements });

    await t.test("WOS and Kingshot create profile-labelled snapshots, audit, and outbox", async () => {
      await register("wos", "user-101", "101");
      await register("kingshot", "user-201", "201");
      const wos = await bookingService("wos", "user-101").create(choice("wos", 0), "booking-user-101-0001");
      const kingshot = await bookingService("kingshot", "user-201").create(choice("kingshot", 0), "booking-user-201-0001");
      assert.equal(wos.body.booking.requirements[0].label, "Fire Crystals");
      assert.equal(kingshot.body.booking.requirements[0].label, "Truegold");
      assert.deepEqual(wos.body.booking.requirements.find((answer) => answer.code === "speedups"), { code: "speedups", label: "Speed-ups (days)", value: 7, unit: "days" });
      assert.deepEqual(kingshot.body.booking.requirements.find((answer) => answer.code === "speedups"), { code: "speedups", label: "Speed-ups (days)", value: 7, unit: "days" });
      assert.deepEqual(Object.keys(wos.body.booking), ["bookingId", "serviceCode", "serviceLabel", "date", "displayTime", "playerName", "alliance", "requirements", "status"]);
      const rows = await withProfile(runtime, "wos", async (client) => ({
        booking: await client.query("SELECT player_id_snapshot,in_game_name_snapshot,alliance_snapshot FROM minister_bookings WHERE id=$1", [wos.body.booking.bookingId]),
        audit: await client.query("SELECT event_type,source,actor_type FROM booking_change_events WHERE aggregate_id=$1", [wos.body.booking.bookingId]),
        outbox: await client.query("SELECT event_type,status FROM booking_outbox WHERE payload->>'bookingId'=$1", [wos.body.booking.bookingId]),
        speedups: await client.query("SELECT numeric_value::int AS value,unit,display_label FROM booking_requirement_answers WHERE booking_id=$1 AND requirement_code='speedups'", [wos.body.booking.bookingId]),
      }));
      assert.equal(rows.booking.rows[0].player_id_snapshot, "101");
      assert.deepEqual(rows.audit.rows, [{ event_type: "booking_created", source: "website", actor_type: "discord_user" }]);
      assert.deepEqual(rows.outbox.rows, [{ event_type: "booking.created", status: "pending" }]);
      assert.deepEqual(rows.speedups.rows, [{ value: 7, unit: "days", display_label: "Speed-ups (days)" }]);
      assert.equal((await withProfile(runtime, "wos", (client) => client.query("SELECT count(*)::int AS count FROM minister_bookings WHERE id=$1", [kingshot.body.booking.bookingId]))).rows[0].count, 0);
    });

    await t.test("registration, closure, inactive service, block, and occupied slot fail closed", async () => {
      await assert.rejects(bookingService("wos", "unregistered").create(choice("wos", 1), "booking-unregistered-0001"), (e) => e.code === "registration_required");
      await register("wos", "user-102", "102");
      await withProfile(runtime, "wos", (c) => c.query("UPDATE booking_communities SET bookings_open=false WHERE id=$1", [fixtures.wos.communityId]));
      await assert.rejects(bookingService("wos", "user-102").create(choice("wos", 1), "booking-closed-0001"), (e) => e.code === "bookings_closed");
      await withProfile(runtime, "wos", (c) => c.query("UPDATE booking_communities SET bookings_open=true WHERE id=$1", [fixtures.wos.communityId]));
      await withProfile(runtime, "wos", (c) => c.query("UPDATE booking_windows SET status='closed' WHERE id=$1", [fixtures.wos.windowId]));
      await assert.rejects(bookingService("wos", "user-102").create(choice("wos", 1), "booking-window-closed-0001"), (e) => e.code === "booking_window_unavailable");
      await withProfile(runtime, "wos", (c) => c.query("UPDATE booking_windows SET status='open' WHERE id=$1", [fixtures.wos.windowId]));
      await withProfile(runtime, "wos", (c) => c.query("UPDATE minister_services SET active=false WHERE service_code='construction'"));
      await assert.rejects(bookingService("wos", "user-102").create(choice("wos", 1), "booking-inactive-0001"), (e) => e.code === "invalid_service");
      await withProfile(runtime, "wos", (c) => c.query("UPDATE minister_services SET active=true WHERE service_code='construction'"));
      await withProfile(runtime, "wos", async (c) => {
        const key = randomUUID();
        await c.query("INSERT INTO booking_idempotency_keys (game_profile,community_id,idempotency_key,operation,request_hash,correlation_id) VALUES ('wos',$1,$2,'block',$3,$4)", [fixtures.wos.communityId, key, "a".repeat(64), randomUUID()]);
        await c.query("INSERT INTO booking_slot_blocks (game_profile,id,community_id,window_id,slot_id,source,actor_type,idempotency_key,correlation_id) VALUES ('wos',$1,$2,$3,$4,'admin','admin',$5,$6)", [randomUUID(), fixtures.wos.communityId, fixtures.wos.windowId, fixtures.wos.slots[1], key, randomUUID()]);
      });
      await assert.rejects(bookingService("wos", "user-102").create(choice("wos", 1), "booking-blocked-0001"), (e) => e.code === "slot_unavailable");
      await register("wos", "user-103", "103");
      await assert.rejects(bookingService("wos", "user-103").create(choice("wos", 0), "booking-occupied-0001"), (e) => e.code === "slot_unavailable");
    });

    await t.test("slot and participant races have one winner", async () => {
      await register("wos", "user-104", "104"); await register("wos", "user-105", "105");
      const results = await Promise.allSettled([
        bookingService("wos", "user-104").create(choice("wos", 2), "booking-race-104-0001"),
        bookingService("wos", "user-105").create(choice("wos", 2), "booking-race-105-0001"),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.find((r) => r.status === "rejected").reason.code, "slot_unavailable");
      const winner = results.find((r) => r.status === "fulfilled").value;
      const winnerUser = winner.body.booking.playerName.replace("Player ", "");
      await assert.rejects(bookingService("wos", winnerUser).create(choice("wos", 3), `booking-second-${winnerUser}-0001`), (e) => e.code === "booking_already_exists");
    });

    await t.test("idempotency replay and concurrent retry create once; changed request conflicts", async () => {
      await register("wos", "user-106", "106");
      const service = bookingService("wos", "user-106");
      const [a, b] = await Promise.all([service.create(choice("wos", 4), "booking-replay-106-0001"), service.create(choice("wos", 4), "booking-replay-106-0001")]);
      assert.deepEqual(a.body, b.body); assert.equal([a, b].filter((r) => r.replayed).length, 1);
      await assert.rejects(service.create(choice("wos", 5), "booking-replay-106-0001"), BookingIdempotencyConflictError);
    });

    await t.test("snapshots remain immutable and reads update immediately", async () => {
      const read = createNativeBookingReadService({ gameProfile: "wos", communityId: fixtures.wos.communityId, repository: repositories.wos });
      const before = await read.getAvailability("construction");
      await register("wos", "user-107", "107");
      const created = await bookingService("wos", "user-107").create(choice("wos", 6), "booking-read-107-0001");
      const after = await read.getAvailability("construction");
      assert.equal(before.slots.some((s) => s.slotId === fixtures.wos.slots[6]), true);
      assert.equal(after.slots.some((s) => s.slotId === fixtures.wos.slots[6]), false);
      assert.equal((await read.getParticipantBookingsForDiscordUser("user-107")).bookings[0].bookingId, created.body.booking.bookingId);
      await createRegistrationService({ context: context("wos", fixtures.wos.communityId, "user-107"), repository: repositories.wos }).upsert({ playerId: "999", inGameName: "Changed", alliance: "XYZ" }, "register-user-107-0002");
      const snapshot = await withProfile(runtime, "wos", (c) => c.query("SELECT player_id_snapshot,in_game_name_snapshot,alliance_snapshot FROM minister_bookings WHERE id=$1", [created.body.booking.bookingId]));
      assert.deepEqual(snapshot.rows[0], { player_id_snapshot: "107", in_game_name_snapshot: "Player user-107", alliance_snapshot: "ABC" });
    });

    await t.test("outbox failure rolls booking, answers, audit, and idempotency back", async () => {
      await register("wos", "user-108", "108");
      await owner.query(`CREATE FUNCTION fail_booking_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->'participant'->>'inGameName' = 'Player user-108' THEN RAISE EXCEPTION 'forced outbox failure'; END IF; RETURN NEW; END; $$`);
      await owner.query(`CREATE TRIGGER fail_booking_outbox_trigger BEFORE INSERT ON booking_outbox FOR EACH ROW EXECUTE FUNCTION fail_booking_outbox()`);
      await assert.rejects(bookingService("wos", "user-108").create(choice("wos", 7), "booking-rollback-108-0001"), /forced outbox failure/);
      const counts = await withProfile(runtime, "wos", async (c) => ({
        bookings: await c.query("SELECT count(*)::int AS count FROM minister_bookings WHERE discord_user_id='user-108'"),
        keys: await c.query("SELECT count(*)::int AS count FROM booking_idempotency_keys WHERE operation='booking_create' AND status='started'"),
        answers: await c.query("SELECT count(*)::int AS count FROM booking_requirement_answers AS answer JOIN minister_bookings AS booking ON booking.game_profile=answer.game_profile AND booking.id=answer.booking_id WHERE booking.discord_user_id='user-108'"),
        audits: await c.query("SELECT count(*)::int AS count FROM booking_change_events WHERE event_type='booking_created' AND actor_id='user-108'"),
        outbox: await c.query("SELECT count(*)::int AS count FROM booking_outbox WHERE payload->'participant'->>'inGameName'='Player user-108'"),
      }));
      assert.equal(counts.bookings.rows[0].count, 0);
      assert.equal(counts.keys.rows[0].count, 0);
      assert.equal(counts.answers.rows[0].count, 0);
      assert.equal(counts.audits.rows[0].count, 0);
      assert.equal(counts.outbox.rows[0].count, 0);
    });
  } finally {
    await runtime?.end(); await owner.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end();
  }
});
