import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import {
  DiscordIntegrationAuthenticationError,
  signDiscordIntegrationRequest,
  verifyDiscordIntegrationRequest,
} from "../server/discord-integration/auth-core.mjs";
import { createDiscordIntegrationRepository } from "../server/discord-integration/repository-core.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { runtimePrivilegeStatements } from "../server/database/runtime-privileges.mjs";

const databaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();
const secret = "local-placeholder-integration-secret-123456";

test("Discord integration HMAC rejects invalid signatures, stale requests, profile crossover and replay-ready nonces", () => {
  const request = { method: "POST", path: "/api/internal/v1/discord/work/claim",
    timestamp: "1800000000", nonce: "nonce-value-123456789", body: "{\"limit\":10}" };
  const signature = signDiscordIntegrationRequest({ secret, ...request });
  assert.equal(verifyDiscordIntegrationRequest({ profile: "wos", secret, signature, ...request,
    now: () => new Date("2027-01-15T08:00:00Z") }).profile, "wos");
  assert.throws(() => verifyDiscordIntegrationRequest({ profile: "wos", secret, signature: `v1=${"0".repeat(64)}`,
    ...request, now: () => new Date("2027-01-15T08:00:00Z") }),
  (error) => error instanceof DiscordIntegrationAuthenticationError && error.code === "invalid_signature");
  assert.throws(() => verifyDiscordIntegrationRequest({ profile: "wos", secret, signature, ...request,
    now: () => new Date("2027-01-15T09:00:00Z") }), /authentication failed/i);
  assert.throws(() => verifyDiscordIntegrationRequest({ profile: "kingshot", secret: `${secret}x`, signature,
    ...request, now: () => new Date("2027-01-15T08:00:00Z") }), /authentication failed/i);
});

async function withProfile(pool, profile, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile',$1,true)", [profile]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function seedProfile(pool, profile, code) {
  const ids = { community: randomUUID(), window: randomUUID(), date: randomUUID(), slot: randomUUID(),
    participant: randomUUID(), booking: randomUUID(), share: randomUUID(), request: randomUUID() };
  await withProfile(pool, profile, async (client) => {
    await client.query("INSERT INTO booking_communities (game_profile,id,location_code,display_name,bookings_open) VALUES ($1,$2,$3,'Test Server',true)", [profile, ids.community, code]);
    await client.query("INSERT INTO booking_settings (game_profile,community_id) VALUES ($1,$2)", [profile, ids.community]);
    for (const guild of ["100000000000000001", "100000000000000002"]) await client.query(
      "INSERT INTO booking_discord_guilds (game_profile,discord_guild_id,community_id,discord_guild_name,bot_manager_role_id) VALUES ($1,$2,$3,'Guild','200000000000000001')", [profile, guild, ids.community]);
    await client.query("INSERT INTO booking_windows (game_profile,id,community_id,status,created_by_actor_type) VALUES ($1,$2,$3,'open','system')", [profile, ids.window, ids.community]);
    await client.query("INSERT INTO booking_service_dates (game_profile,id,community_id,window_id,service_code,booking_date) VALUES ($1,$2,$3,$4,'construction','2030-08-21')", [profile, ids.date, ids.community, ids.window]);
    await client.query(`INSERT INTO appointment_slots
      (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,ordinal,display_time_label,local_start_time,time_zone)
      VALUES ($1,$2,$3,$4,$5,'construction','2030-08-21',0,'14:30','14:30','UTC')`, [profile, ids.slot, ids.community, ids.window, ids.date]);
    await client.query(`INSERT INTO booking_idempotency_keys
      (game_profile,community_id,idempotency_key,operation,request_hash,correlation_id,status)
      VALUES ($1,$2,'booking-key','booking_create',$3,'correlation','completed'),
             ($1,$2,'guest-key','guest_booking_request',$3,'guest-correlation','completed')`, [profile, ids.community, "a".repeat(64)]);
    await client.query(`INSERT INTO booking_participants
      (game_profile,id,community_id,discord_user_id,player_id,in_game_name,alliance,source,idempotency_key,correlation_id)
      VALUES ($1,$2,$3,'300000000000000001','8008','Player','ABC','website','booking-key','correlation')`, [profile, ids.participant, ids.community]);
    await client.query(`INSERT INTO minister_bookings
      (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,slot_id,participant_id,discord_user_id,
       player_id_snapshot,in_game_name_snapshot,alliance_snapshot,display_time_label_snapshot,source,actor_type,actor_id,idempotency_key,correlation_id)
      VALUES ($1,$2,$3,$4,$5,'construction','2030-08-21',$6,$7,'300000000000000001','8008','Player','ABC','14:30','website','discord_user','300000000000000001','booking-key','correlation')`,
    [profile, ids.booking, ids.community, ids.window, ids.date, ids.slot, ids.participant]);
    await client.query("INSERT INTO booking_requirement_answers (game_profile,booking_id,requirement_code,raw_value,numeric_value,unit,display_label) VALUES ($1,$2,'fc','100',100,'items','Fire Crystals')", [profile, ids.booking]);
    await client.query(`INSERT INTO booking_guest_share_links
      (game_profile,id,community_id,token_hash,token_hint,created_by_actor_id)
      VALUES ($1,$2,$3,$4,'test','local')`, [profile, ids.share, ids.community,
      (profile === "wos" ? "b" : "c").repeat(64)]);
    await client.query(`INSERT INTO booking_approval_requests
      (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,slot_id,request_source,share_link_id,
       player_id_snapshot,in_game_name_snapshot,alliance_snapshot,display_time_label_snapshot,hold_expires_at,idempotency_key,correlation_id)
      VALUES ($1,$2,$3,$4,$5,'construction','2030-08-21',$6,'guest_link',$7,'9009','Guest','GST','14:30',now()+interval '30 minutes','guest-key','guest-correlation')`,
    [profile, ids.request, ids.community, ids.window, ids.date, ids.slot, ids.share]);
    await client.query("INSERT INTO booking_approval_request_answers (game_profile,request_id,requirement_code,raw_value,numeric_value,unit,display_label) VALUES ($1,$2,'fc','50',50,'items','Fire Crystals')", [profile, ids.request]);
    await client.query(`INSERT INTO booking_outbox
      (game_profile,id,community_id,event_type,payload,idempotency_key,correlation_id)
      VALUES ($1,$2,$3,'booking.created',$4,'booking.created:test','correlation'),
             ($1,$5,$3,'booking.approval.requested',$6,'booking.approval.requested:test','guest-correlation')`,
    [profile, randomUUID(), ids.community, { bookingId: ids.booking }, randomUUID(), { requestId: ids.request }]);
  });
  return ids;
}

