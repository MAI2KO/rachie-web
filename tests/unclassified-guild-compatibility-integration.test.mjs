import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { createProfileScopedAllianceEventsRepository } from "../server/alliance-events/repository-core.mjs";
import { resolveAuthenticatedBookingContextCore } from "../server/auth/authenticated-booking-context-core.mjs";
import { createProfileScopedAuthRepository } from "../server/auth/repository-core.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();

async function withProfile(pool, gameProfile, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile',$1,true)", [gameProfile]);
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function sessionInput(tokenHash, userId, guildIds) {
  return {
    tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    user: { id: userId, username: userId, globalName: null, avatarHash: null },
    guildIds,
  };
}

test("active unclassified guilds preserve non-destructive booking and event compatibility",
  { skip: !testDatabaseUrl && "TEST_DATABASE_URL is not configured" }, async () => {
    const schema = `unclassified_compat_${randomUUID().replaceAll("-", "")}`;
    const adminPool = new pg.Pool({ connectionString: testDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schema}`,
    });

    const ids = {
      legacy: randomUUID(), revoked: randomUUID(), alliance: randomUUID(),
      state: randomUUID(), kingshot: randomUUID(),
    };
    const guilds = {
      legacy: "1328967306071769130",
      revoked: "2328967306071769130",
      alliance: "3328967306071769130",
      state: "4328967306071769130",
    };

    try {
      const migrations = await loadMigrations(
        fileURLToPath(new URL("../db/migrations/", import.meta.url)),
      );
      await runMigrations(pool, migrations);

      await withProfile(pool, "wos", async (client) => {
        await client.query(
          `INSERT INTO booking_communities
             (game_profile,id,location_code,display_name)
           VALUES ('wos',$1,'9999','State 9999'),
                  ('wos',$2,'9998','State 9998'),
                  ('wos',$3,'9997','State 9997'),
                  ('wos',$4,'9996','State 9996')`,
          [ids.legacy, ids.revoked, ids.alliance, ids.state],
        );
        await client.query(
          `INSERT INTO booking_discord_guilds
             (game_profile,discord_guild_id,community_id,discord_guild_name,
              guild_kind,link_status,revoked_at)
           VALUES ('wos',$1,$2,'Legacy','unclassified','active',NULL),
                  ('wos',$3,$4,'Revoked legacy','unclassified','revoked',now()),
                  ('wos',$5,$6,'Alliance','alliance','active',NULL),
                  ('wos',$7,$8,'Shared State','state','active',NULL)`,
          [guilds.legacy, ids.legacy, guilds.revoked, ids.revoked,
           guilds.alliance, ids.alliance, guilds.state, ids.state],
        );
      });
      await withProfile(pool, "kingshot", async (client) => {
        await client.query(
          `INSERT INTO booking_communities
             (game_profile,id,location_code,display_name)
           VALUES ('kingshot',$1,'9999','Kingdom 9999')`, [ids.kingshot],
        );
        await client.query(
          `INSERT INTO booking_discord_guilds
             (game_profile,discord_guild_id,community_id,discord_guild_name,guild_kind)
           VALUES ('kingshot',$1,$2,'Same numeric guild','unclassified')`,
          [guilds.legacy, ids.kingshot],
        );
      });

      const wosAuth = createProfileScopedAuthRepository("wos", pool);
      const tokenHash = "a".repeat(64);
      await wosAuth.createSession(sessionInput(tokenHash, "legacy-user", Object.values(guilds)));
      const session = await wosAuth.findSession(tokenHash);
      assert.deepEqual(session.communities.map((item) => item.locationCode), ["9997", "9999"]);
      assert.equal(await wosAuth.selectCommunity(tokenHash, "9999"), true);
      assert.equal((await wosAuth.findSession(tokenHash)).communities
        .find((item) => item.locationCode === "9999").selected, true);
      const bookingContext = await resolveAuthenticatedBookingContextCore(
        new Request("https://r-a-c-h-i-e.com/api/v1/booking/context"), {
          resolveHostContext: () => ({ gameProfile: "wos" }),
          readSessionToken: () => tokenHash,
          hashSessionToken: (value) => value,
          createAuthRepository: () => wosAuth,
        },
      );
      assert.equal(bookingContext.community.id, ids.legacy);
      assert.equal(bookingContext.community.discordGuildId, guilds.legacy);

      const grants = await withProfile(pool, "wos", (client) => client.query(
        `SELECT community_id,source_type,status FROM community_access_grants
          WHERE discord_user_id='legacy-user' ORDER BY community_id`,
      ));
      assert.deepEqual(grants.rows.map((row) => [row.community_id, row.source_type, row.status]),
        [[ids.alliance, "alliance_discord", "active"],
         [ids.legacy, "legacy_session", "active"]].sort());

      const wosEvents = createProfileScopedAllianceEventsRepository("wos", pool);
      const kingshotEvents = createProfileScopedAllianceEventsRepository("kingshot", pool);
      assert.deepEqual((await wosEvents.findCommunityGuilds("9999")).guildIds, [guilds.legacy]);
      assert.deepEqual((await wosEvents.findCommunityGuilds("9998")).guildIds, []);
      assert.deepEqual((await wosEvents.findCommunityGuilds("9997")).guildIds, [guilds.alliance]);
      assert.deepEqual((await wosEvents.findCommunityGuilds("9996")).guildIds, []);
      assert.deepEqual((await kingshotEvents.findCommunityGuilds("9999")).guildIds,
        [guilds.legacy]);

      await withProfile(pool, "wos", (client) => client.query(
        `UPDATE booking_discord_guilds SET guild_kind='state'
          WHERE game_profile='wos' AND discord_guild_id=$1`, [guilds.legacy],
      ));
      assert.deepEqual((await wosEvents.findCommunityGuilds("9999")).guildIds, []);
      assert.equal((await wosAuth.findSession(tokenHash)).communities
        .some((item) => item.locationCode === "9999"), true);
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminPool.end();
    }
  });
