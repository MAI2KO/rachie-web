const PROFILES = new Set(["wos", "kingshot"]);
const DISCORD_SNOWFLAKE = /^\d{15,20}$/;

export const STALE_MEMBERSHIP_AGE_SECONDS = 60 * 60;

export class StaleMembershipOperatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StaleMembershipOperatorError";
    this.code = code;
  }
}

function invalidArguments(message) {
  throw new StaleMembershipOperatorError(
    "invalid_arguments",
    `${message}\nUsage: npm run db:stale-membership -- --profile <wos|kingshot> --community <code> --discord-user-id <Discord snowflake>`,
  );
}

export function parseStaleMembershipArguments(argv) {
  const values = { profile: null, communityCode: null, discordUserId: null };
  const flags = new Map([
    ["--profile", "profile"],
    ["--community", "communityCode"],
    ["--discord-user-id", "discordUserId"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const key = flags.get(argv[index]);
    if (!key) invalidArguments(`Unknown argument: ${argv[index]}`);
    if (values[key] !== null) invalidArguments(`${argv[index]} may be supplied only once.`);
    const value = argv[index + 1] ?? null;
    if (!value || value.startsWith("--")) invalidArguments(`${argv[index]} requires a value.`);
    values[key] = value;
    index += 1;
  }

  if (!PROFILES.has(values.profile)) invalidArguments("--profile must be wos or kingshot.");
  if (typeof values.communityCode !== "string" || values.communityCode.length > 32
      || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(values.communityCode)) {
    invalidArguments("--community must contain 1-32 letters, digits, hyphens, or underscores.");
  }
  if (typeof values.discordUserId !== "string" || !DISCORD_SNOWFLAKE.test(values.discordUserId)) {
    invalidArguments("--discord-user-id must be a 15-20 digit Discord snowflake.");
  }

  return Object.freeze(values);
}

async function requireOperatorRole(client) {
  const result = await client.query(
    `SELECT
       has_table_privilege(current_user, 'app_schema_migrations', 'SELECT') AS can_read_migration_ledger,
       has_column_privilege(
         current_user,
         'website_auth_session_communities',
         'verified_at',
         'UPDATE'
       ) AS can_update_membership_evidence`,
  );
  const privileges = result.rows[0];
  if (!privileges?.can_read_migration_ledger || !privileges.can_update_membership_evidence) {
    throw new StaleMembershipOperatorError(
      "insufficient_role",
      "Membership-evidence change refused: DATABASE_URL must use the migration/operator role, not the website runtime role.",
    );
  }
}

export async function makeMembershipEvidenceStale({
  pool,
  profile,
  communityCode,
  discordUserId,
  injectFailureAfterUpdate = false,
}) {
  if (!PROFILES.has(profile)) throw new StaleMembershipOperatorError("invalid_profile", "Profile must be wos or kingshot.");
  if (typeof communityCode !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(communityCode)) {
    throw new StaleMembershipOperatorError("invalid_community", "Community code is invalid.");
  }
  if (typeof discordUserId !== "string" || !DISCORD_SNOWFLAKE.test(discordUserId)) {
    throw new StaleMembershipOperatorError("invalid_discord_user", "Discord user ID must be a 15-20 digit snowflake.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireOperatorRole(client);
    await client.query("SELECT set_config('app.game_profile', $1, true)", [profile]);

    const community = (await client.query(
      `SELECT id
       FROM booking_communities
       WHERE game_profile = $1 AND location_code = $2`,
      [profile, communityCode],
    )).rows[0];
    if (!community) {
      throw new StaleMembershipOperatorError(
        "unknown_community",
        `No ${profile} community exists with code ${communityCode}.`,
      );
    }

    const identity = await client.query(
      `SELECT 1
       FROM website_discord_identities
       WHERE game_profile = $1 AND discord_user_id = $2`,
      [profile, discordUserId],
    );
    if (identity.rowCount !== 1) {
      throw new StaleMembershipOperatorError(
        "unknown_user",
        `No ${profile} Discord identity exists for user ${discordUserId}.`,
      );
    }

    const updated = await client.query(
      `UPDATE website_auth_session_communities AS evidence
       SET verified_at = transaction_timestamp() - make_interval(secs => $4)
       FROM website_auth_sessions AS session
       WHERE evidence.game_profile = $1
         AND evidence.community_id = $2
         AND session.game_profile = evidence.game_profile
         AND session.token_hash = evidence.session_token_hash
         AND session.discord_user_id = $3
         AND session.revoked_at IS NULL
         AND session.expires_at > transaction_timestamp()
       RETURNING evidence.verified_at`,
      [profile, community.id, discordUserId, STALE_MEMBERSHIP_AGE_SECONDS],
    );
    if (updated.rowCount === 0) {
      throw new StaleMembershipOperatorError(
        "missing_membership_evidence",
        `User ${discordUserId} has no active stored membership evidence for ${profile} community ${communityCode}.`,
      );
    }
    if (injectFailureAfterUpdate) throw new Error("Injected stale-membership failure.");

    await client.query("COMMIT");
    return Object.freeze({
      profile,
      communityCode,
      discordUserId,
      recordsUpdated: updated.rowCount,
      verifiedAt: updated.rows[0].verified_at,
    });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export function formatStaleMembershipResult(result) {
  const recordLabel = result.recordsUpdated === 1 ? "record" : "records";
  const verifiedAt = result.verifiedAt instanceof Date
    ? result.verifiedAt.toISOString()
    : new Date(result.verifiedAt).toISOString();
  return [
    `Profile: ${result.profile}`,
    `Community: ${result.communityCode}`,
    `Discord user ID: ${result.discordUserId}`,
    `Membership evidence: ${result.recordsUpdated} active session ${recordLabel} made stale`,
    `Verified at: ${verifiedAt}`,
    "Result: updated",
    "",
  ].join("\n");
}
