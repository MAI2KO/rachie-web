import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { createProfileScopedBookingAdminRepository } from "../server/booking-admin/repository-core.mjs";
import { createBookingAdminService } from "../server/booking-admin/service-core.mjs";
import { createProfileScopedApprovalRepository } from "../server/booking-approval/repository-core.mjs";
import { createDiscordIntegrationRepository } from "../server/discord-integration/repository-core.mjs";
import { createGuestBookingPageService } from "../server/booking-approval/service-core.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import {
  enabledBookingRequirementDefinitions,
  InvalidBookingRequestError,
  validateRequirementAnswers,
} from "../server/native-booking/booking-creation-validation.mjs";
import { createProfileScopedBookingRepository } from "../server/native-booking/repository-core.mjs";
import { createNativeBookingReadService, NativeBookingServiceNotFoundError } from "../server/native-booking/read-service-core.mjs";

const databaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();
const migrationsDirectory = fileURLToPath(new URL("../db/migrations/", import.meta.url));

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

test("Booking Admin persists isolated controls and existing booking reads honor them", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const schema = `booking_admin_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const sharedId = randomUUID();
  const otherCommunityId = randomUUID();
  const windowId = randomUUID();
  const serviceDateId = randomUUID();
  const slotId = randomUUID();
  try {
    await runMigrations(pool, await loadMigrations(migrationsDirectory));
    await withProfile(pool, "wos", async (client) => {
      await client.query(
        `INSERT INTO booking_communities
           (game_profile,id,location_code,display_name,status,bookings_open)
         VALUES ('wos',$1,'9999','State 9999','active',true),
                ('wos',$2,'8888','State 8888','active',true)`,
        [sharedId, otherCommunityId],
      );
      await client.query(
        `INSERT INTO booking_settings
           (game_profile,community_id,construction_fc_required,construction_speedups_required)
         VALUES ('wos',$1,true,true),('wos',$2,true,true)`,
        [sharedId, otherCommunityId],
      );
      await client.query(
        `INSERT INTO booking_windows
           (game_profile,id,community_id,status,created_by_actor_type)
         VALUES ('wos',$1,$2,'open','system')`,
        [windowId, sharedId],
      );
      await client.query(
        `INSERT INTO booking_service_dates
           (game_profile,id,community_id,window_id,service_code,booking_date)
         VALUES ('wos',$1,$2,$3,'construction','2026-08-30')`,
        [serviceDateId, sharedId, windowId],
      );
      await client.query(
        `INSERT INTO appointment_slots
           (game_profile,id,community_id,window_id,service_date_id,service_code,
            booking_date,ordinal,display_time_label,local_start_time,time_zone)
         VALUES ('wos',$1,$2,$3,$4,'construction','2026-08-30',1,'10:00','10:00','UTC')`,
        [slotId, sharedId, windowId, serviceDateId],
      );
    });
    await withProfile(pool, "kingshot", (client) => client.query(
      `INSERT INTO booking_communities
         (game_profile,id,location_code,display_name,status,bookings_open)
       VALUES ('kingshot',$1,'9999','Kingdom 9999','active',true)`,
      [sharedId],
    ));

    const managerContext = {
      gameProfile: "wos", authorizedCommunityId: sharedId,
      discordUserId: "111111111111111111", displayName: "Manager",
    };
    const adminRepository = createProfileScopedBookingAdminRepository("wos", pool);
    const guestTokenSecret = "booking-admin-integration-secret-value-123456";
    const service = createBookingAdminService({
      gameProfile: "wos", communityId: sharedId, managerContext, repository: adminRepository,
      guestTokenSecret,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
    });
    const initial = await service.read();
    assert.equal(initial.community.bookingsEnabled, true);
    assert.deepEqual(initial.dates, [{
      serviceCode: "construction", serviceName: "Construction",
      date: "2026-08-30", windowStatus: "open",
    }]);

    const createdOverride = await service.updateCycleSchedule({
      section: "cycleSchedule", action: "override", cycleIndex: 1,
      opensAt: "2026-09-01T18:00:00.000Z", closesAt: "2026-09-06T18:00:00.000Z",
      confirmedOpenChange: false,
    });
    assert.equal(createdOverride.changed, true);
    assert.equal(createdOverride.configuration.automaticCycle.overridden, true);
    assert.equal(createdOverride.configuration.automaticCycle.opensAt, "2026-09-01T18:00:00.000Z");
    const changedOverride = await service.updateCycleSchedule({
      section: "cycleSchedule", action: "override", cycleIndex: 1,
      opensAt: "2026-09-01T17:00:00.000Z", closesAt: "2026-09-06T19:00:00.000Z",
      confirmedOpenChange: false,
    });
    assert.equal(changedOverride.changed, true);
    const restored = await service.updateCycleSchedule({
      section: "cycleSchedule", action: "restore", cycleIndex: 1, confirmedOpenChange: false,
    });
    assert.equal(restored.configuration.automaticCycle.overridden, false);

    const guestPages = createGuestBookingPageService({
      gameProfile: "wos", repository: createProfileScopedApprovalRepository("wos", pool),
    });
    const generated = await service.updateGuestLink({ section: "guestLink", action: "generate" });
    const generatedToken = generated.guestLinkPath.slice("/book/".length);
    assert.equal((await guestPages.read(generatedToken)).community.code, "9999");
    const discord = createDiscordIntegrationRepository("wos", pool);
    const generatedWork = (await discord.withTransaction((session) => session.claim(10, {
      guestTokenSecret, publicBaseUrl: "https://current.example",
    }))).find((work) => work.type === "manager_guest_link");
    assert.equal(generatedWork.guestPath, generated.guestLinkPath);
    assert.equal("guestUrl" in generatedWork, false);
    assert.deepEqual(generatedWork.guilds, []);
    await discord.withTransaction((session) => session.finish(generatedWork.workId,
      generatedWork.claimToken, { status: "retry", errorCode: "temporary_dm_failure" }));
    const rotated = await service.updateGuestLink({ section: "guestLink", action: "rotate" });
    const rotatedToken = rotated.guestLinkPath.slice("/book/".length);
    await assert.rejects(guestPages.read(generatedToken), (error) => error.code === "invalid_share_link");
    await assert.rejects(createGuestBookingPageService({
      gameProfile: "kingshot", repository: createProfileScopedApprovalRepository("kingshot", pool),
    }).read(rotatedToken), (error) => error.code === "invalid_share_link");
    const rotatedWork = (await discord.withTransaction((session) => session.claim(10, {
      guestTokenSecret, publicBaseUrl: "https://current.example",
    }))).find((work) => work.type === "manager_guest_link");
    assert.equal(rotatedWork.guestPath, rotated.guestLinkPath);
    assert.equal((await service.updateGuestLink({ section: "guestLink", action: "revoke" }))
      .configuration.guestLink.status, "revoked");
    assert.equal(await discord.withTransaction((session) => session.finish(rotatedWork.workId,
      rotatedWork.claimToken, { status: "sent" })), false);
    await assert.rejects(guestPages.read(rotatedToken), (error) => error.code === "invalid_share_link");
    const guestLinkState = await withProfile(pool, "wos", (client) => client.query(
      `SELECT notification_type,status,idempotency_key,recipient_discord_user_id
         FROM booking_discord_notifications WHERE notification_type='manager_guest_link'
         ORDER BY created_at`,
    ));
    assert.deepEqual(guestLinkState.rows.map(({ notification_type, status,
      recipient_discord_user_id }) => ({ notification_type, status, recipient_discord_user_id })), [
      { notification_type: "manager_guest_link", status: "superseded",
        recipient_discord_user_id: null },
      { notification_type: "manager_guest_link", status: "superseded",
        recipient_discord_user_id: null },
    ]);
    assert.equal(JSON.stringify(guestLinkState.rows).includes("https://"), false);

    await service.update({ section: "booking", enabled: false });
    await service.update({ section: "service", serviceCode: "construction", enabled: false });
    await service.update({
      section: "requirement", serviceCode: "construction", requirementCode: "fc", enabled: false,
    });
    await service.update({
      section: "requirement", serviceCode: "construction", requirementCode: "speedups", enabled: false,
    });

    const wosRepository = createProfileScopedBookingRepository("wos", pool);
    const targetRead = createNativeBookingReadService({
      gameProfile: "wos", communityId: sharedId, repository: wosRepository,
    });
    const otherRead = createNativeBookingReadService({
      gameProfile: "wos", communityId: otherCommunityId, repository: wosRepository,
    });
    assert.equal((await targetRead.getContext()).bookingsOpen, false);
    assert.equal((await targetRead.getContext()).services.some(({ code }) => code === "construction"), false);
    assert.equal((await otherRead.getContext()).services.some(({ code }) => code === "construction"), true);
    await assert.rejects(targetRead.getAvailability("construction"), NativeBookingServiceNotFoundError);

    await service.update({ section: "booking", enabled: true });
    await service.update({ section: "service", serviceCode: "construction", enabled: true });
    const enabledAvailability = await targetRead.getAvailability("construction");
    assert.equal(enabledAvailability.slots.some(({ slotId: id }) => id === slotId), true);

    const storedSettings = await wosRepository.withTransaction((session) => session.findBookingSettings(sharedId));
    assert.deepEqual(enabledBookingRequirementDefinitions("wos", "construction", storedSettings), []);
    assert.deepEqual(validateRequirementAnswers("wos", "construction", storedSettings, {}), []);
    await service.update({
      section: "requirement", serviceCode: "construction", requirementCode: "fc", enabled: true,
    });
    const requiredSettings = await wosRepository.withTransaction((session) => session.findBookingSettings(sharedId));
    assert.deepEqual(enabledBookingRequirementDefinitions("wos", "construction", requiredSettings)
      .map(({ code }) => code), ["fc"]);
    assert.throws(() => validateRequirementAnswers("wos", "construction", requiredSettings, {}),
      InvalidBookingRequestError);
    await service.update({
      section: "requirement", serviceCode: "construction", requirementCode: "speedups", enabled: true,
    });
    const speedupsRequired = await wosRepository.withTransaction(
      (session) => session.findBookingSettings(sharedId),
    );
    assert.deepEqual(enabledBookingRequirementDefinitions("wos", "construction", speedupsRequired)
      .map(({ code }) => code), ["fc", "speedups"]);

    const profileState = await withProfile(pool, "kingshot", (client) => client.query(
      "SELECT bookings_open FROM booking_communities WHERE id=$1", [sharedId],
    ));
    assert.equal(profileState.rows[0].bookings_open, true);
    const otherState = await withProfile(pool, "wos", (client) => client.query(
      "SELECT bookings_open FROM booking_communities WHERE id=$1", [otherCommunityId],
    ));
    assert.equal(otherState.rows[0].bookings_open, true);
    const audits = await withProfile(pool, "wos", (client) => client.query(
      `SELECT event_type,actor_id FROM booking_change_events
        WHERE community_id=$1 ORDER BY created_at,id`, [sharedId],
    ));
    assert.equal(audits.rows.length, 14);
    assert.equal(audits.rows.every((row) => row.actor_id === managerContext.discordUserId), true);
    assert.deepEqual([...new Set(audits.rows.map((row) => row.event_type))].sort(), [
      "booking_admin_updated",
      "booking_cycle_override_changed", "booking_cycle_override_created",
      "booking_cycle_override_removed",
      "guest_link_generate", "guest_link_revoke", "guest_link_rotate",
    ]);
    const activity = (await service.read()).activity;
    assert.equal(activity.length, 14);
    assert.equal(activity.every((event) => event.actorDiscordUserId === managerContext.discordUserId), true);
    assert.equal(activity.some((event) => event.action === "booking_admin_updated"
      && event.category === "configuration"), true);
    assert.equal(activity.some((event) => event.action === "guest_link_rotate"), true);
    assert.equal(activity.every((event, index) => index === 0
      || new Date(activity[index - 1].createdAt) >= new Date(event.createdAt)), true);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("Booking Admin migration backfills existing communities through profile RLS", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const schema = `booking_admin_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const communityId = randomUUID();
  try {
    const migrations = await loadMigrations(migrationsDirectory);
    await runMigrations(pool, migrations.filter(({ version }) => version < "0007"));
    for (const profile of ["wos", "kingshot"]) {
      await withProfile(pool, profile, (client) => client.query(
        `INSERT INTO booking_communities
           (game_profile,id,location_code,display_name,status,bookings_open)
         VALUES ($1,$2,'7777',$3,'active',true)`,
        [profile, communityId, profile === "wos" ? "State 7777" : "Kingdom 7777"],
      ));
    }

    await runMigrations(pool, migrations);

    for (const profile of ["wos", "kingshot"]) {
      const backfill = await withProfile(pool, profile, (client) => client.query(
        `SELECT service.service_code,service.active,community_service.enabled
           FROM minister_services AS service
           LEFT JOIN booking_community_services AS community_service
             ON community_service.game_profile=service.game_profile
            AND community_service.community_id=$2
            AND community_service.service_code=service.service_code
          WHERE service.game_profile=$1
          ORDER BY service.service_code`,
        [profile, communityId],
      ));
      assert.ok(backfill.rows.length > 0);
      assert.equal(backfill.rows.every((row) => row.enabled === row.active), true);
      const settings = await withProfile(pool, profile, (client) => client.query(
        "SELECT 1 FROM booking_settings WHERE game_profile=$1 AND community_id=$2",
        [profile, communityId],
      ));
      assert.equal(settings.rowCount, 1);
    }
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
