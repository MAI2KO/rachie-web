const GAME_PROFILES = new Set(["wos", "kingshot"]);

export function createProfileScopedRateLimitRepository(gameProfile, pool) {
  if (!GAME_PROFILES.has(gameProfile)) {
    throw new TypeError("Unsupported rate-limit game profile.");
  }

  async function consume({
    policyCode,
    subjectHash,
    windowStartedAt,
    expiresAt,
    cleanupBefore,
    limit,
  }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.game_profile', $1, true)", [
        gameProfile,
      ]);
      await client.query(
        `DELETE FROM website_rate_limit_buckets
         WHERE game_profile = $1 AND expires_at <= $2`,
        [gameProfile, cleanupBefore],
      );
      const result = await client.query(
        `INSERT INTO website_rate_limit_buckets
           (game_profile, policy_code, subject_hash, window_started_at,
            request_count, expires_at)
         VALUES ($1, $2, $3, $4, 1, $5)
         ON CONFLICT (
           game_profile,
           policy_code,
           subject_hash,
           window_started_at
         ) DO UPDATE SET
           request_count = website_rate_limit_buckets.request_count + 1
         WHERE website_rate_limit_buckets.request_count < $6
         RETURNING request_count`,
        [
          gameProfile,
          policyCode,
          subjectHash,
          windowStartedAt,
          expiresAt,
          limit,
        ],
      );
      await client.query("COMMIT");
      return result.rows[0]?.request_count ?? null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ gameProfile, consume });
}
