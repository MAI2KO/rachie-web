import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import {
  BookingMembershipRefreshRequiredError,
  resolveAuthenticatedBookingContextCore,
} from "../server/auth/authenticated-booking-context-core.mjs";
import {
  loadMigrations,
  runMigrations,
} from "../server/database/migrations.mjs";
import { createProfileScopedAuthRepository } from "../server/auth/repository-core.mjs";
import { createRateLimiter } from "../server/rate-limit/limiter-core.mjs";
import { createProfileScopedRateLimitRepository } from "../server/rate-limit/repository-core.mjs";

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();

async function withProfile(pool, gameProfile, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile', $1, true)", [
      gameProfile,
    ]);
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

function sessionInput(tokenHash, userId, guildIds) {
  return {
    tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    user: {
      id: userId,
      username: `${userId}-name`,
      globalName: null,
      avatarHash: null,
    },
    guildIds,
  };
}

test(
  "Discord authentication persistence is profile-isolated in PostgreSQL",
  { skip: !testDatabaseUrl && "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const schema = `auth_test_${randomUUID().replaceAll("-", "")}`;
    const runtimeRole = `auth_runtime_${randomUUID().replaceAll("-", "")}`;
    const runtimePassword = `test_${randomUUID()}`;
    const adminPool = new pg.Pool({ connectionString: testDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const migrationPool = new pg.Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schema}`,
    });
    let runtimePool;

    try {
      const migrations = await loadMigrations(
        fileURLToPath(new URL("../db/migrations/", import.meta.url)),
      );
      const migrationResult = await runMigrations(migrationPool, migrations);
      assert.deepEqual(migrationResult.applied, ["0001", "0002", "0003", "0004"]);

      await adminPool.query(
        `CREATE ROLE ${runtimeRole}
         LOGIN PASSWORD '${runtimePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      await adminPool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
      await adminPool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE
         ON ALL TABLES IN SCHEMA ${schema} TO ${runtimeRole}`,
      );
      const runtimeDatabaseUrl = new URL(testDatabaseUrl);
      runtimeDatabaseUrl.username = runtimeRole;
      runtimeDatabaseUrl.password = runtimePassword;
      runtimePool = new pg.Pool({
        connectionString: runtimeDatabaseUrl.toString(),
        options: `-c search_path=${schema}`,
      });

      const roleShape = await runtimePool.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      assert.deepEqual(roleShape.rows, [
        { rolsuper: false, rolbypassrls: false },
      ]);

      const wosOne = randomUUID();
      const wosTwo = randomUUID();
      const kingshotOne = randomUUID();
      await withProfile(runtimePool, "wos", async (client) => {
        await client.query(
          `INSERT INTO booking_communities
             (game_profile, id, location_code, display_name)
           VALUES ('wos', $1, '1001', 'State 1001'),
                  ('wos', $2, '1002', 'State 1002')`,
          [wosOne, wosTwo],
        );
        await client.query(
          `INSERT INTO booking_discord_guilds
             (game_profile, discord_guild_id, community_id, discord_guild_name)
           VALUES ('wos', 'wos-guild-one', $1, 'WOS One'),
                  ('wos', 'wos-guild-two', $2, 'WOS Two')`,
          [wosOne, wosTwo],
        );
      });
      await withProfile(runtimePool, "kingshot", async (client) => {
        await client.query(
          `INSERT INTO booking_communities
             (game_profile, id, location_code, display_name)
           VALUES ('kingshot', $1, '2001', 'Kingdom 2001')`,
          [kingshotOne],
        );
        await client.query(
          `INSERT INTO booking_discord_guilds
             (game_profile, discord_guild_id, community_id, discord_guild_name)
           VALUES ('kingshot', 'kingshot-guild-one', $1, 'Kingshot One')`,
          [kingshotOne],
        );
      });

      const wos = createProfileScopedAuthRepository("wos", runtimePool);
      const kingshot = createProfileScopedAuthRepository("kingshot", runtimePool);
      const wosRateLimits = createProfileScopedRateLimitRepository(
        "wos",
        runtimePool,
      );
      const kingshotRateLimits = createProfileScopedRateLimitRepository(
        "kingshot",
        runtimePool,
      );

      await t.test("OAuth states are one-use, expiring, and profile-bound", async () => {
        const stateHash = "a".repeat(64);
        await wos.createOAuthState(stateHash, new Date(Date.now() + 60_000));
        assert.equal(await kingshot.consumeOAuthState(stateHash), false);
        assert.equal(await wos.consumeOAuthState(stateHash), true);
        assert.equal(await wos.consumeOAuthState(stateHash), false);

        const expiredHash = "b".repeat(64);
        await withProfile(runtimePool, "wos", (client) =>
          client.query(
            `INSERT INTO website_oauth_states
               (game_profile, state_hash, created_at, expires_at)
             VALUES ('wos', $1, now() - interval '2 hours', now() - interval '1 hour')`,
            [expiredHash],
          ),
        );
        assert.equal(await wos.consumeOAuthState(expiredHash), false);
      });

      await t.test("guild matches yield zero, one, or explicit multi-selection", async () => {
        const zeroHash = "c".repeat(64);
        const oneHash = "d".repeat(64);
        const multiHash = "e".repeat(64);
        await wos.createSession(sessionInput(zeroHash, "user-zero", []));
        await wos.createSession(
          sessionInput(oneHash, "user-one", ["wos-guild-one"]),
        );
        await wos.createSession(
          sessionInput(multiHash, "user-multi", [
            "wos-guild-one",
            "wos-guild-two",
            "kingshot-guild-one",
          ]),
        );

        assert.deepEqual((await wos.findSession(zeroHash)).communities, []);
        const one = await wos.findSession(oneHash);
        assert.equal(one.communities.length, 1);
        assert.equal(one.communities[0].selected, true);
        const multiple = await wos.findSession(multiHash);
        assert.equal(multiple.communities.length, 2);
        assert.ok(multiple.communities.every((community) => !community.selected));
        assert.equal(await wos.selectCommunity(multiHash, "2001"), false);
        assert.equal(await wos.selectCommunity(multiHash, "1002"), true);
        assert.equal(
          (await wos.findSession(multiHash)).communities.find(
            (community) => community.selected,
          ).locationCode,
          "1002",
        );
      });

      await t.test("copied session hashes cannot cross profiles", async () => {
        const sharedHash = "f".repeat(64);
        await wos.createSession(
          sessionInput(sharedHash, "wos-user", ["wos-guild-one"]),
        );
        assert.equal(await kingshot.findSession(sharedHash), null);
        await kingshot.createSession(
          sessionInput(sharedHash, "kingshot-user", ["kingshot-guild-one"]),
        );
        assert.equal((await wos.findSession(sharedHash)).user.id, "wos-user");
        assert.equal(
          (await kingshot.findSession(sharedHash)).user.id,
          "kingshot-user",
        );
      });

      await t.test("trusted booking context uses the persisted selected community", async () => {
        const wosHash = "3".repeat(64);
        const kingshotHash = "4".repeat(64);
        await wos.createSession(
          sessionInput(wosHash, "context-wos-user", ["wos-guild-one"]),
        );
        await kingshot.createSession(
          sessionInput(kingshotHash, "context-kingshot-user", [
            "kingshot-guild-one",
          ]),
        );

        async function resolve(profile, tokenHash) {
          return resolveAuthenticatedBookingContextCore(
            new Request(
              `http://example/api/v1/booking/context?game_profile=${
                profile === "wos" ? "kingshot" : "wos"
              }&community_id=hostile`,
            ),
            {
              resolveHostContext: () => ({
                brand: { game: { profile } },
                hostname: profile === "wos" ? "localhost" : "peggie.localhost",
                gameProfile: profile,
              }),
              readSessionToken: () => tokenHash,
              hashSessionToken: (value) => value,
              createAuthRepository: (repositoryProfile) =>
                repositoryProfile === "wos" ? wos : kingshot,
            },
          );
        }

        const wosContext = await resolve("wos", wosHash);
        const kingshotContext = await resolve("kingshot", kingshotHash);
        assert.equal(wosContext.discordUser.id, "context-wos-user");
        assert.equal(wosContext.community.id, wosOne);
        assert.equal(wosContext.community.discordGuildId, "wos-guild-one");
        assert.equal(kingshotContext.discordUser.id, "context-kingshot-user");
        assert.equal(kingshotContext.community.id, kingshotOne);

        await withProfile(runtimePool, "wos", (client) =>
          client.query(
            `UPDATE website_auth_session_communities
             SET verified_at = now() - interval '31 minutes'
             WHERE session_token_hash = $1`,
            [wosHash],
          ),
        );
        await assert.rejects(
          resolve("wos", wosHash),
          BookingMembershipRefreshRequiredError,
        );
      });

      await t.test("forced RLS hides auth rows and logout revokes server state", async () => {
        const tokenHash = "1".repeat(64);
        await wos.createSession(
          sessionInput(tokenHash, "logout-user", ["wos-guild-one"]),
        );
        const wosRows = await withProfile(runtimePool, "wos", (client) =>
          client.query("SELECT game_profile FROM website_auth_sessions"),
        );
        assert.ok(wosRows.rows.every((row) => row.game_profile === "wos"));
        const kingshotRows = await withProfile(
          runtimePool,
          "kingshot",
          (client) => client.query("SELECT game_profile FROM website_auth_sessions"),
        );
        assert.ok(
          kingshotRows.rows.every((row) => row.game_profile === "kingshot"),
        );
        assert.equal(await wos.revokeSession(tokenHash), true);
        assert.equal(await wos.findSession(tokenHash), null);

        const expiredHash = "2".repeat(64);
        await withProfile(runtimePool, "wos", async (client) => {
          await client.query(
            `INSERT INTO website_discord_identities
               (game_profile, discord_user_id, username)
             VALUES ('wos', 'expired-user', 'expired-name')`,
          );
          await client.query(
            `INSERT INTO website_auth_sessions
               (game_profile, token_hash, discord_user_id, created_at,
                last_seen_at, expires_at)
             VALUES ('wos', $1, 'expired-user', now() - interval '2 hours',
                     now() - interval '2 hours', now() - interval '1 hour')`,
            [expiredHash],
          );
        });
        assert.equal(await wos.findSession(expiredHash), null);
      });

      await t.test("rate limits are atomic and profile-isolated", async () => {
        const fixedNow = new Date("2026-08-19T12:00:30.000Z");
        const policy = { code: "integration", limit: 2, windowSeconds: 60 };
        const wosLimiter = createRateLimiter({
          gameProfile: "wos",
          repository: wosRateLimits,
          secret: "r".repeat(32),
          now: () => fixedNow,
        });
        const kingshotLimiter = createRateLimiter({
          gameProfile: "kingshot",
          repository: kingshotRateLimits,
          secret: "r".repeat(32),
          now: () => fixedNow,
        });
        const attempts = await Promise.all([
          wosLimiter.consume(policy, "same-subject"),
          wosLimiter.consume(policy, "same-subject"),
          wosLimiter.consume(policy, "same-subject"),
        ]);
        assert.equal(attempts.filter((attempt) => attempt.allowed).length, 2);
        assert.equal(attempts.filter((attempt) => !attempt.allowed).length, 1);
        assert.equal(
          (await kingshotLimiter.consume(policy, "same-subject")).allowed,
          true,
        );

        const wosRows = await withProfile(runtimePool, "wos", (client) =>
          client.query(
            "SELECT game_profile FROM website_rate_limit_buckets",
          ),
        );
        assert.ok(wosRows.rows.every((row) => row.game_profile === "wos"));
      });
    } finally {
      await runtimePool?.end();
      await migrationPool.end();
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
      await adminPool.end();
    }
  },
);
