import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { createProfileScopedAuthRepository } from "../server/auth/repository-core.mjs";
import { createProfileScopedBookingAdminRepository } from "../server/booking-admin/repository-core.mjs";
import { createBookingAdminService } from "../server/booking-admin/service-core.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";

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

test("owner unlink revokes only source-attributed access and is retry-safe", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const schema = `unlink_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const communityId = randomUUID();
  const stateGuild = "999999999999999999";
  const removedGuild = "111111111111111111";
  const remainingGuild = "222222222222222222";
  const stateOwner = "333333333333333333";
  try {
    await runMigrations(pool, await loadMigrations(
      fileURLToPath(new URL("../db/migrations/", import.meta.url)),
    ));
    await withProfile(pool, "wos", async (client) => {
      await client.query(
        `INSERT INTO booking_communities
           (game_profile,id,location_code,display_name,status)
         VALUES ('wos',$1,'1001','State 1001','active')`,
        [communityId],
      );
      await client.query(
        `INSERT INTO booking_settings (game_profile,community_id) VALUES ('wos',$1)`,
        [communityId],
      );
      for (const [guildId, name, kind] of [
        [stateGuild, "Shared State", "state"],
        [removedGuild, "Alliance One", "alliance"],
        [remainingGuild, "Alliance Two", "alliance"],
      ]) {
        await client.query(
          `INSERT INTO booking_discord_guilds
             (game_profile,discord_guild_id,community_id,discord_guild_name,guild_kind)
           VALUES ('wos',$1,$2,$3,$4)`,
          [guildId, communityId, name, kind],
        );
      }
    });

    const auth = createProfileScopedAuthRepository("wos", pool);
    const expiresAt = new Date("2027-01-01T00:00:00.000Z");
    await auth.createSession({
      tokenHash: "a".repeat(64), expiresAt,
      user: { id: "444444444444444444", username: "both", globalName: null, avatarHash: null },
      guildIds: [removedGuild, remainingGuild, stateGuild],
    });
    await auth.createSession({
      tokenHash: "b".repeat(64), expiresAt,
      user: { id: "555555555555555555", username: "state-member", globalName: null, avatarHash: null },
      guildIds: [removedGuild, stateGuild],
    });

    const repository = createProfileScopedBookingAdminRepository("wos", pool);
    const service = createBookingAdminService({
      gameProfile: "wos", communityId,
      managerContext: { gameProfile: "wos", authorizedCommunityId: communityId,
        discordUserId: stateOwner, displayName: "State owner" },
      repository,
      verifyGuildOwner: async ({ guildId, discordUserId }) => ({
        status: guildId === stateGuild && discordUserId === stateOwner ? "owner" : "not_owner",
      }),
    });
    const result = await service.unlinkAllianceGuild({
      section: "discordAccess", action: "unlink", guildId: removedGuild, confirmed: true,
    });
    assert.equal(result.unlink.changed, true);
    assert.equal(result.unlink.affectedGrantCount, 2);
    assert.deepEqual(result.configuration.discordAccess.guilds.map(({ id }) => id), [remainingGuild]);

    const access = await withProfile(pool, "wos", async (client) => ({
      grants: (await client.query(
        `SELECT discord_user_id,source_guild_id,status
           FROM community_access_grants WHERE community_id=$1
          ORDER BY discord_user_id,source_guild_id`, [communityId],
      )).rows,
      sessions: (await client.query(
        `SELECT session_token_hash,discord_guild_id
           FROM website_auth_session_communities WHERE community_id=$1
          ORDER BY session_token_hash`, [communityId],
      )).rows,
      audit: (await client.query(
        `SELECT event_type,actor_id,after_data
           FROM booking_change_events WHERE community_id=$1`, [communityId],
      )).rows,
    }));
    assert.deepEqual(access.grants, [
      { discord_user_id: "444444444444444444", source_guild_id: removedGuild, status: "revoked" },
      { discord_user_id: "444444444444444444", source_guild_id: remainingGuild, status: "active" },
      { discord_user_id: "555555555555555555", source_guild_id: removedGuild, status: "revoked" },
    ]);
    assert.deepEqual(access.sessions, [
      { session_token_hash: "a".repeat(64), discord_guild_id: remainingGuild },
    ], "State Discord membership does not replace revoked alliance-origin access");
    assert.equal(access.audit.length, 1);
    assert.equal(access.audit[0].event_type, "alliance_discord_unlinked");
    assert.equal(access.audit[0].actor_id, stateOwner);
    assert.equal(access.audit[0].after_data.affectedGrantCount, 2);

    const retry = await service.unlinkAllianceGuild({
      section: "discordAccess", action: "unlink", guildId: removedGuild, confirmed: true,
    });
    assert.equal(retry.unlink.changed, false);
    assert.equal((await withProfile(pool, "wos", (client) => client.query(
      "SELECT count(*)::int AS count FROM booking_change_events WHERE community_id=$1",
      [communityId],
    ))).rows[0].count, 1);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
