import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";

import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { configurePostgresTypeParsers } from "../server/database/postgres-types.mjs";
import { createBookingCreationService } from "../server/native-booking/booking-creation-service-core.mjs";
import { createBookingMutationService, BookingMutationIdempotencyConflictError } from "../server/native-booking/booking-mutation-service-core.mjs";
import { createNativeBookingReadService } from "../server/native-booking/read-service-core.mjs";
import { createProfileScopedBookingRepository } from "../server/native-booking/repository-core.mjs";
import { createRegistrationService } from "../server/native-booking/registration-service-core.mjs";

const databaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();
configurePostgresTypeParsers(pg.types);
async function withProfile(pool, profile, work) { const client = await pool.connect(); try { await client.query("BEGIN"); await client.query("SELECT set_config('app.game_profile',$1,true)", [profile]); const result = await work(client); await client.query("COMMIT"); return result; } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } }
const context = (profile, communityId, userId) => ({ gameProfile: profile, community: { id: communityId }, discordUser: { id: userId } });

test("owned booking reschedule and cancellation are atomic under forced RLS", { skip: !databaseUrl && "TEST_DATABASE_URL is not configured" }, async (t) => {
  const schema = `booking_mutate_${randomUUID().replaceAll("-", "")}`;
  const role = `booking_mutate_role_${randomUUID().replaceAll("-", "")}`;
  const password = `test_${randomUUID()}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const owner = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  let runtime;
  try {
    await runMigrations(owner, await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url))));
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    const url = new URL(databaseUrl); url.username = role; url.password = password;
    runtime = new pg.Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` });
    assert.deepEqual((await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows, [{ rolsuper: false, rolbypassrls: false }]);

    const fixtures = {};
    for (const profile of ["wos", "kingshot"]) {
      const communityId = randomUUID(), windowId = randomUUID(), dateId = randomUUID();
      fixtures[profile] = { communityId, windowId, slots: [] };
      await withProfile(runtime, profile, async (c) => {
        await c.query("INSERT INTO booking_communities (game_profile,id,location_code,display_name,bookings_open) VALUES ($1,$2,$3,$4,true)", [profile, communityId, profile === "wos" ? "1001" : "2002", profile]);
        await c.query("INSERT INTO booking_settings (game_profile,community_id,construction_fc_required,construction_speedups_required) VALUES ($1,$2,true,true)", [profile, communityId]);
        await c.query("INSERT INTO booking_windows (game_profile,id,community_id,status,opens_at,closes_at,created_by_actor_type) VALUES ($1,$2,$3,'open',now()-interval '1 hour',now()+interval '1 day','system')", [profile, windowId, communityId]);
        await c.query("INSERT INTO booking_service_dates (game_profile,id,community_id,window_id,service_code,booking_date) VALUES ($1,$2,$3,$4,'construction','2026-08-21')", [profile, dateId, communityId, windowId]);
        for (let i = 0; i < 18; i++) { const slot = randomUUID(); fixtures[profile].slots.push(slot); await c.query("INSERT INTO appointment_slots (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,ordinal,display_time_label) VALUES ($1,$2,$3,$4,$5,'construction','2026-08-21',$6,$7)", [profile, slot, communityId, windowId, dateId, i, `${i}:00`]); }
      });
    }
    const repos = Object.fromEntries(["wos", "kingshot"].map((p) => [p, createProfileScopedBookingRepository(p, runtime)]));
    async function register(profile, user) { await createRegistrationService({ context: context(profile, fixtures[profile].communityId, user), repository: repos[profile] }).upsert({ playerId: user.replace(/\D/g, "") || "1", inGameName: user, alliance: "ABC" }, `register-${user}-0001`); }
    async function create(profile, user, slotIndex, key = `create-${user}-0001`) { await register(profile, user); return createBookingCreationService({ context: context(profile, fixtures[profile].communityId, user), repository: repos[profile] }).create({ serviceCode: "construction", slotId: fixtures[profile].slots[slotIndex], requirements: { fc: 10, speedups: 7 } }, key); }
    const mutate = (profile, user) => createBookingMutationService({ context: context(profile, fixtures[profile].communityId, user), repository: repos[profile] });
    const patch = (profile, index, fc = 10, speedups = 7) => ({ slotId: fixtures[profile].slots[index], requirements: { fc, speedups } });

    await t.test("WOS and Kingshot preserve immutable lineage and current requirements", async () => {
      for (const [profile, user, from, to] of [["wos", "wos-11", 0, 1], ["kingshot", "king-21", 0, 1]]) {
        const original = await create(profile, user, from);
        const result = await mutate(profile, user).reschedule(original.body.booking.bookingId, patch(profile, to, 12, 14), `move-${user}-0001`);
        assert.equal(result.body.outcome, "rescheduled");
        assert.equal(result.body.booking.requirements[0].label, profile === "wos" ? "Fire Crystals" : "Truegold");
        assert.deepEqual(result.body.booking.requirements.find((answer) => answer.code === "speedups"), { code: "speedups", label: "Speed-ups (days)", value: 14, unit: "days" });
        const rows = await withProfile(runtime, profile, (c) => c.query("SELECT id,status,slot_id,rescheduled_from_booking_id,player_id_snapshot FROM minister_bookings WHERE id=$1 OR id=$2 ORDER BY status", [original.body.booking.bookingId, result.body.booking.bookingId]));
        assert.equal(rows.rowCount, 2);
        assert.equal(rows.rows.find((r) => r.id === original.body.booking.bookingId).status, "replaced");
        assert.equal(rows.rows.find((r) => r.id === result.body.booking.bookingId).rescheduled_from_booking_id, original.body.booking.bookingId);
        if (profile === "wos") {
          const read = createNativeBookingReadService({ gameProfile: profile, communityId: fixtures[profile].communityId, repository: repos[profile] });
          const availability = await read.getAvailability("construction");
          assert.equal(availability.slots.some((slot) => slot.slotId === fixtures[profile].slots[from]), true);
          assert.equal(availability.slots.some((slot) => slot.slotId === fixtures[profile].slots[to]), false);
          assert.deepEqual((await read.getParticipantBookingsForDiscordUser(user)).bookings.map((booking) => booking.bookingId), [result.body.booking.bookingId]);
        }
      }
    });

    await t.test("same-slot unchanged is a no-op without history", async () => {
      const original = await create("wos", "wos-12", 2);
      const result = await mutate("wos", "wos-12").reschedule(original.body.booking.bookingId, patch("wos", 2), "same-wos-12-0001");
      assert.equal(result.body.outcome, "unchanged");
      const count = await withProfile(runtime, "wos", (c) => c.query("SELECT count(*)::int AS count FROM minister_bookings WHERE participant_id=(SELECT participant_id FROM minister_bookings WHERE id=$1)", [original.body.booking.bookingId]));
      assert.equal(count.rows[0].count, 1);
    });

    await t.test("cancellation works while closed and frees current reads", async () => {
      const original = await create("wos", "wos-13", 3);
      await withProfile(runtime, "wos", (c) => c.query("UPDATE booking_communities SET bookings_open=false WHERE id=$1", [fixtures.wos.communityId]));
      await assert.rejects(mutate("wos", "wos-13").reschedule(original.body.booking.bookingId, patch("wos", 4), "closed-move-13-0001"), (e) => e.code === "bookings_closed");
      const cancelled = await mutate("wos", "wos-13").cancel(original.body.booking.bookingId, "cancel-wos-13-0001");
      assert.equal(cancelled.body.booking.status, "cancelled");
      const read = createNativeBookingReadService({ gameProfile: "wos", communityId: fixtures.wos.communityId, repository: repos.wos });
      assert.deepEqual((await read.getParticipantBookingsForDiscordUser("wos-13")).bookings, []);
      await withProfile(runtime, "wos", (c) => c.query("UPDATE booking_communities SET bookings_open=true WHERE id=$1", [fixtures.wos.communityId]));
    });

    await t.test("foreign and cross-profile IDs fail without disclosure", async () => {
      const owned = await create("wos", "wos-14", 4);
      await register("wos", "wos-15"); await register("kingshot", "king-25");
      await assert.rejects(mutate("wos", "wos-15").cancel(owned.body.booking.bookingId, "foreign-cancel-0001"), (e) => e.code === "booking_not_found");
      await assert.rejects(mutate("kingshot", "king-25").cancel(owned.body.booking.bookingId, "cross-cancel-0001"), (e) => e.code === "booking_not_found");
    });

    await t.test("target races and simultaneous reschedules leave one valid successor", async () => {
      const a = await create("wos", "wos-16", 5), b = await create("wos", "wos-17", 6);
      const race = await Promise.allSettled([mutate("wos", "wos-16").reschedule(a.body.booking.bookingId, patch("wos", 7), "booking-race-16-0001"), mutate("wos", "wos-17").reschedule(b.body.booking.bookingId, patch("wos", 7), "booking-race-17-0001")]);
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(race.find((r) => r.status === "rejected").reason.code, "slot_unavailable");
      const source = await create("wos", "wos-18", 8);
      const same = await Promise.allSettled([mutate("wos", "wos-18").reschedule(source.body.booking.bookingId, patch("wos", 9), "double-18-a-0001"), mutate("wos", "wos-18").reschedule(source.body.booking.bookingId, patch("wos", 10), "double-18-b-0001")]);
      assert.equal(same.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(same.find((r) => r.status === "rejected").reason.code, "booking_not_active");
    });

    await t.test("blocked targets and current requirement rules fail without changing the original", async () => {
      const source = await create("wos", "wos-20", 12);
      await withProfile(runtime, "wos", async (c) => {
        const key = randomUUID();
        await c.query("INSERT INTO booking_idempotency_keys (game_profile,community_id,idempotency_key,operation,request_hash,correlation_id) VALUES ('wos',$1,$2,'block',$3,$4)", [fixtures.wos.communityId, key, "a".repeat(64), randomUUID()]);
        await c.query("INSERT INTO booking_slot_blocks (game_profile,id,community_id,window_id,slot_id,source,actor_type,idempotency_key,correlation_id) VALUES ('wos',$1,$2,$3,$4,'admin','admin',$5,$6)", [randomUUID(), fixtures.wos.communityId, fixtures.wos.windowId, fixtures.wos.slots[13], key, randomUUID()]);
      });
      await assert.rejects(mutate("wos", "wos-20").reschedule(source.body.booking.bookingId, patch("wos", 13), "blocked-move-20-0001"), (e) => e.code === "slot_unavailable");
      await assert.rejects(mutate("wos", "wos-20").reschedule(source.body.booking.bookingId, { slotId: fixtures.wos.slots[14], requirements: {} }, "invalid-requirement-20-0001"), (e) => e.code === "invalid_requirements");
      const row = await withProfile(runtime, "wos", (c) => c.query("SELECT status,slot_id FROM minister_bookings WHERE id=$1", [source.body.booking.bookingId]));
      assert.deepEqual(row.rows, [{ status: "confirmed", slot_id: fixtures.wos.slots[12] }]);
    });

    await t.test("PATCH and DELETE replay, conflict, audit, and outbox are stable", async () => {
      const source = await create("kingshot", "king-26", 2);
      const service = mutate("kingshot", "king-26");
      const moved = await service.reschedule(source.body.booking.bookingId, patch("kingshot", 3), "replay-move-26-0001");
      assert.deepEqual((await service.reschedule(source.body.booking.bookingId, patch("kingshot", 3), "replay-move-26-0001")).body, moved.body);
      await assert.rejects(service.reschedule(source.body.booking.bookingId, patch("kingshot", 4), "replay-move-26-0001"), BookingMutationIdempotencyConflictError);
      const cancelled = await service.cancel(moved.body.booking.bookingId, "replay-cancel-26-0001");
      const replay = await service.cancel(moved.body.booking.bookingId, "replay-cancel-26-0001");
      assert.deepEqual(replay.body, cancelled.body); assert.equal(replay.replayed, true);
      const events = await withProfile(runtime, "kingshot", (c) => c.query("SELECT event_type FROM booking_change_events WHERE actor_id='king-26' AND event_type IN ('booking_rescheduled','booking_cancelled') ORDER BY event_type"));
      assert.deepEqual(events.rows, [{ event_type: "booking_cancelled" }, { event_type: "booking_rescheduled" }]);
    });

    await t.test("outbox failure preserves the original booking completely", async () => {
      const source = await create("wos", "wos-19", 15);
      await owner.query("CREATE FUNCTION fail_mutation_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='booking.rescheduled' THEN RAISE EXCEPTION 'forced mutation outbox failure'; END IF; RETURN NEW; END; $$");
      await owner.query("CREATE TRIGGER fail_mutation_outbox_trigger BEFORE INSERT ON booking_outbox FOR EACH ROW EXECUTE FUNCTION fail_mutation_outbox()");
      await assert.rejects(mutate("wos", "wos-19").reschedule(source.body.booking.bookingId, patch("wos", 15, 12), "rollback-move-19-0001"), /forced mutation outbox failure/);
      const row = await withProfile(runtime, "wos", (c) => c.query("SELECT status,slot_id FROM minister_bookings WHERE id=$1", [source.body.booking.bookingId]));
      assert.deepEqual(row.rows, [{ status: "confirmed", slot_id: fixtures.wos.slots[15] }]);
    });

    await t.test("audit failure rolls cancellation back completely", async () => {
      const source = await create("wos", "wos-21", 16);
      await owner.query("CREATE FUNCTION fail_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='booking_cancelled' AND NEW.actor_id='wos-21' THEN RAISE EXCEPTION 'forced cancellation audit failure'; END IF; RETURN NEW; END; $$");
      await owner.query("CREATE TRIGGER fail_cancel_audit_trigger BEFORE INSERT ON booking_change_events FOR EACH ROW EXECUTE FUNCTION fail_cancel_audit()");
      await assert.rejects(mutate("wos", "wos-21").cancel(source.body.booking.bookingId, "rollback-cancel-21-0001"), /forced cancellation audit failure/);
      const row = await withProfile(runtime, "wos", (c) => c.query("SELECT status,slot_id FROM minister_bookings WHERE id=$1", [source.body.booking.bookingId]));
      assert.deepEqual(row.rows, [{ status: "confirmed", slot_id: fixtures.wos.slots[16] }]);
    });

    await t.test("outbox failure also rolls cancellation back completely", async () => {
      const source = await create("wos", "wos-22", 17);
      await owner.query("CREATE FUNCTION fail_cancel_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='booking.cancelled' AND NEW.payload->>'bookingId' IS NOT NULL THEN RAISE EXCEPTION 'forced cancellation outbox failure'; END IF; RETURN NEW; END; $$");
      await owner.query("CREATE TRIGGER fail_cancel_outbox_trigger BEFORE INSERT ON booking_outbox FOR EACH ROW EXECUTE FUNCTION fail_cancel_outbox()");
      await assert.rejects(mutate("wos", "wos-22").cancel(source.body.booking.bookingId, "rollback-cancel-22-0001"), /forced cancellation outbox failure/);
      const row = await withProfile(runtime, "wos", (c) => c.query("SELECT status,slot_id FROM minister_bookings WHERE id=$1", [source.body.booking.bookingId]));
      assert.deepEqual(row.rows, [{ status: "confirmed", slot_id: fixtures.wos.slots[17] }]);
    });
  } finally { await runtime?.end(); await owner.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end(); }
});
