import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { createProfileScopedAuthRepository } from "../server/auth/repository-core.mjs";
import {
  formatStaleMembershipResult,
  makeMembershipEvidenceStale,
  parseStaleMembershipArguments,
  STALE_MEMBERSHIP_AGE_SECONDS,
  StaleMembershipOperatorError,
} from "../server/bootstrap/stale-membership-operator.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { runtimePrivilegeStatements } from "../server/database/runtime-privileges.mjs";

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();
const discordUserId = "123456789012345678";
const otherDiscordUserId = "223456789012345678";
const identityWithoutEvidenceId = "423456789012345678";
const guildId = "999999999999999999";

function sessionInput(tokenHash, userId) {
  return {
    tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    user: {
      id: userId,
      username: `${userId}-name`,
      globalName: `${userId}-global`,
      avatarHash: "avatar-hash",
    },
    guildIds: [guildId],
  };
}

async function authSnapshot(pool) {
  const result = await pool.query(
    `SELECT
       (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY game_profile, id)
        FROM booking_communities AS row_data) AS communities,
       (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY game_profile, discord_guild_id)
        FROM booking_discord_guilds AS row_data) AS guilds,
       (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY game_profile, discord_user_id)
        FROM website_discord_identities AS row_data) AS identities,
       (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY game_profile, token_hash)
        FROM website_auth_sessions AS row_data) AS sessions,
       (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY game_profile, session_token_hash)
        FROM website_auth_session_selection AS row_data) AS selections`,
  );
  return result.rows[0];
}

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

async function evidence(pool, profile, userId = discordUserId) {
  return (await pool.query(
    `SELECT evidence.game_profile, evidence.session_token_hash,
            evidence.community_id, evidence.discord_guild_id, evidence.verified_at
     FROM website_auth_session_communities AS evidence
     JOIN website_auth_sessions AS session
       ON session.game_profile = evidence.game_profile
      AND session.token_hash = evidence.session_token_hash
     JOIN booking_communities AS community
       ON community.game_profile = evidence.game_profile
      AND community.id = evidence.community_id
     WHERE evidence.game_profile = $1
       AND community.location_code = '9999'
       AND session.discord_user_id = $2
     ORDER BY evidence.session_token_hash`,
    [profile, userId],
  )).rows;
}

function evidenceKey(row) {
  return {
    game_profile: row.game_profile,
    session_token_hash: row.session_token_hash,
    community_id: row.community_id,
    discord_guild_id: row.discord_guild_id,
  };
}

test("stale-membership arguments require profile, community, and Discord snowflake", () => {
  assert.deepEqual(parseStaleMembershipArguments([
    "--profile", "wos",
    "--community", "9999",
    "--discord-user-id", discordUserId,
  ]), { profile: "wos", communityCode: "9999", discordUserId });
  assert.deepEqual(parseStaleMembershipArguments([
    "--discord-user-id", discordUserId,
    "--community", "9999",
    "--profile", "kingshot",
  ]), { profile: "kingshot", communityCode: "9999", discordUserId });

  for (const argv of [
    [],
    ["--profile", "invalid", "--community", "9999", "--discord-user-id", discordUserId],
    ["--profile", "wos", "--community", "9999"],
    ["--profile", "wos", "--community", "bad code", "--discord-user-id", discordUserId],
    ["--profile", "wos", "--community", "9999", "--discord-user-id", "not-a-snowflake"],
  ]) {
    assert.throws(
      () => parseStaleMembershipArguments(argv),
      (error) => error instanceof StaleMembershipOperatorError && error.code === "invalid_arguments",
    );
  }
});

test("stale-membership confirmation is concise and contains no session or database secret", () => {
  const output = formatStaleMembershipResult({
    profile: "wos",
    communityCode: "9999",
    discordUserId,
    recordsUpdated: 1,
    verifiedAt: new Date("2026-08-21T10:00:00.000Z"),
  });
  assert.equal(output,
    `Profile: wos\nCommunity: 9999\nDiscord user ID: ${discordUserId}\nMembership evidence: 1 active session record made stale\nVerified at: 2026-08-21T10:00:00.000Z\nResult: updated\n`);
  assert.doesNotMatch(output, /token_hash|password|database_url|postgresql:/i);
});

