import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { reconcileAutomaticWosBookingCycles } from "../server/automatic-booking-cycle/repository-core.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { runtimePrivilegeStatements } from "../server/database/runtime-privileges.mjs";
import { createDiscordCommunitySetupService } from "../server/discord-integration/community-setup-service-core.mjs";
import { createBookingCreationService } from "../server/native-booking/booking-creation-service-core.mjs";
import { createBookingMutationService } from "../server/native-booking/booking-mutation-service-core.mjs";
import { createProfileScopedBookingAdminRepository } from "../server/booking-admin/repository-core.mjs";
import { createBookingAdminService } from "../server/booking-admin/service-core.mjs";
import { createProfileScopedBookingRepository } from "../server/native-booking/repository-core.mjs";
import { createRegistrationService } from "../server/native-booking/registration-service-core.mjs";

const databaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();

async function withProfile(pool, profile, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile',$1,true)", [profile]);
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

test("staging-equivalent runtime grants support native booking writes", { skip: !databaseUrl && "TEST_DATABASE_URL is not configured" }, async (t) => {
  const schema = `runtime_grants_${randomUUID().replaceAll("-", "")}`;
  const role = `runtime_grants_role_${randomUUID().replaceAll("-", "")}`;
  const password = `test_${randomUUID()}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const owner = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  let runtime;

  try {
    await runMigrations(owner, await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url))));
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    for (const sql of runtimePrivilegeStatements(role, { includeRowLockPrivileges: false })) await owner.query(sql);

    const communityId = randomUUID();
    const windowId = randomUUID();
    const serviceDateId = randomUUID();
    const slotIds = [randomUUID(), randomUUID()];
    await withProfile(owner, "wos", async (client) => {
      await client.query(
        `INSERT INTO booking_communities (game_profile,id,location_code,display_name,status,bookings_open)
         VALUES ('wos',$1,'9999','Test Server','active',true)`,
        [communityId],
      );
      await client.query(
        `INSERT INTO booking_settings (game_profile,community_id)
         VALUES ('wos',$1)`,
        [communityId],
      );
      await client.query(
        `INSERT INTO booking_windows
           (game_profile,id,community_id,status,created_by_actor_type)
         VALUES ('wos',$1,$2,'open','system')`,
        [windowId, communityId],
      );
      await client.query(
        `INSERT INTO booking_service_dates
           (game_profile,id,community_id,window_id,service_code,booking_date)
         VALUES ('wos',$1,$2,$3,'construction','2026-09-01')`,
        [serviceDateId, communityId, windowId],
      );
      for (const [ordinal, slotId] of slotIds.entries()) {
        await client.query(
          `INSERT INTO appointment_slots
             (game_profile,id,community_id,window_id,service_date_id,service_code,
              booking_date,ordinal,display_time_label,local_start_time,time_zone)
           VALUES ('wos',$1,$2,$3,$4,'construction','2026-09-01',$5,$6,$7,'Europe/London')`,
          [
            slotId,
            communityId,
            windowId,
            serviceDateId,
            ordinal,
            `${String(9 + ordinal).padStart(2, "0")}:00`,
            `${String(9 + ordinal).padStart(2, "0")}:00`,
          ],
        );
      }
      for (const [serviceCode, bookingDate] of [["research", "2026-09-02"], ["troop", "2026-09-03"]]) {
        const dateId = randomUUID();
        await client.query(
          `INSERT INTO booking_service_dates
             (game_profile,id,community_id,window_id,service_code,booking_date)
           VALUES ('wos',$1,$2,$3,$4,$5)`,
          [dateId, communityId, windowId, serviceCode, bookingDate],
        );
        await client.query(
          `INSERT INTO appointment_slots
             (game_profile,id,community_id,window_id,service_date_id,service_code,
              booking_date,ordinal,display_time_label,local_start_time,time_zone)
           VALUES ('wos',$1,$2,$3,$4,$5,$6,0,'09:00','09:00','Europe/London')`,
          [randomUUID(), communityId, windowId, dateId, serviceCode, bookingDate],
        );
      }
    });

    const url = new URL(databaseUrl);
    url.username = role;
    url.password = password;
    runtime = new pg.Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` });
    const roleState = await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(roleState.rows, [{ rolsuper: false, rolbypassrls: false }]);
    await assert.rejects(runtime.query("SELECT version FROM app_schema_migrations"), (error) => error.code === "42501");

    const context = { gameProfile: "wos", community: { id: communityId }, discordUser: { id: "runtime-user" } };
    const repository = createProfileScopedBookingRepository("wos", runtime);
    const linked = await repository.withTransaction((session) => session.linkDiscordGuild({
      discordGuildId: "777777777777777777", communityId,
      discordGuildName: "Runtime Guild", actorId: "999999999999999999",
    }));
    assert.equal(linked.status, "created");
    const relinked = await repository.withTransaction((session) => session.linkDiscordGuild({
      discordGuildId: "777777777777777777", communityId,
      discordGuildName: "Renamed Runtime Guild", actorId: "999999999999999999",
    }));
    assert.equal(relinked.status, "updated");
    assert.equal((await repository.findCommunityForDiscordGuild(
      "777777777777777777"
    )).id, communityId);
    await assert.rejects(withProfile(runtime, "wos", (client) => client.query(
      `UPDATE booking_discord_guilds SET guild_kind='state'
        WHERE discord_guild_id='777777777777777777'`,
    )), (error) => error.code === "42501");
    await createRegistrationService({ context, repository }).upsert(
      { playerId: "99990001", inGameName: "Runtime Test", alliance: "TST" },
      "runtime-register-0001",
    );
    const creator = createBookingCreationService({ context, repository });
    const choice = (slotId) => ({ serviceCode: "construction", slotId, requirements: {} });

    await t.test("the documented SELECT-only configuration grant reproduces SQLSTATE 42501", async () => {
      await assert.rejects(
        creator.create(choice(slotIds[0]), "runtime-booking-before-lock-grants"),
        (error) => error.code === "42501"
          && /booking_(?:communities|appointment_slots)|appointment_slots/.test(error.message),
      );
      const started = await withProfile(runtime, "wos", (client) => client.query(
        "SELECT count(*)::int AS count FROM booking_idempotency_keys WHERE operation='booking_create'",
      ));
      assert.equal(started.rows[0].count, 0);
    });

    await owner.query(`GRANT UPDATE (updated_at) ON booking_communities TO "${role}"`);
    await t.test("fixing only the community lock exposes the second appointment-slot lock requirement", async () => {
      await assert.rejects(
        creator.create(choice(slotIds[0]), "runtime-booking-community-lock-only"),
        (error) => error.code === "42501" && /appointment_slots/.test(error.message),
      );
    });

    await owner.query(`GRANT UPDATE (updated_at) ON appointment_slots TO "${role}"`);
    await t.test("column-level lock grants allow creation, reschedule, and cancellation", async () => {
      const created = await creator.create(choice(slotIds[0]), "runtime-booking-create-0001");
      assert.equal(created.status, 201);
      const mutations = createBookingMutationService({ context, repository });
      const rescheduled = await mutations.reschedule(
        created.body.booking.bookingId,
        { slotId: slotIds[1], requirements: {} },
        "runtime-booking-reschedule-0001",
      );
      assert.equal(rescheduled.body.outcome, "rescheduled");
      const cancelled = await mutations.cancel(
        rescheduled.body.booking.bookingId,
        "runtime-booking-cancel-0001",
      );
      assert.equal(cancelled.body.booking.status, "cancelled");
    });

    await t.test("admin grants permit only the intended booking configuration columns", async () => {
      const privileges = await runtime.query(
        `SELECT
           has_table_privilege(current_user,'booking_communities','UPDATE') AS community_table_update,
           has_column_privilege(current_user,'booking_communities','updated_at','UPDATE') AS community_lock_column,
           has_column_privilege(current_user,'booking_communities','bookings_open','UPDATE') AS community_business_column,
           has_column_privilege(current_user,'booking_communities','status','UPDATE') AS community_status_column,
           has_table_privilege(current_user,'appointment_slots','UPDATE') AS slot_table_update,
           has_column_privilege(current_user,'appointment_slots','updated_at','UPDATE') AS slot_lock_column,
           has_column_privilege(current_user,'appointment_slots','status','UPDATE') AS slot_business_column`,
      );
      assert.deepEqual(privileges.rows[0], {
        community_table_update: false,
        community_lock_column: true,
        community_business_column: true,
        community_status_column: false,
        slot_table_update: false,
        slot_lock_column: true,
        slot_business_column: false,
      });
      await assert.rejects(withProfile(runtime, "wos", (client) => client.query(
        "UPDATE booking_communities SET status='archived' WHERE id=$1",
        [communityId],
      )), (error) => error.code === "42501");
      await assert.rejects(withProfile(runtime, "wos", (client) => client.query(
        "UPDATE appointment_slots SET status='blocked' WHERE id=$1",
        [slotIds[0]],
      )), (error) => error.code === "42501");
    });

    await t.test("runtime role can persist audited Booking Admin settings", async () => {
      const managerContext = {
        gameProfile: "wos", authorizedCommunityId: communityId,
        discordUserId: "111111111111111111", displayName: "Runtime Manager",
      };
      const adminService = createBookingAdminService({
        gameProfile: "wos", communityId, managerContext,
        repository: createProfileScopedBookingAdminRepository("wos", runtime),
        guestTokenSecret: "runtime-booking-integration-secret-value-123456",
      });
      assert.equal((await adminService.update({ section: "booking", enabled: false }))
        .community.bookingsEnabled, false);
      assert.equal((await adminService.update({
        section: "service", serviceCode: "construction", enabled: false,
      })).services.find(({ code }) => code === "construction").enabled, false);
      assert.equal((await adminService.update({
        section: "requirement", serviceCode: "construction", requirementCode: "fc", enabled: true,
      })).services.find(({ code }) => code === "construction")
        .requirements.find(({ code }) => code === "fc").enabled, true);
      const generated = await adminService.updateGuestLink({
        section: "guestLink", action: "generate",
      });
      assert.match(generated.guestLinkPath, /^\/book\/[A-Za-z0-9_-]{43}$/);
      assert.equal((await withProfile(runtime, "wos", (client) => client.query(
        `SELECT count(*)::int AS count FROM booking_discord_notifications
          WHERE community_id=$1 AND notification_type='manager_guest_link'`, [communityId],
      ))).rows[0].count, 1);
      await adminService.updateGuestLink({ section: "guestLink", action: "revoke" });
    });

    await t.test("runtime role can reconcile deterministic automatic WOS cycles", async () => {
      const result = await reconcileAutomaticWosBookingCycles({
        pool: runtime, now: new Date("2026-09-01T00:00:00.000Z"),
      });
      assert.equal(result.communities.length, 1);
      assert.equal(result.communities[0].cycles.every(({ status }) => status === "draft"), true);
      const automaticWindows = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT count(*)::int AS count FROM booking_windows
          WHERE community_id=$1 AND created_by_actor_id='automatic-wos-28-day-cycle-v1'`,
        [communityId],
      ));
      assert.equal(automaticWindows.rows[0].count, 2);
    });

    await t.test("runtime role can bootstrap WOS communities safely and automatic cycles use defaults", async () => {
      const setupRepository = createProfileScopedBookingRepository("wos", runtime);
      const setup = createDiscordCommunitySetupService({
        gameProfile: "wos", repository: setupRepository,
      });
      const setupInput = {
        communityCode: "8888", guildId: "777777777777777888",
        guildName: "New Native State", alliance: "NEW",
        actorId: "999999999999999888", dryRun: false,
      };
      const created = await setup.reconcile(setupInput);
      assert.equal(created.status, "native community created and linked");
      assert.equal(created.created, true);
      const replay = await setup.reconcile(setupInput);
      assert.equal(replay.status, "linked and reconciled");
      assert.equal(replay.created, false);

      const raceInputs = [
        { ...setupInput, communityCode: "7777", guildId: "777777777777777701" },
        { ...setupInput, communityCode: "7777", guildId: "777777777777777702" },
      ];
      const raced = await Promise.all(raceInputs.map((value) => setup.reconcile(value)));
      assert.equal(raced.filter((result) => result.created).length, 1);
      assert.equal(raced.filter((result) => result.linkStatus === "pending").length, 1);
      const pendingInput = raceInputs[raced.findIndex((result) => result.linkStatus === "pending")];
      const pendingReplay = await setup.reconcile(pendingInput);
      assert.equal(pendingReplay.status, "alliance link approval pending");
      let requests = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT id,status,requesting_discord_guild_id FROM community_guild_link_requests
          WHERE requesting_discord_guild_id=$1 ORDER BY requested_at,id`, [pendingInput.guildId],
      ));
      assert.equal(requests.rowCount, 1, "pending setup rerun is request-idempotent");

      const raceCommunity = await repository.withTransaction((session) =>
        session.findCommunityByLocationCode("7777"));
      const linkedInput = raceInputs.find((input) => input.guildId !== pendingInput.guildId);
      const managerContext = { gameProfile: "wos", authorizedCommunityId: raceCommunity.id,
        discordUserId: "111111111111111111", displayName: "Existing alliance owner" };
      const approval = createBookingAdminService({
        gameProfile: "wos", communityId: raceCommunity.id, managerContext,
        repository: createProfileScopedBookingAdminRepository("wos", runtime),
        verifyGuildOwner: async ({ guildId }) => ({
          status: guildId === linkedInput.guildId ? "owner" : "not_owner",
        }),
      });
      await approval.decideGuildLinkRequest({ section: "guildLinkRequest", action: "approve",
        requestId: requests.rows[0].id, confirmed: true });
      assert.equal((await setup.reconcile(pendingInput)).status, "linked and reconciled");
      const topology = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT discord_guild_id,guild_kind,link_status FROM booking_discord_guilds
          WHERE community_id=$1 ORDER BY discord_guild_id`, [raceCommunity.id],
      ));
      assert.deepEqual(topology.rows, raceInputs.map((input) => ({
        discord_guild_id: input.guildId, guild_kind: "alliance", link_status: "active",
      })).sort((left, right) => left.discord_guild_id.localeCompare(right.discord_guild_id)));

      const rejectedInput = { ...setupInput, communityCode: "7777",
        guildId: "777777777777777703", guildName: "Rejected then retried" };
      assert.equal((await setup.reconcile(rejectedInput)).linkStatus, "pending");
      requests = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT id,status FROM community_guild_link_requests
          WHERE requesting_discord_guild_id=$1 ORDER BY requested_at,id`, [rejectedInput.guildId],
      ));
      await approval.decideGuildLinkRequest({ section: "guildLinkRequest", action: "reject",
        requestId: requests.rows[0].id, confirmed: true });
      assert.equal((await setup.reconcile(rejectedInput)).status, "alliance link approval requested");
      requests = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT status FROM community_guild_link_requests
          WHERE requesting_discord_guild_id=$1 ORDER BY requested_at,id`, [rejectedInput.guildId],
      ));
      assert.deepEqual(requests.rows.map(({ status }) => status), ["rejected", "pending"]);
      const decisions = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT event_type FROM booking_change_events
          WHERE community_id=$1 AND event_type IN
            ('alliance_guild_link_approved','alliance_guild_link_rejected')
          ORDER BY event_type`, [raceCommunity.id],
      ));
      assert.deepEqual(decisions.rows.map(({ event_type }) => event_type),
        ["alliance_guild_link_approved", "alliance_guild_link_rejected"]);
      assert.equal((await withProfile(runtime, "kingshot", (client) => client.query(
        "SELECT count(*)::int AS count FROM community_guild_link_requests",
      ))).rows[0].count, 0, "forced RLS isolates link requests by profile");

      await reconcileAutomaticWosBookingCycles({
        pool: runtime, now: new Date("2026-09-01T00:00:00.000Z"),
      });
      const defaults = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT community.location_code,
                count(DISTINCT booking_window.id)::int AS windows,
                count(DISTINCT service_date.id)::int AS dates,
                count(slot.id)::int AS slots,
                min(per_date.slot_count)::int AS minimum_slots_per_date
           FROM booking_communities AS community
           JOIN booking_windows AS booking_window ON booking_window.community_id=community.id
            AND booking_window.created_by_actor_id='automatic-wos-28-day-cycle-v1'
           JOIN booking_service_dates AS service_date ON service_date.window_id=booking_window.id
           JOIN appointment_slots AS slot ON slot.service_date_id=service_date.id
           JOIN (SELECT service_date_id,count(*) AS slot_count FROM appointment_slots
                  GROUP BY service_date_id) AS per_date ON per_date.service_date_id=service_date.id
          WHERE community.location_code IN ('7777','8888')
          GROUP BY community.location_code ORDER BY community.location_code`,
      ));
      assert.deepEqual(defaults.rows, [
        { location_code: "7777", windows: 2, dates: 6, slots: 288, minimum_slots_per_date: 48 },
        { location_code: "8888", windows: 2, dates: 6, slots: 288, minimum_slots_per_date: 48 },
      ]);
      const setupAudit = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT count(*)::int AS count FROM booking_change_events
          WHERE event_type='native_community_created'
            AND after_data->>'communityCode' IN ('7777','8888')`,
      ));
      assert.equal(setupAudit.rows[0].count, 2);
    });
  } finally {
    await runtime?.end();
    await owner.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
});
