import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { hashGuestShareToken } from "../server/booking-approval/domain-core.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { createDiscordIntegrationRepository } from "../server/discord-integration/repository-core.mjs";

const databaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();
const secret = "announcement-repair-integration-secret-123456789";
let nextGuildId = 700000000000000000n;

async function withProfile(pool, profile, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile',$1,true)", [profile]);
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function seedCandidate(pool, profile, { payloadVersion = 1, closed = false } = {}) {
  const ids = { community: randomUUID(), window: randomUUID(), link: randomUUID(),
    notification: randomUUID(), guild: String(++nextGuildId) };
  await withProfile(pool, profile, async (client) => {
    await client.query(`INSERT INTO booking_communities
      (game_profile,id,location_code,display_name,status,bookings_open)
      VALUES ($1,$2,$3,$4,'active',true)`, [profile, ids.community,
      ids.community.slice(0, 8), profile === "wos" ? "Test State" : "Test Kingdom"]);
    await client.query(`INSERT INTO booking_discord_guilds
      (game_profile,discord_guild_id,community_id,discord_guild_name,guild_kind)
      VALUES ($1,$2,$3,'Repair Guild','alliance')`, [profile, ids.guild, ids.community]);
    await client.query(`INSERT INTO booking_windows
      (game_profile,id,community_id,status,opens_at,closes_at,opened_at,created_by_actor_type)
      VALUES ($1,$2,$3,$4,now()-interval '1 day',now()+interval '1 day',
              now()-interval '1 day','system')`,
    [profile, ids.window, ids.community, closed ? "closed" : "open"]);
    await client.query(`INSERT INTO booking_guest_share_links
      (game_profile,id,community_id,token_hash,token_hint,label,expires_at,booking_window_id)
      VALUES ($1,$2,$3,$4,'legacy…hint','Legacy automatic link',now()+interval '1 day',$5)`,
    [profile, ids.link, ids.community, hashGuestShareToken(ids.link), ids.window]);
    await client.query(`INSERT INTO booking_discord_notifications
      (game_profile,id,community_id,notification_type,booking_window_id,guest_share_link_id,
       due_at,idempotency_key,status,sent_at,discord_channel_id,discord_message_id,payload_version)
      VALUES ($1,$2,$3,'booking_window_open',$4,$5,now()-interval '2 hours',$6,
              'sent',now()-interval '2 hours',$7,$8,$9)`,
    [profile, ids.notification, ids.community, ids.window, ids.link,
      `booking-window-open:${ids.window}`, "500000000000000001", "600000000000000001",
      payloadVersion]);
  });
  return ids;
}

test("legacy announcement repair is bounded, profile-isolated, hash-only and idempotent", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const schema = `announcement_repair_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await runMigrations(pool, await loadMigrations(
      fileURLToPath(new URL("../db/migrations/", import.meta.url))));
    const affected = await seedCandidate(pool, "wos");
    await seedCandidate(pool, "kingshot");
    await seedCandidate(pool, "wos", { payloadVersion: 2 });
    await seedCandidate(pool, "wos", { closed: true });
    const repository = createDiscordIntegrationRepository("wos", pool);
    const futureCutoff = new Date(Date.now() + 60_000);
    const pastCutoff = new Date(Date.now() - 24 * 60 * 60_000);

    assert.deepEqual(await repository.withTransaction(session =>
      session.listLegacyAnnouncementRepairs(pastCutoff)), []);
    const candidates = await repository.withTransaction(session =>
      session.listLegacyAnnouncementRepairs(futureCutoff));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].notificationId, affected.notification);
    assert.equal(candidates[0].profile, "wos");
    assert.deepEqual(candidates[0].guilds, [affected.guild]);
    const before = await withProfile(pool, "wos", client => client.query(
      `SELECT count(*)::int AS links,
        (SELECT count(*)::int FROM booking_discord_notifications
          WHERE notification_type='manager_guest_link') AS manager_notifications
       FROM booking_guest_share_links`));
    assert.deepEqual(before.rows[0], { links: 4, manager_notifications: 0 },
      "preview selection performs no mutation");

    const first = await repository.withTransaction(session =>
      session.beginLegacyAnnouncementRepair(affected.notification, secret, futureCutoff));
    assert.match(first.guestPath, /^\/book\/[A-Za-z0-9_-]{43}$/);
    const second = await repository.withTransaction(session =>
      session.beginLegacyAnnouncementRepair(affected.notification, secret, futureCutoff));
    assert.equal(second.guestPath, first.guestPath);
    const state = await withProfile(pool, "wos", client => client.query(
      `SELECT
        (SELECT count(*)::int FROM booking_guest_share_links WHERE community_id=$1) AS links,
        (SELECT count(*)::int FROM booking_guest_share_links
          WHERE community_id=$1 AND revoked_at IS NULL) AS active_links,
        (SELECT count(*)::int FROM booking_guest_share_links
          WHERE community_id=$1 AND token_hash=$2) AS new_hashes,
        (SELECT count(*)::int FROM booking_discord_notifications
          WHERE community_id=$1 AND notification_type='manager_guest_link') AS manager_notifications,
        (SELECT repair_status FROM booking_discord_notifications WHERE id=$3) AS repair_status`,
      [affected.community, hashGuestShareToken(first.guestPath.slice("/book/".length)),
        affected.notification]));
    assert.deepEqual(state.rows[0], { links: 2, active_links: 1, new_hashes: 1,
      manager_notifications: 1, repair_status: "rotated" });
    const stored = await withProfile(pool, "wos", client => client.query(
      "SELECT token_hash,token_hint FROM booking_guest_share_links WHERE community_id=$1 AND revoked_at IS NULL",
      [affected.community]));
    assert.equal(JSON.stringify(stored.rows).includes(first.guestPath.slice(6)), false);

    assert.equal(await repository.withTransaction(session =>
      session.completeLegacyAnnouncementRepair(affected.notification, {
        discordChannelId: "500000000000000009", discordMessageId: "600000000000000009",
      })), true);
    assert.deepEqual(await repository.withTransaction(session =>
      session.listLegacyAnnouncementRepairs(futureCutoff)), []);
    assert.equal(await repository.withTransaction(session =>
      session.completeLegacyAnnouncementRepair(affected.notification, {
        discordChannelId: "500000000000000009", discordMessageId: "600000000000000009",
      })), false);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
