import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";

import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { configurePostgresTypeParsers } from "../server/database/postgres-types.mjs";
import { createDiscordIntegrationRepository } from "../server/discord-integration/repository-core.mjs";
import { createManagerBookingMutationService } from "../server/booking-board/manager-booking-mutation-core.mjs";
import { hashGuestShareToken } from "../server/booking-approval/domain-core.mjs";
import { createProfileScopedApprovalRepository } from "../server/booking-approval/repository-core.mjs";
import { createBookingApprovalService, createBookingBoardReadService, createGuestBookingRequestService } from "../server/booking-approval/service-core.mjs";
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
      const shareToken = (profile === "wos" ? "w" : "k").repeat(43);
      fixtures[profile] = { communityId, windowId, dateId, shareToken, slots: [] };
      await withProfile(runtime, profile, async (c) => {
        await c.query("INSERT INTO booking_communities (game_profile,id,location_code,display_name,bookings_open) VALUES ($1,$2,$3,$4,true)", [profile, communityId, profile === "wos" ? "1001" : "2002", profile]);
        await c.query("INSERT INTO booking_settings (game_profile,community_id,construction_fc_required,construction_speedups_required) VALUES ($1,$2,true,true)", [profile, communityId]);
        await c.query("INSERT INTO booking_guest_share_links (game_profile,id,community_id,token_hash,token_hint,label) VALUES ($1,$2,$3,$4,$5,'Manager race test')", [profile, randomUUID(), communityId, hashGuestShareToken(shareToken), shareToken.slice(0, 6)]);
        await c.query("INSERT INTO booking_windows (game_profile,id,community_id,status,opens_at,closes_at,created_by_actor_type) VALUES ($1,$2,$3,'open',now()-interval '1 hour',now()+interval '1 day','system')", [profile, windowId, communityId]);
        await c.query("INSERT INTO booking_service_dates (game_profile,id,community_id,window_id,service_code,booking_date) VALUES ($1,$2,$3,$4,'construction','2030-08-21')", [profile, dateId, communityId, windowId]);
        for (let i = 0; i < 45; i++) {
          const slot = randomUUID();
          const time = `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`;
          fixtures[profile].slots.push(slot);
          await c.query("INSERT INTO appointment_slots (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,ordinal,display_time_label,local_start_time,time_zone) VALUES ($1,$2,$3,$4,$5,'construction','2030-08-21',$6,$7::text,$7::time,'UTC')", [profile, slot, communityId, windowId, dateId, i, time]);
        }
      });
    }
    const repos = Object.fromEntries(["wos", "kingshot"].map((p) => [p, createProfileScopedBookingRepository(p, runtime)]));
    const approvalRepos = Object.fromEntries(["wos", "kingshot"].map((p) => [p, createProfileScopedApprovalRepository(p, runtime)]));
    async function register(profile, user) { await createRegistrationService({ context: context(profile, fixtures[profile].communityId, user), repository: repos[profile] }).upsert({ playerId: user.replace(/\D/g, "") || "1", inGameName: user, alliance: "ABC" }, `register-${user}-0001`); }
    async function create(profile, user, slotIndex, key = `create-${user}-0001`) { await register(profile, user); return createBookingCreationService({ context: context(profile, fixtures[profile].communityId, user), repository: repos[profile] }).create({ serviceCode: "construction", slotId: fixtures[profile].slots[slotIndex], requirements: { fc: 10, speedups: 7 } }, key); }
    const mutate = (profile, user) => createBookingMutationService({ context: context(profile, fixtures[profile].communityId, user), repository: repos[profile] });
    const manage = (profile, user = "manager-admin", displayName = "MAI2KO", via = "administrator") => createManagerBookingMutationService({
      gameProfile: profile,
      communityId: fixtures[profile].communityId,
      managerContext: { gameProfile: profile, authorizedCommunityId: fixtures[profile].communityId,
        discordUserId: user, displayName, authorization: { via, guildId: "guild" } },
      repository: repos[profile],
    });
    const patch = (profile, index, fc = 10, speedups = 7) => ({ slotId: fixtures[profile].slots[index], requirements: { fc, speedups } });
    const guest = (profile) => createGuestBookingRequestService({ gameProfile: profile, repository: approvalRepos[profile] });

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

    await t.test("Administrator and bot-manager cancellation is scoped, attributed, auditable and idempotent", async () => {
      const adminBooking = await create("wos", "manager-cancel-31", 18);
      const roleBooking = await create("kingshot", "manager-cancel-41", 18);
      const admin = manage("wos", "admin-actor", "MAI2KO", "administrator");
      const role = manage("kingshot", "role-actor", "Jenn", "bot_manager_role");
      const cancelled = await admin.cancel(adminBooking.body.booking.bookingId, "manager-admin-cancel-0001");
      assert.equal(cancelled.body.booking.status, "cancelled");
      assert.equal((await admin.cancel(adminBooking.body.booking.bookingId, "manager-admin-cancel-0001")).replayed, true);
      await role.cancel(roleBooking.body.booking.bookingId, "manager-role-cancel-0001");
      await assert.rejects(admin.cancel(adminBooking.body.booking.bookingId, "manager-admin-cancel-stale"),
        (error) => error.code === "booking_not_active");
      assert.throws(() => createManagerBookingMutationService({
        gameProfile: "wos", communityId: fixtures.wos.communityId, managerContext: null,
        repository: repos.wos,
      }), (error) => error.code === "manager_forbidden");
      assert.throws(() => createManagerBookingMutationService({
        gameProfile: "wos", communityId: randomUUID(),
        managerContext: { gameProfile: "wos", authorizedCommunityId: fixtures.wos.communityId,
          discordUserId: "wrong-state", displayName: "Wrong" }, repository: repos.wos,
      }), (error) => error.code === "manager_forbidden");
      assert.throws(() => createManagerBookingMutationService({
        gameProfile: "kingshot", communityId: fixtures.kingshot.communityId,
        managerContext: { gameProfile: "wos", authorizedCommunityId: fixtures.kingshot.communityId,
          discordUserId: "wrong-profile", displayName: "Wrong" }, repository: repos.kingshot,
      }), (error) => error.code === "manager_forbidden");
      const audits = await withProfile(runtime, "wos", (c) => c.query(
        "SELECT actor_id,after_data->>'actorDisplayName' AS display_name FROM booking_change_events WHERE event_type='manager_booking_cancelled' AND aggregate_id=$1",
        [adminBooking.body.booking.bookingId],
      ));
      assert.deepEqual(audits.rows, [{ actor_id: "admin-actor", display_name: "MAI2KO" }]);
      const available = await createNativeBookingReadService({ gameProfile: "wos",
        communityId: fixtures.wos.communityId, repository: repos.wos }).getAvailability("construction");
      assert.equal(available.slots.some((slot) => slot.slotId === fixtures.wos.slots[18]), true);
      const publicBoard = await createBookingBoardReadService({ gameProfile: "wos",
        communityId: fixtures.wos.communityId, repository: approvalRepos.wos }).publicBoard();
      assert.equal(publicBoard.services[0].slots.find((slot) => slot.time === "09:00").state, "available");
    });

    await t.test("manager manual booking is complete, audited, idempotent, and duplicate-safe", async () => {
      const service = manage("wos", "manual-actor", "Manual Manager");
      const input = (slotIndex, playerId = "700700") => ({
        playerId, inGameName: "Manual Player", alliance: "MAN",
        serviceCode: "construction", slotId: fixtures.wos.slots[slotIndex],
        requirements: { fc: 20, speedups: 8 },
      });
      await createRegistrationService({
        context: context("wos", fixtures.wos.communityId, "manual-player-discord"),
        repository: repos.wos,
      }).upsert({ playerId: "700700", inGameName: "Manual Player", alliance: "MAN" },
        "register-manual-player-0001");
      const created = await service.create(input(40), "manager-manual-create-0001");
      assert.equal(created.status, 201);
      assert.equal(created.body.booking.playerName, "Manual Player");
      assert.equal((await service.create(input(40), "manager-manual-create-0001")).replayed, true);
      const race = await Promise.allSettled([
        service.create(input(41, "701701"), "manager-manual-race-a"),
        service.create(input(42, "701701"), "manager-manual-race-b"),
      ]);
      assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(race.find((result) => result.status === "rejected").reason.code,
        "booking_already_exists");
      await assert.rejects(service.create({ ...input(43, "702702"), requirements: { fc: 20 } },
        "manager-manual-missing-requirement"), (error) => error.code === "invalid_requirements");
      await assert.rejects(guest("wos").create(fixtures.wos.shareToken, input(44),
        "guest-duplicate-manual-0001"), (error) => error.code === "booking_already_exists");
      const persisted = await withProfile(runtime, "wos", (c) => c.query(
        `SELECT booking.source,booking.actor_type,booking.actor_id,
                count(answer.requirement_code)::integer AS answers
           FROM minister_bookings booking
           LEFT JOIN booking_requirement_answers answer
             ON answer.game_profile=booking.game_profile AND answer.booking_id=booking.id
          WHERE booking.id=$1
          GROUP BY booking.id,booking.source,booking.actor_type,booking.actor_id`,
        [created.body.booking.bookingId],
      ));
      assert.deepEqual(persisted.rows, [{ source: "admin", actor_type: "admin",
        actor_id: "manual-actor", answers: 2 }]);
      const points = await withProfile(runtime, "wos", (c) => c.query(
        `SELECT count(*)::integer AS count FROM player_points_ledger
          WHERE booking_id=$1 AND reason='appointment_confirmed'`,
        [created.body.booking.bookingId],
      ));
      assert.equal(points.rows[0].count, 1);
      const audit = await withProfile(runtime, "wos", (c) => c.query(
        `SELECT event_type,actor_id,after_data->>'playerId' AS player_id,
                after_data->>'serviceCode' AS service_code,after_data->>'slotId' AS slot_id
           FROM booking_change_events WHERE aggregate_id=$1`,
        [created.body.booking.bookingId],
      ));
      assert.deepEqual(audit.rows, [{ event_type: "manager_manual_booking",
        actor_id: "manual-actor", player_id: "700700", service_code: "construction",
        slot_id: fixtures.wos.slots[40] }]);
    });

    await t.test("manager reschedule moves atomically, preserves answers, updates reminders and attributes the player DM", async () => {
      const original = await create("wos", "manager-move-32", 19);
      const cancelOriginal = await create("wos", "manager-notify-cancel", 38);
      const integration = createDiscordIntegrationRepository("wos", runtime);
      await integration.withTransaction((session) => session.claim(200));
      await manage("wos", "cancel-notify-actor", "Cancellation Manager").cancel(
        cancelOriginal.body.booking.bookingId, "manager-notify-cancel-0001",
      );
      const moved = await manage("wos", "move-actor", "Operator One").reschedule(
        original.body.booking.bookingId, fixtures.wos.slots[20], "manager-move-32-0001",
      );
      assert.equal(moved.body.outcome, "rescheduled");
      const work = await integration.withTransaction((session) => session.claim(200));
      const playerWork = work.find((item) => item.type === "player_rescheduled"
        && item.bookingId === moved.body.booking.bookingId);
      assert.equal(playerWork.attributionDisplayName, "Operator One");
      const cancellationWork = work.find((item) => item.type === "player_cancelled"
        && item.bookingId === cancelOriginal.body.booking.bookingId);
      assert.equal(cancellationWork.attributionDisplayName, "Cancellation Manager");
      const rows = await withProfile(runtime, "wos", (c) => c.query(
        `SELECT booking.id,booking.status,booking.slot_id,
                (SELECT count(*)::int FROM booking_requirement_answers answer
                  WHERE answer.game_profile=booking.game_profile AND answer.booking_id=booking.id) AS answers
         FROM minister_bookings booking WHERE booking.id=$1 OR booking.id=$2 ORDER BY booking.id`,
        [original.body.booking.bookingId, moved.body.booking.bookingId],
      ));
      assert.equal(rows.rows.find((row) => row.id === original.body.booking.bookingId).status, "replaced");
      assert.equal(rows.rows.find((row) => row.id === moved.body.booking.bookingId).slot_id, fixtures.wos.slots[20]);
      assert.equal(rows.rows.find((row) => row.id === moved.body.booking.bookingId).answers, 2);
      const boardReader = createBookingBoardReadService({ gameProfile: "wos",
        communityId: fixtures.wos.communityId, repository: approvalRepos.wos,
        managerContext: { gameProfile: "wos", authorizedCommunityId: fixtures.wos.communityId,
          discordUserId: "move-actor", displayName: "Operator One" } });
      const publicBoard = await boardReader.publicBoard();
      assert.equal(publicBoard.services[0].slots.find((slot) => slot.time === "09:30").state, "available");
      assert.equal(publicBoard.services[0].slots.find((slot) => slot.time === "10:00").state, "confirmed");
      const managerBoard = await boardReader.managerBoard();
      assert.equal(managerBoard.services[0].slots.find((slot) => slot.time === "09:30").state, "available");
      assert.equal(managerBoard.services[0].slots.find((slot) => slot.time === "10:00").bookingId,
        moved.body.booking.bookingId);
      const activity = managerBoard.activity.find((event) => event.action === "manager_booking_rescheduled");
      assert.deepEqual({ manager: activity.actorDisplayName, previous: activity.previousTime,
        next: activity.newTime }, { manager: "Operator One", previous: "09:30", next: "10:00" });
      const reminders = await withProfile(runtime, "wos", (c) => c.query(
        `SELECT booking_id,status FROM booking_discord_notifications
         WHERE notification_type='appointment_reminder' AND booking_id IN ($1,$2) ORDER BY booking_id`,
        [original.body.booking.bookingId, moved.body.booking.bookingId],
      ));
      assert.equal(reminders.rows.find((row) => row.booking_id === original.body.booking.bookingId).status, "superseded");
      assert.equal(reminders.rows.find((row) => row.booking_id === moved.body.booking.bookingId).status, "pending");
      const cancelledReminder = await withProfile(runtime, "wos", (c) => c.query(
        "SELECT status FROM booking_discord_notifications WHERE notification_type='appointment_reminder' AND booking_id=$1",
        [cancelOriginal.body.booking.bookingId],
      ));
      assert.deepEqual(cancelledReminder.rows, [{ status: "superseded" }]);
      const audit = await withProfile(runtime, "wos", (c) => c.query(
        `SELECT actor_id,before_data->>'displayTime' AS previous_time,
                after_data->>'displayTime' AS new_time,after_data->>'actorDisplayName' AS display_name
         FROM booking_change_events WHERE event_type='manager_booking_rescheduled' AND aggregate_id=$1`,
        [moved.body.booking.bookingId],
      ));
      assert.deepEqual(audit.rows, [{ actor_id: "move-actor", previous_time: "09:30",
        new_time: "10:00", display_name: "Operator One" }]);
    });

    await t.test("confirmed bookings and active guest holds block manager targets", async () => {
      const source = await create("wos", "manager-block-source-51", 21);
      await create("wos", "manager-block-target-52", 22);
      const service = manage("wos", "block-manager", "Block Manager");
      await assert.rejects(service.reschedule(source.body.booking.bookingId,
        fixtures.wos.slots[22], "manager-confirmed-block-0001"), (error) => error.code === "slot_unavailable");
      await guest("wos").create(fixtures.wos.shareToken, {
        playerId: "99000001", inGameName: "Held Guest", alliance: "HLD",
        serviceCode: "construction", slotId: fixtures.wos.slots[23],
        requirements: { fc: 10, speedups: 4 },
      }, "manager-held-target-0001");
      await assert.rejects(service.reschedule(source.body.booking.bookingId,
        fixtures.wos.slots[23], "manager-held-block-0001"), (error) => error.code === "slot_unavailable");
      const unchanged = await withProfile(runtime, "wos", (c) => c.query(
        "SELECT status,slot_id FROM minister_bookings WHERE id=$1", [source.body.booking.bookingId],
      ));
      assert.deepEqual(unchanged.rows, [{ status: "confirmed", slot_id: fixtures.wos.slots[21] }]);
    });

    await t.test("manager/player and manager/manager races permit only one transition", async () => {
      const cancelRace = await create("wos", "race-cancel-user-53", 24);
      const cancelResults = await Promise.allSettled([
        manage("wos", "race-manager-a", "Manager A").cancel(cancelRace.body.booking.bookingId, "race-manager-cancel-0001"),
        mutate("wos", "race-cancel-user-53").cancel(cancelRace.body.booking.bookingId, "race-player-cancel-0001"),
      ]);
      assert.equal(cancelResults.filter((result) => result.status === "fulfilled").length, 1);

      const moveRace = await create("wos", "race-move-user-54", 25);
      const moveResults = await Promise.allSettled([
        manage("wos", "race-manager-b", "Manager B").reschedule(moveRace.body.booking.bookingId,
          fixtures.wos.slots[26], "race-manager-move-0001"),
        mutate("wos", "race-move-user-54").reschedule(moveRace.body.booking.bookingId,
          patch("wos", 27), "race-player-move-0001"),
      ]);
      assert.equal(moveResults.filter((result) => result.status === "fulfilled").length, 1);

      const mixedRace = await create("wos", "race-mixed-user-55", 28);
      const mixedResults = await Promise.allSettled([
        manage("wos", "race-manager-c", "Manager C").cancel(mixedRace.body.booking.bookingId,
          "race-manager-mixed-cancel"),
        manage("wos", "race-manager-d", "Manager D").reschedule(mixedRace.body.booking.bookingId,
          fixtures.wos.slots[29], "race-manager-mixed-move"),
      ]);
      assert.equal(mixedResults.filter((result) => result.status === "fulfilled").length, 1);

      const doubleMove = await create("wos", "race-double-user-56", 30);
      const doubleResults = await Promise.allSettled([
        manage("wos", "race-manager-e", "Manager E").reschedule(doubleMove.body.booking.bookingId,
          fixtures.wos.slots[31], "race-double-move-a"),
        manage("wos", "race-manager-f", "Manager F").reschedule(doubleMove.body.booking.bookingId,
          fixtures.wos.slots[32], "race-double-move-b"),
      ]);
      assert.equal(doubleResults.filter((result) => result.status === "fulfilled").length, 1);

      const targetA = await create("wos", "race-target-a-57", 33);
      const targetB = await create("wos", "race-target-b-58", 34);
      const targetResults = await Promise.allSettled([
        manage("wos", "race-manager-g", "Manager G").reschedule(targetA.body.booking.bookingId,
          fixtures.wos.slots[35], "race-target-move-a"),
        manage("wos", "race-manager-h", "Manager H").reschedule(targetB.body.booking.bookingId,
          fixtures.wos.slots[35], "race-target-move-b"),
      ]);
      assert.equal(targetResults.filter((result) => result.status === "fulfilled").length, 1);
      const targetCount = await withProfile(runtime, "wos", (c) => c.query(
        "SELECT count(*)::int AS count FROM minister_bookings WHERE slot_id=$1 AND status='confirmed'",
        [fixtures.wos.slots[35]],
      ));
      assert.equal(targetCount.rows[0].count, 1);
    });

    await t.test("a simultaneous guest hold and manager move cannot both claim the target", async () => {
      const source = await create("wos", "race-guest-source-59", 36);
      const results = await Promise.allSettled([
        manage("wos", "race-manager-i", "Manager I").reschedule(source.body.booking.bookingId,
          fixtures.wos.slots[37], "race-guest-manager-move"),
        guest("wos").create(fixtures.wos.shareToken, {
          playerId: "99000002", inGameName: "Racing Guest", alliance: "RCE",
          serviceCode: "construction", slotId: fixtures.wos.slots[37],
          requirements: { fc: 10, speedups: 4 },
        }, "race-guest-hold-0001"),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const occupancy = await withProfile(runtime, "wos", (c) => c.query(
        `SELECT
          (SELECT count(*)::int FROM minister_bookings WHERE slot_id=$1 AND status='confirmed') AS confirmed,
          (SELECT count(*)::int FROM booking_approval_requests WHERE slot_id=$1
            AND status='pending_approval' AND hold_expires_at>now()) AS pending`,
        [fixtures.wos.slots[37]],
      ));
      assert.equal(occupancy.rows[0].confirmed + occupancy.rows[0].pending, 1);
    });

    await t.test("a guest booking without a linked Discord identity queues no player cancellation DM", async () => {
      const pending = await guest("wos").create(fixtures.wos.shareToken, {
        playerId: "99000003", inGameName: "Offline Guest", alliance: "OFF",
        serviceCode: "construction", slotId: fixtures.wos.slots[39],
        requirements: { fc: 10, speedups: 4 },
      }, "offline-guest-request-0001");
      const approval = await createBookingApprovalService({ gameProfile: "wos",
        communityId: fixtures.wos.communityId,
        managerContext: { gameProfile: "wos", authorizedCommunityId: fixtures.wos.communityId,
          discordUserId: "approval-actor", displayName: "Approval Manager" },
        repository: approvalRepos.wos }).approve(pending.body.request.requestId);
      await manage("wos", "offline-cancel-actor", "Offline Manager").cancel(
        approval.booking.bookingId, "offline-guest-cancel-0001",
      );
      await createDiscordIntegrationRepository("wos", runtime)
        .withTransaction((session) => session.claim(200));
      const notifications = await withProfile(runtime, "wos", (c) => c.query(
        "SELECT count(*)::int AS count FROM booking_discord_notifications WHERE booking_id=$1 AND notification_type='player_cancelled'",
        [approval.booking.bookingId],
      ));
      assert.equal(notifications.rows[0].count, 0);
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
