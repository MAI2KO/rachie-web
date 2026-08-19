const GAME_PROFILES = new Set(["wos", "kingshot"]);

function assertGameProfile(gameProfile) {
  if (!GAME_PROFILES.has(gameProfile)) {
    throw new TypeError("Unsupported authentication game profile.");
  }
}

class ProfileScopedAuthSession {
  constructor(client, gameProfile) {
    this.client = client;
    this.gameProfile = gameProfile;
  }

  async createOAuthState(stateHash, expiresAt) {
    await this.client.query(
      `DELETE FROM website_oauth_states
       WHERE game_profile = $1 AND expires_at <= now()`,
      [this.gameProfile],
    );
    await this.client.query(
      `INSERT INTO website_oauth_states (game_profile, state_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [this.gameProfile, stateHash, expiresAt],
    );
  }

  async consumeOAuthState(stateHash) {
    const result = await this.client.query(
      `DELETE FROM website_oauth_states
       WHERE game_profile = $1
         AND state_hash = $2
         AND expires_at > now()
       RETURNING state_hash`,
      [this.gameProfile, stateHash],
    );
    return result.rowCount === 1;
  }

  async createSession({ tokenHash, expiresAt, user, guildIds }) {
    await this.client.query(
      `INSERT INTO website_discord_identities
         (game_profile, discord_user_id, username, global_name, avatar_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (game_profile, discord_user_id) DO UPDATE SET
         username = EXCLUDED.username,
         global_name = EXCLUDED.global_name,
         avatar_hash = EXCLUDED.avatar_hash,
         updated_at = now()`,
      [
        this.gameProfile,
        user.id,
        user.username,
        user.globalName,
        user.avatarHash,
      ],
    );
    await this.client.query(
      `INSERT INTO website_auth_sessions
         (game_profile, token_hash, discord_user_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [this.gameProfile, tokenHash, user.id, expiresAt],
    );

    const matches = await this.client.query(
      `INSERT INTO website_auth_session_communities
         (game_profile, session_token_hash, community_id, discord_guild_id)
       SELECT guild.game_profile, $2, guild.community_id, guild.discord_guild_id
       FROM booking_discord_guilds AS guild
       JOIN booking_communities AS community
         ON community.game_profile = guild.game_profile
        AND community.id = guild.community_id
       WHERE guild.game_profile = $1
         AND guild.discord_guild_id = ANY($3::text[])
         AND community.status = 'active'
       ON CONFLICT (game_profile, session_token_hash, community_id) DO NOTHING
       RETURNING community_id`,
      [this.gameProfile, tokenHash, guildIds],
    );

    if (matches.rowCount === 1) {
      await this.client.query(
        `INSERT INTO website_auth_session_selection
           (game_profile, session_token_hash, community_id)
         VALUES ($1, $2, $3)`,
        [this.gameProfile, tokenHash, matches.rows[0].community_id],
      );
    }
  }

  async findSession(tokenHash) {
    const sessionResult = await this.client.query(
      `UPDATE website_auth_sessions AS session
       SET last_seen_at = now()
       FROM website_discord_identities AS identity
       WHERE session.game_profile = $1
         AND session.token_hash = $2
         AND session.revoked_at IS NULL
         AND session.expires_at > now()
         AND identity.game_profile = session.game_profile
         AND identity.discord_user_id = session.discord_user_id
       RETURNING session.discord_user_id, session.expires_at,
                 identity.username, identity.global_name, identity.avatar_hash`,
      [this.gameProfile, tokenHash],
    );
    if (sessionResult.rowCount !== 1) return null;

    const communities = await this.client.query(
      `SELECT community.id, community.location_code, community.display_name,
              session_community.discord_guild_id,
              session_community.verified_at,
              (selection.community_id IS NOT NULL) AS selected
       FROM website_auth_session_communities AS session_community
       JOIN booking_communities AS community
         ON community.game_profile = session_community.game_profile
        AND community.id = session_community.community_id
       LEFT JOIN website_auth_session_selection AS selection
         ON selection.game_profile = session_community.game_profile
        AND selection.session_token_hash = session_community.session_token_hash
        AND selection.community_id = session_community.community_id
       WHERE session_community.game_profile = $1
         AND session_community.session_token_hash = $2
         AND community.status = 'active'
       ORDER BY community.location_code, community.id`,
      [this.gameProfile, tokenHash],
    );

    const identity = sessionResult.rows[0];
    return {
      user: {
        id: identity.discord_user_id,
        username: identity.username,
        globalName: identity.global_name,
        avatarHash: identity.avatar_hash,
      },
      expiresAt: identity.expires_at,
      communities: communities.rows.map((row) => ({
        id: row.id,
        locationCode: row.location_code,
        displayName: row.display_name,
        discordGuildId: row.discord_guild_id,
        verifiedAt: row.verified_at,
        selected: row.selected,
      })),
    };
  }

  async selectCommunity(tokenHash, locationCode) {
    const result = await this.client.query(
      `INSERT INTO website_auth_session_selection
         (game_profile, session_token_hash, community_id, selected_at)
       SELECT session_community.game_profile,
              session_community.session_token_hash,
              session_community.community_id,
              now()
       FROM website_auth_session_communities AS session_community
       JOIN website_auth_sessions AS session
         ON session.game_profile = session_community.game_profile
        AND session.token_hash = session_community.session_token_hash
       JOIN booking_communities AS community
         ON community.game_profile = session_community.game_profile
        AND community.id = session_community.community_id
       WHERE session_community.game_profile = $1
         AND session_community.session_token_hash = $2
         AND community.location_code = $3
         AND community.status = 'active'
         AND session.revoked_at IS NULL
         AND session.expires_at > now()
       ON CONFLICT (game_profile, session_token_hash) DO UPDATE SET
         community_id = EXCLUDED.community_id,
         selected_at = EXCLUDED.selected_at
       RETURNING community_id`,
      [this.gameProfile, tokenHash, locationCode],
    );
    return result.rowCount === 1;
  }

  async revokeSession(tokenHash) {
    const result = await this.client.query(
      `UPDATE website_auth_sessions
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE game_profile = $1 AND token_hash = $2
       RETURNING token_hash`,
      [this.gameProfile, tokenHash],
    );
    return result.rowCount === 1;
  }
}

export function createProfileScopedAuthRepository(gameProfile, pool) {
  assertGameProfile(gameProfile);

  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.game_profile', $1, true)", [
        gameProfile,
      ]);
      const result = await work(new ProfileScopedAuthSession(client, gameProfile));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    gameProfile,
    withTransaction,
    createOAuthState(stateHash, expiresAt) {
      return withTransaction((session) =>
        session.createOAuthState(stateHash, expiresAt),
      );
    },
    consumeOAuthState(stateHash) {
      return withTransaction((session) => session.consumeOAuthState(stateHash));
    },
    createSession(data) {
      return withTransaction((session) => session.createSession(data));
    },
    findSession(tokenHash) {
      return withTransaction((session) => session.findSession(tokenHash));
    },
    selectCommunity(tokenHash, locationCode) {
      return withTransaction((session) =>
        session.selectCommunity(tokenHash, locationCode),
      );
    },
    revokeSession(tokenHash) {
      return withTransaction((session) => session.revokeSession(tokenHash));
    },
  });
}
