ALTER TABLE booking_discord_guilds
  ADD CONSTRAINT booking_discord_guilds_profile_guild_community_key
  UNIQUE (game_profile, discord_guild_id, community_id);

CREATE TABLE website_oauth_states (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, state_hash),
  CHECK (expires_at > created_at)
);

CREATE INDEX website_oauth_states_expiry
  ON website_oauth_states (expires_at);

CREATE TABLE website_discord_identities (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  discord_user_id text NOT NULL CHECK (btrim(discord_user_id) <> ''),
  username text NOT NULL CHECK (btrim(username) <> ''),
  global_name text,
  avatar_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, discord_user_id)
);

CREATE TABLE website_auth_sessions (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  discord_user_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, token_hash),
  FOREIGN KEY (game_profile, discord_user_id)
    REFERENCES website_discord_identities (game_profile, discord_user_id)
    ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX website_auth_sessions_user_lookup
  ON website_auth_sessions (game_profile, discord_user_id, expires_at);

CREATE INDEX website_auth_sessions_expiry
  ON website_auth_sessions (expires_at);

CREATE TABLE website_auth_session_communities (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  session_token_hash text NOT NULL,
  community_id uuid NOT NULL,
  discord_guild_id text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, session_token_hash, community_id),
  FOREIGN KEY (game_profile, session_token_hash)
    REFERENCES website_auth_sessions (game_profile, token_hash)
    ON DELETE CASCADE,
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id)
    ON DELETE CASCADE,
  FOREIGN KEY (game_profile, discord_guild_id, community_id)
    REFERENCES booking_discord_guilds (
      game_profile,
      discord_guild_id,
      community_id
    ) ON DELETE CASCADE
);

CREATE INDEX website_auth_session_communities_guild_lookup
  ON website_auth_session_communities (
    game_profile,
    discord_guild_id,
    community_id
  );

CREATE TABLE website_auth_session_selection (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  session_token_hash text NOT NULL,
  community_id uuid NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, session_token_hash),
  FOREIGN KEY (game_profile, session_token_hash, community_id)
    REFERENCES website_auth_session_communities (
      game_profile,
      session_token_hash,
      community_id
    ) ON DELETE CASCADE
);

ALTER TABLE website_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY website_oauth_states_profile_policy ON website_oauth_states
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE website_discord_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_discord_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY website_discord_identities_profile_policy ON website_discord_identities
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE website_auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY website_auth_sessions_profile_policy ON website_auth_sessions
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE website_auth_session_communities ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_auth_session_communities FORCE ROW LEVEL SECURITY;
CREATE POLICY website_auth_session_communities_profile_policy ON website_auth_session_communities
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE website_auth_session_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_auth_session_selection FORCE ROW LEVEL SECURITY;
CREATE POLICY website_auth_session_selection_profile_policy ON website_auth_session_selection
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));
