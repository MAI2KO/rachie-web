import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

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

test("0008 upgrades to corrected 0009 conservatively", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const schema = `upgrade_0009_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    const migrations = await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url)));
    await runMigrations(pool, migrations.slice(0, 8));

    const communityId = randomUUID();
    const participantId = randomUUID();
    const guildId = "888888888888888888";
    await withProfile(pool, "wos", async (client) => {
      await client.query(
        `INSERT INTO booking_communities
           (game_profile,id,location_code,display_name,status)
         VALUES ('wos',$1,'9999','Upgrade State','active')`,
        [communityId],
      );
      await client.query(
        `INSERT INTO booking_discord_guilds
           (game_profile,discord_guild_id,community_id,discord_guild_name)
         VALUES ('wos',$1,$2,'Existing guild')`,
        [guildId, communityId],
      );
      for (const [userId, token, state] of [
        ["111111111111111111", "a".repeat(64), "valid"],
        ["222222222222222222", "b".repeat(64), "expired"],
        ["333333333333333333", "c".repeat(64), "revoked"],
      ]) {
        await client.query(
          `INSERT INTO website_discord_identities
             (game_profile,discord_user_id,username)
           VALUES ('wos',$1,$2)`,
          [userId, state],
        );
        await client.query(
          `INSERT INTO website_auth_sessions
             (game_profile,token_hash,discord_user_id,expires_at,revoked_at,created_at)
           VALUES ('wos',$1,$2,
             CASE WHEN $3='expired' THEN now()-interval '1 hour' ELSE now()+interval '1 day' END,
             CASE WHEN $3='revoked' THEN now() ELSE NULL END,
             now()-interval '2 days')`,
          [token, userId, state],
        );
        await client.query(
          `INSERT INTO website_auth_session_communities
             (game_profile,session_token_hash,community_id,discord_guild_id)
           VALUES ('wos',$1,$2,$3)`,
          [token, communityId, guildId],
        );
      }
      const key = `upgrade-participant-${randomUUID()}`;
      await client.query(
        `INSERT INTO booking_idempotency_keys
           (game_profile,community_id,idempotency_key,operation,request_hash,correlation_id,status)
         VALUES ('wos',$1,$2,'test',$3,'upgrade-0009','completed')`,
        [communityId, key, "a".repeat(64)],
      );
      await client.query(
        `INSERT INTO booking_participants
           (game_profile,id,community_id,discord_user_id,player_id,in_game_name,alliance,
            source,idempotency_key,correlation_id)
         VALUES ('wos',$1,$2,'111111111111111111','1001','Existing Player','OLD',
                 'website',$3,'upgrade-0009')`,
        [participantId, communityId, key],
      );
    });

    const result = await runMigrations(pool, migrations.slice(0, 9));
    assert.deepEqual(result.applied, ["0009"]);
    const upgraded = await withProfile(pool, "wos", async (client) => ({
      guild: (await client.query(
        "SELECT guild_kind,link_status FROM booking_discord_guilds WHERE discord_guild_id=$1",
        [guildId],
      )).rows[0],
      grants: (await client.query(
        `SELECT discord_user_id,source_type,status FROM community_access_grants
          WHERE community_id=$1 ORDER BY discord_user_id`,
        [communityId],
      )).rows,
      sessions: Number((await client.query(
        "SELECT count(*)::int AS count FROM website_auth_session_communities WHERE community_id=$1",
        [communityId],
      )).rows[0].count),
      participants: Number((await client.query(
        "SELECT count(*)::int AS count FROM booking_participants WHERE community_id=$1",
        [communityId],
      )).rows[0].count),
      playerPoints: Number((await client.query("SELECT count(*)::int AS count FROM player_points_ledger")).rows[0].count),
      communityPoints: Number((await client.query("SELECT count(*)::int AS count FROM community_points_ledger")).rows[0].count),
    }));
    assert.deepEqual(upgraded.guild, { guild_kind: "unclassified", link_status: "active" });
    assert.deepEqual(upgraded.grants, [{
      discord_user_id: "111111111111111111", source_type: "legacy_session", status: "active",
    }]);
    assert.equal(upgraded.sessions, 3, "migration does not delete historical session-community rows");
    assert.equal(upgraded.participants, 1, "existing participants remain intact");
    assert.equal(upgraded.playerPoints, 0);
    assert.equal(upgraded.communityPoints, 0);
    assert.deepEqual((await runMigrations(pool, migrations.slice(0, 9))).applied, []);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