test("migration 0006 preserves existing booking and multi-copy approval delivery state",
  { skip: !databaseUrl && "TEST_DATABASE_URL is not configured" }, async () => {
    const schema = `discord_upgrade_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    try {
      const migrations = await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url)));
      await runMigrations(pool, migrations.slice(0, 5));
      const ids = await seedProfile(pool, "wos", "9999");
      await withProfile(pool, "wos", async (client) => {
        for (const [index, guildId] of ["100000000000000001", "100000000000000002"].entries()) {
          await client.query(`INSERT INTO booking_approval_discord_messages
            (game_profile,id,community_id,request_id,discord_guild_id,discord_channel_id,
             discord_message_id,recipient_discord_user_id,delivery_status,sent_at)
            VALUES ('wos',$1,$2,$3,$4,$5,$6,'400000000000000001','sent',now())`,
          [randomUUID(), ids.community, ids.request, guildId,
           `50000000000000000${index + 1}`, `60000000000000000${index + 1}`]);
        }
      });
      assert.deepEqual((await runMigrations(pool, migrations)).applied,
        ["0006", "0007", "0008"]);
      const preserved = await withProfile(pool, "wos", client => client.query(`SELECT
        (SELECT count(*)::int FROM minister_bookings WHERE id=$1) AS bookings,
        (SELECT count(*)::int FROM booking_approval_requests WHERE id=$2) AS requests,
        (SELECT count(*)::int FROM booking_approval_discord_messages WHERE request_id=$2) AS message_copies,
        (SELECT count(*)::int FROM booking_outbox) AS outbox`, [ids.booking, ids.request]));
      assert.deepEqual(preserved.rows[0], { bookings: 1, requests: 1, message_copies: 2, outbox: 2 });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

test("durable Discord work is profile-isolated, deduplicated, retryable and reminder-safe in PostgreSQL",
  { skip: !databaseUrl && "TEST_DATABASE_URL is not configured" }, async () => {
    const schema = `discord_booking_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const runtimeRole = `discord_runtime_${randomUUID().replaceAll("-", "")}`;
    const runtimePassword = `pw_${randomUUID()}`;
    let runtimePool;
    try {
      await runMigrations(pool, await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url))));
      const wos = await seedProfile(pool, "wos", "9999");
      await seedProfile(pool, "kingshot", "9999");
      await admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
      for (const sql of runtimePrivilegeStatements(runtimeRole)) await pool.query(sql);
      const runtimeUrl = new URL(databaseUrl);
      runtimeUrl.username = runtimeRole; runtimeUrl.password = runtimePassword;
      runtimePool = new pg.Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${schema}` });
      const role = await runtimePool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
      assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
      const privileges = await runtimePool.query(`SELECT
        has_table_privilege(current_user,'booking_discord_notifications','DELETE') AS queue_delete,
        has_table_privilege(current_user,'booking_integration_nonces','UPDATE') AS nonce_update`);
      assert.deepEqual(privileges.rows[0], { queue_delete: false, nonce_update: false });
      const repository = createDiscordIntegrationRepository("wos", runtimePool);
      const claimed = await repository.withTransaction(session => session.claim(10));
      assert.deepEqual(new Set(claimed.map(item => item.type)), new Set(["player_confirmed", "manager_discovery"]));
      assert.ok(claimed.every(item => item.profile === "wos"));
      const discovery = claimed.find(item => item.type === "manager_discovery");
      assert.equal(discovery.guilds.length, 2);
      assert.equal(await repository.withTransaction(session => session.registerRecipients(
        discovery.workId, discovery.claimToken, [
          { discordUserId: "400000000000000001", sourceGuildId: "100000000000000001" },
          { discordUserId: "400000000000000001", sourceGuildId: "100000000000000002" },
          { discordUserId: "400000000000000002", sourceGuildId: "100000000000000002" },
        ],
      )), true);
      const player = claimed.find(item => item.type === "player_confirmed");
      await repository.withTransaction(session => session.finish(player.workId, player.claimToken,
        { status: "permanent_failure", errorCode: "dm_forbidden" }));
      const simultaneous = await Promise.all([
        repository.withTransaction(session => session.claim(1)),
        repository.withTransaction(session => session.claim(1)),
      ]);
      const managerJobs = simultaneous.flat().filter(item => item.type === "manager_request");
      assert.equal(managerJobs.length, 2);
      assert.equal(new Set(managerJobs.map(item => item.workId)).size, 2);
      for (const [index, job] of managerJobs.entries()) await repository.withTransaction(session => session.finish(
        job.workId, job.claimToken,
        { status: "sent", discordChannelId: `50000000000000000${index + 1}`, discordMessageId: `60000000000000000${index + 1}` },
      ));
      await withProfile(pool, "wos", async (client) => {
        await client.query(`UPDATE booking_approval_requests
          SET status='denied',decided_at=now(),decided_by_discord_user_id='400000000000000002',
              decided_by_display_name='Jenn',version=version+1,updated_at=now()
          WHERE game_profile='wos' AND id=$1`, [wos.request]);
        await client.query("UPDATE booking_approval_discord_messages SET delivery_status='update_pending' WHERE game_profile='wos' AND request_id=$1", [wos.request]);
        await client.query(`INSERT INTO booking_outbox
          (game_profile,id,community_id,event_type,payload,idempotency_key,correlation_id)
          VALUES ('wos',$1,$2,'booking.approval.denied',$3,'approval-denied:test','denial-correlation')`,
        [randomUUID(), wos.community, { requestId: wos.request }]);
      });
      const finalCopies = (await repository.withTransaction(session => session.claim(10)))
        .filter(item => item.type === "manager_update");
      assert.equal(finalCopies.length, 2);
      assert.ok(finalCopies.every(item => item.status === "denied" && item.decidedByDisplayName === "Jenn"));
      const finalCopy = finalCopies[0];
      await repository.withTransaction(session => session.finish(finalCopy.workId, finalCopy.claimToken,
        { status: "retry", errorCode: "temporary_edit_failure" }));
      await repository.withTransaction(session => session.finish(finalCopies[1].workId, finalCopies[1].claimToken,
        { status: "sent", discordChannelId: finalCopies[1].discordChannelId,
          discordMessageId: finalCopies[1].discordMessageId }));
      const editState = await withProfile(pool, "wos", client => client.query(
        "SELECT status,last_error_code FROM booking_discord_notifications WHERE id=$1", [finalCopy.workId]));
      assert.deepEqual(editState.rows[0], { status: "retry", last_error_code: "temporary_edit_failure" });
      const state = await withProfile(pool, "wos", client => client.query(
        "SELECT status FROM minister_bookings WHERE id=$1", [wos.booking]));
      assert.equal(state.rows[0].status, "confirmed");
      const rows = await withProfile(pool, "wos", client => client.query(
        "SELECT notification_type,status,recipient_discord_user_id FROM booking_discord_notifications ORDER BY notification_type"));
      assert.equal(rows.rows.find(row => row.notification_type === "player_confirmed").status, "permanent_failure");
      assert.equal(rows.rows.filter(row => row.notification_type === "appointment_reminder").length, 1);

      const replacement = { slot: randomUUID(), booking: randomUUID() };
      await withProfile(pool, "wos", async (client) => {
        await client.query(`INSERT INTO appointment_slots
          (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,ordinal,display_time_label,local_start_time,time_zone)
          VALUES ('wos',$1,$2,$3,$4,'construction','2030-08-21',1,'15:00','15:00','UTC')`,
        [replacement.slot, wos.community, wos.window, wos.date]);
        await client.query(`INSERT INTO booking_idempotency_keys
          (game_profile,community_id,idempotency_key,operation,request_hash,correlation_id,status)
          VALUES ('wos',$1,'reschedule-key','booking_reschedule',$2,'reschedule-correlation','completed')`,
        [wos.community, "d".repeat(64)]);
        await client.query("UPDATE minister_bookings SET status='replaced',cancelled_at=now(),cancellation_reason='rescheduled',updated_at=now() WHERE game_profile='wos' AND id=$1", [wos.booking]);
        await client.query(`INSERT INTO minister_bookings
          (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,slot_id,participant_id,discord_user_id,
           player_id_snapshot,in_game_name_snapshot,alliance_snapshot,display_time_label_snapshot,source,actor_type,actor_id,
           idempotency_key,correlation_id,rescheduled_from_booking_id)
          VALUES ('wos',$1,$2,$3,$4,'construction','2030-08-21',$5,$6,'300000000000000001',
            '8008','Player','ABC','15:00','website','discord_user','300000000000000001','reschedule-key','reschedule-correlation',$7)`,
        [replacement.booking, wos.community, wos.window, wos.date, replacement.slot, wos.participant, wos.booking]);
        await client.query(`INSERT INTO booking_outbox
          (game_profile,id,community_id,event_type,payload,idempotency_key,correlation_id)
          VALUES ('wos',$1,$2,'booking.rescheduled',$3,'booking.rescheduled:test','reschedule-correlation')`,
        [randomUUID(), wos.community, { bookingId: replacement.booking, replacesBookingId: wos.booking }]);
      });
      const reschedule = (await repository.withTransaction(session => session.claim(10)))
        .find(item => item.type === "player_rescheduled");
      assert.equal(reschedule.previousTime, "14:30");
      assert.equal(reschedule.time, "15:00");
      assert.equal(new Date(reschedule.previousAppointmentAt).toISOString(), "2030-08-21T14:30:00.000Z");
      assert.equal(new Date(reschedule.appointmentAt).toISOString(), "2030-08-21T15:00:00.000Z");
      let reminders = await withProfile(pool, "wos", client => client.query(
        "SELECT booking_id,status FROM booking_discord_notifications WHERE notification_type='appointment_reminder' ORDER BY created_at"));
      assert.deepEqual(reminders.rows.map(row => row.status), ["superseded", "pending"]);
      await withProfile(pool, "wos", async (client) => {
        await client.query("UPDATE minister_bookings SET status='cancelled',cancelled_at=now(),cancellation_reason='cancelled_by_user',updated_at=now() WHERE game_profile='wos' AND id=$1", [replacement.booking]);
        await client.query(`INSERT INTO booking_outbox
          (game_profile,id,community_id,event_type,payload,idempotency_key,correlation_id)
          VALUES ('wos',$1,$2,'booking.cancelled',$3,'booking.cancelled:test','cancel-correlation')`,
        [randomUUID(), wos.community, { bookingId: replacement.booking }]);
      });
      const cancellation = (await repository.withTransaction(session => session.claim(10)))
        .find(item => item.type === "player_cancelled");
      assert.equal(cancellation.time, "15:00");
      assert.equal(new Date(cancellation.appointmentAt).toISOString(), "2030-08-21T15:00:00.000Z");
      reminders = await withProfile(pool, "wos", client => client.query(
        "SELECT status FROM booking_discord_notifications WHERE notification_type='appointment_reminder' ORDER BY created_at"));
      assert.deepEqual(reminders.rows.map(row => row.status), ["superseded", "superseded"]);
      const other = await withProfile(pool, "kingshot", client => client.query(
        "SELECT count(*)::int AS count FROM booking_discord_notifications WHERE game_profile='kingshot'"));
      assert.equal(other.rows[0].count, 0);
      const hidden = await withProfile(runtimePool, "wos", client => client.query(
        "SELECT count(*)::int AS count FROM booking_outbox WHERE game_profile='kingshot'"));
      assert.equal(hidden.rows[0].count, 0);
      const nonceFirst = await repository.withTransaction(session => session.consumeNonce("nonce-value-123456789", new Date(Date.now() + 60_000)));
      const nonceReplay = await repository.withTransaction(session => session.consumeNonce("nonce-value-123456789", new Date(Date.now() + 60_000)));
      assert.equal(nonceFirst, true); assert.equal(nonceReplay, false);
    } finally {
      if (runtimePool) await runtimePool.end();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.query(`DROP OWNED BY ${runtimeRole}`);
      await admin.query(`DROP ROLE ${runtimeRole}`);
      await admin.end();
    }
  });
