import { withDevelopmentTiming } from "../development-timing.mjs";

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

    await this.client.query(
      `WITH matched AS (
         SELECT guild.game_profile,guild.community_id,guild.discord_guild_id,
                CASE guild.guild_kind
                  WHEN 'alliance' THEN 'alliance_discord'
                  ELSE 'legacy_session'
                END AS source_type,
                md5(guild.game_profile || ':' || guild.community_id::text || ':'
                  || $2 || ':' || guild.discord_guild_id) AS digest
           FROM booking_discord_guilds AS guild
           JOIN booking_communities AS community
             ON community.game_profile=guild.game_profile AND community.id=guild.community_id
          WHERE guild.game_profile=$1 AND guild.discord_guild_id=ANY($3::text[])
            AND guild.guild_kind IN ('unclassified','alliance')
            AND guild.link_status='active'
            AND community.status='active'
       )
       INSERT INTO community_access_grants
         (game_profile,id,community_id,discord_user_id,source_guild_id,source_type)
       SELECT game_profile,
              (substr(digest,1,8) || '-' || substr(digest,9,4) || '-5' || substr(digest,14,3)
               || '-8' || substr(digest,18,3) || '-' || substr(digest,21,12))::uuid,
              community_id,$2,discord_guild_id,source_type
         FROM matched
       ON CONFLICT (game_profile,community_id,discord_user_id,source_guild_id) DO UPDATE
         SET status='active',verified_at=now(),revoked_at=NULL,revoked_by_actor_id=NULL,
             revocation_reason=NULL,updated_at=now()`,
      [this.gameProfile, user.id, guildIds],
    );

    const matches = await this.client.query(
      `INSERT INTO website_auth_session_communities
         (game_profile, session_token_hash, community_id, discord_guild_id)
       SELECT DISTINCT ON (guild.community_id)
              guild.game_profile, $2, guild.community_id, guild.discord_guild_id
       FROM community_access_grants AS access
       JOIN booking_discord_guilds AS guild
         ON guild.game_profile=access.game_profile
        AND guild.community_id=access.community_id
        AND guild.discord_guild_id=access.source_guild_id
       JOIN booking_communities AS community
         ON community.game_profile = guild.game_profile
        AND community.id = guild.community_id
       WHERE access.game_profile=$1 AND access.discord_user_id=$4
         AND access.status='active'
         AND guild.discord_guild_id = ANY($3::text[])
         AND guild.link_status='active'
         AND ((access.source_type='alliance_discord' AND guild.guild_kind='alliance')
           OR (access.source_type='legacy_session'
             AND guild.guild_kind IN ('unclassified','state','alliance')))
         AND community.status = 'active'
       ORDER BY guild.community_id,guild.discord_guild_id
       ON CONFLICT (game_profile, session_token_hash, community_id) DO NOTHING
       RETURNING community_id`,
      [this.gameProfile, tokenHash, guildIds, user.id],
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
    const identity = sessionResult.rows[0];

    const communities = await this.client.query(
      `SELECT community.id, community.location_code, community.display_name,
              session_community.discord_guild_id,
              session_community.verified_at,
              (selection.community_id IS NOT NULL) AS selected
       FROM website_auth_session_communities AS session_community
       JOIN community_access_grants AS access
         ON access.game_profile=session_community.game_profile
        AND access.community_id=session_community.community_id
        AND access.source_guild_id=session_community.discord_guild_id
        AND access.discord_user_id=$3
        AND access.status='active'
       JOIN booking_discord_guilds AS guild
         ON guild.game_profile=session_community.game_profile
        AND guild.discord_guild_id=session_community.discord_guild_id
        AND guild.community_id=session_community.community_id
        AND guild.link_status='active'
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
         AND ((access.source_type='alliance_discord' AND guild.guild_kind='alliance')
           OR (access.source_type='legacy_session'
             AND guild.guild_kind IN ('unclassified','state','alliance')))
       ORDER BY community.location_code, community.id`,
      [this.gameProfile, tokenHash, identity.discord_user_id],
    );

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
       JOIN community_access_grants AS access
         ON access.game_profile=session_community.game_profile
        AND access.community_id=session_community.community_id
        AND access.source_guild_id=session_community.discord_guild_id
        AND access.discord_user_id=session.discord_user_id
        AND access.status='active'
       JOIN booking_discord_guilds AS guild
         ON guild.game_profile=session_community.game_profile
        AND guild.discord_guild_id=session_community.discord_guild_id
        AND guild.community_id=session_community.community_id
        AND guild.link_status='active'
       JOIN booking_communities AS community
         ON community.game_profile = session_community.game_profile
        AND community.id = session_community.community_id
       WHERE session_community.game_profile = $1
         AND session_community.session_token_hash = $2
         AND community.location_code = $3
         AND community.status = 'active'
         AND ((access.source_type='alliance_discord' AND guild.guild_kind='alliance')
           OR (access.source_type='legacy_session'
             AND guild.guild_kind IN ('unclassified','state','alliance')))
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

  async refreshSessionCommunityMembership(tokenHash, communityId, discordGuildId) {
    await this.client.query(
      `UPDATE community_access_grants AS access
          SET verified_at=now(),updated_at=now()
         FROM website_auth_sessions AS session, booking_discord_guilds AS guild
        WHERE access.game_profile=$1 AND access.community_id=$3
          AND access.source_guild_id=$4 AND access.status='active'
          AND session.game_profile=access.game_profile AND session.token_hash=$2
          AND session.discord_user_id=access.discord_user_id
          AND guild.game_profile=access.game_profile AND guild.community_id=access.community_id
          AND guild.discord_guild_id=access.source_guild_id
          AND guild.link_status='active'
          AND ((access.source_type='alliance_discord' AND guild.guild_kind='alliance')
            OR (access.source_type='legacy_session'
              AND guild.guild_kind IN ('unclassified','state','alliance')))` ,
      [this.gameProfile, tokenHash, communityId, discordGuildId],
    );
    const result = await this.client.query(
      `UPDATE website_auth_session_communities AS session_community
       SET verified_at = now()
       FROM website_auth_sessions AS session
       WHERE session_community.game_profile = $1
         AND session_community.session_token_hash = $2
         AND session_community.community_id = $3
         AND session_community.discord_guild_id = $4
         AND session.game_profile = session_community.game_profile
         AND session.token_hash = session_community.session_token_hash
         AND session.revoked_at IS NULL
         AND session.expires_at > now()
       RETURNING session_community.verified_at`,
      [this.gameProfile, tokenHash, communityId, discordGuildId],
    );
    return result.rowCount === 1 ? result.rows[0].verified_at : null;
  }

  async revokeSessionCommunityMembership(tokenHash, communityId, discordGuildId) {
    const revoked = await this.client.query(
      `UPDATE community_access_grants AS access
          SET status='revoked',revoked_at=now(),revocation_reason='membership_lost',updated_at=now()
         FROM website_auth_sessions AS session
        WHERE access.game_profile=$1 AND access.community_id=$3 AND access.source_guild_id=$4
          AND access.status='active' AND session.game_profile=access.game_profile
          AND session.token_hash=$2 AND session.discord_user_id=access.discord_user_id
        RETURNING access.discord_user_id`,
      [this.gameProfile, tokenHash, communityId, discordGuildId],
    );
    const discordUserId = revoked.rows[0]?.discord_user_id;
    if (!discordUserId) return false;
    await this.repointOrDeleteSessionCommunityAccess(communityId, discordGuildId, discordUserId);
    return true;
  }

  async repointOrDeleteSessionCommunityAccess(communityId, revokedGuildId, discordUserId) {
    await this.client.query(
      `UPDATE website_auth_session_communities AS session_community
          SET discord_guild_id=replacement.source_guild_id,verified_at=replacement.verified_at
         FROM website_auth_sessions AS session
         CROSS JOIN LATERAL (
           SELECT access.source_guild_id,access.verified_at
             FROM community_access_grants AS access
             JOIN booking_discord_guilds AS guild
               ON guild.game_profile=access.game_profile
              AND guild.community_id=access.community_id
              AND guild.discord_guild_id=access.source_guild_id
            WHERE access.game_profile=$1 AND access.community_id=$2
              AND access.discord_user_id=$4 AND access.status='active'
              AND access.source_guild_id<>$3
              AND guild.guild_kind='alliance' AND guild.link_status='active'
            ORDER BY access.source_guild_id LIMIT 1
         ) AS replacement
        WHERE session_community.game_profile=$1 AND session_community.community_id=$2
          AND session_community.discord_guild_id=$3
          AND session.game_profile=session_community.game_profile
          AND session.token_hash=session_community.session_token_hash
          AND session.discord_user_id=$4`,
      [this.gameProfile, communityId, revokedGuildId, discordUserId],
    );
    await this.client.query(
      `DELETE FROM website_auth_session_communities AS session_community
        USING website_auth_sessions AS session
        WHERE session_community.game_profile=$1 AND session_community.community_id=$2
          AND session_community.discord_guild_id=$3
          AND session.game_profile=session_community.game_profile
          AND session.token_hash=session_community.session_token_hash
          AND session.discord_user_id=$4`,
      [this.gameProfile, communityId, revokedGuildId, discordUserId],
    );
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
    return withDevelopmentTiming(`database auth transaction (${gameProfile})`, async () => {
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
    });
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
    refreshSessionCommunityMembership(tokenHash, communityId, discordGuildId) {
      return withTransaction((session) =>
        session.refreshSessionCommunityMembership(
          tokenHash,
          communityId,
          discordGuildId,
        ),
      );
    },
    revokeSessionCommunityMembership(tokenHash, communityId, discordGuildId) {
      return withTransaction((session) =>
        session.revokeSessionCommunityMembership(
          tokenHash,
          communityId,
          discordGuildId,
        ),
      );
    },
    revokeSession(tokenHash) {
      return withTransaction((session) => session.revokeSession(tokenHash));
    },
  });
}