test("stale-membership PostgreSQL integration", { skip: !testDatabaseUrl && "TEST_DATABASE_URL is not configured" }, async (t) => {
  const schema = `stale_membership_${randomUUID().replaceAll("-", "")}`;
  const operatorRole = `stale_membership_operator_${randomUUID().replaceAll("-", "")}`;
  const operatorPassword = `pw_${randomUUID()}`;
  const runtimeRole = `stale_membership_runtime_${randomUUID().replaceAll("-", "")}`;
  const runtimePassword = `pw_${randomUUID()}`;
  const adminPool = new pg.Pool({ connectionString: testDatabaseUrl });
  await adminPool.query(
    `CREATE ROLE ${operatorRole} LOGIN PASSWORD '${operatorPassword}'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
  await adminPool.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${operatorRole}`);
  const operatorUrl = new URL(testDatabaseUrl);
  operatorUrl.username = operatorRole;
  operatorUrl.password = operatorPassword;
  const operatorPool = new pg.Pool({ connectionString: operatorUrl.toString(), options: `-c search_path=${schema}` });
  const inspectionPool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
  let runtimePool;

  try {
    await runMigrations(
      operatorPool,
      await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url))),
    );
    assert.deepEqual(
      (await operatorPool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows,
      [{ rolsuper: false, rolbypassrls: false }],
    );
    const communityIds = { wos: randomUUID(), kingshot: randomUUID() };
    for (const profile of ["wos", "kingshot"]) {
      await withProfile(operatorPool, profile, (client) => client.query(
        `INSERT INTO booking_communities
           (game_profile,id,location_code,display_name,status)
         VALUES ($1,$2,'9999',$3,'active')`,
        [profile, communityIds[profile], `${profile} Test Server`],
      ));
      await withProfile(operatorPool, profile, (client) => client.query(
        `INSERT INTO booking_discord_guilds
           (game_profile,discord_guild_id,community_id,discord_guild_name)
         VALUES ($1,$2,$3,'Shared Test Guild')`,
        [profile, guildId, communityIds[profile]],
      ));
      const repository = createProfileScopedAuthRepository(profile, operatorPool);
      await repository.createSession(sessionInput(profile === "wos" ? "1".repeat(64) : "2".repeat(64), discordUserId));
    }
    await createProfileScopedAuthRepository("wos", operatorPool).createSession(
      sessionInput("3".repeat(64), otherDiscordUserId),
    );
    await withProfile(operatorPool, "wos", (client) => client.query(
      `INSERT INTO website_discord_identities
         (game_profile,discord_user_id,username)
       VALUES ('wos',$1,'identity-without-evidence')`,
      [identityWithoutEvidenceId],
    ));

    await adminPool.query(
      `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await adminPool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
    for (const sql of runtimePrivilegeStatements(runtimeRole)) await operatorPool.query(sql);
    const runtimeUrl = new URL(testDatabaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtimePool = new pg.Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${schema}` });

    const unrelatedBefore = await authSnapshot(inspectionPool);
    const wosBefore = await evidence(inspectionPool, "wos");
    const kingshotBefore = await evidence(inspectionPool, "kingshot");
    const otherUserBefore = await evidence(inspectionPool, "wos", otherDiscordUserId);

    await t.test("WOS evidence becomes one hour stale while the same Kingshot code and user stay isolated", async () => {
      const beforeCall = Date.now();
      const result = await makeMembershipEvidenceStale({
        pool: operatorPool,
        profile: "wos",
        communityCode: "9999",
        discordUserId,
      });
      assert.equal(result.recordsUpdated, 1);
      const ageMilliseconds = beforeCall - new Date(result.verifiedAt).getTime();
      assert.ok(ageMilliseconds >= (STALE_MEMBERSHIP_AGE_SECONDS * 1000) - 1000);
      assert.ok(ageMilliseconds <= (STALE_MEMBERSHIP_AGE_SECONDS * 1000) + 5000);
      const wosAfter = await evidence(inspectionPool, "wos");
      assert.deepEqual(
        wosAfter.map(evidenceKey),
        wosBefore.map(evidenceKey),
      );
      assert.deepEqual(await evidence(inspectionPool, "kingshot"), kingshotBefore);
      assert.deepEqual(await evidence(inspectionPool, "wos", otherDiscordUserId), otherUserBefore);
    });

    await t.test("Kingshot evidence can be made stale independently", async () => {
      const result = await makeMembershipEvidenceStale({
        pool: operatorPool,
        profile: "kingshot",
        communityCode: "9999",
        discordUserId,
      });
      assert.equal(result.profile, "kingshot");
      assert.equal(result.recordsUpdated, 1);
      assert.ok(Date.now() - new Date(result.verifiedAt).getTime() >= 59 * 60 * 1000);
    });

    await t.test("unknown communities and users are refused", async () => {
      await assert.rejects(
        makeMembershipEvidenceStale({ pool: operatorPool, profile: "wos", communityCode: "missing", discordUserId }),
        (error) => error instanceof StaleMembershipOperatorError && error.code === "unknown_community",
      );
      await assert.rejects(
        makeMembershipEvidenceStale({ pool: operatorPool, profile: "wos", communityCode: "9999", discordUserId: "323456789012345678" }),
        (error) => error instanceof StaleMembershipOperatorError && error.code === "unknown_user",
      );
      await assert.rejects(
        makeMembershipEvidenceStale({ pool: operatorPool, profile: "wos", communityCode: "9999", discordUserId: identityWithoutEvidenceId }),
        (error) => error instanceof StaleMembershipOperatorError && error.code === "missing_membership_evidence",
      );
    });

    await t.test("the staging-equivalent website runtime role is explicitly refused", async () => {
      const roleState = await runtimePool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
      assert.deepEqual(roleState.rows, [{ rolsuper: false, rolbypassrls: false }]);
      await assert.rejects(
        makeMembershipEvidenceStale({ pool: runtimePool, profile: "wos", communityCode: "9999", discordUserId }),
        (error) => error instanceof StaleMembershipOperatorError && error.code === "insufficient_role",
      );
    });

    await t.test("failure rolls back and unrelated identity, session, selection, community, and guild data stay unchanged", async () => {
      const beforeFailure = await evidence(inspectionPool, "wos");
      await assert.rejects(
        makeMembershipEvidenceStale({
          pool: operatorPool,
          profile: "wos",
          communityCode: "9999",
          discordUserId,
          injectFailureAfterUpdate: true,
        }),
        /Injected stale-membership failure/,
      );
      assert.deepEqual(await evidence(inspectionPool, "wos"), beforeFailure);
      assert.deepEqual(await authSnapshot(inspectionPool), unrelatedBefore);
    });
  } finally {
    await runtimePool?.end();
    await operatorPool.end();
    await inspectionPool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await adminPool.query(`DROP ROLE IF EXISTS ${operatorRole}`);
    await adminPool.end();
  }
});
