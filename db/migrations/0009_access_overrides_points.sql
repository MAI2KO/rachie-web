ALTER TABLE booking_discord_guilds
  ADD COLUMN guild_kind text NOT NULL DEFAULT 'unclassified'
    CHECK (guild_kind IN ('unclassified', 'state', 'alliance')),
  ADD COLUMN link_status text NOT NULL DEFAULT 'active'
    CHECK (link_status IN ('active', 'revoked')),
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by_actor_id text,
  ADD COLUMN revocation_reason text,
  ADD CONSTRAINT booking_discord_guilds_revocation_state_check CHECK (
    (link_status = 'active' AND revoked_at IS NULL)
    OR (link_status = 'revoked' AND revoked_at IS NOT NULL)
  );

CREATE UNIQUE INDEX booking_discord_guilds_one_active_state_guild
  ON booking_discord_guilds (game_profile, community_id)
  WHERE guild_kind = 'state' AND link_status = 'active';

CREATE INDEX booking_discord_guilds_active_community_lookup
  ON booking_discord_guilds (game_profile, community_id, guild_kind, discord_guild_id)
  WHERE link_status = 'active';

CREATE TABLE community_access_grants (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  discord_user_id text NOT NULL CHECK (btrim(discord_user_id) <> ''),
  source_guild_id text NOT NULL CHECK (btrim(source_guild_id) <> ''),
  source_type text NOT NULL
    CHECK (source_type IN ('alliance_discord', 'legacy_session')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  verified_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_actor_id text,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, community_id, discord_user_id, source_guild_id),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id) ON DELETE CASCADE,
  FOREIGN KEY (game_profile, discord_user_id)
    REFERENCES website_discord_identities (game_profile, discord_user_id) ON DELETE CASCADE,
  FOREIGN KEY (game_profile, source_guild_id, community_id)
    REFERENCES booking_discord_guilds (game_profile, discord_guild_id, community_id)
    ON DELETE RESTRICT,
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX community_access_grants_active_user_lookup
  ON community_access_grants (game_profile, discord_user_id, community_id, source_guild_id)
  WHERE status = 'active';

CREATE INDEX community_access_grants_active_source_lookup
  ON community_access_grants (game_profile, community_id, source_guild_id, discord_user_id)
  WHERE status = 'active';

DO $$
DECLARE
  target_profile text;
BEGIN
  FOREACH target_profile IN ARRAY ARRAY['wos', 'kingshot']::text[] LOOP
    PERFORM set_config('app.game_profile', target_profile, true);
    WITH historical AS (
      SELECT DISTINCT session_community.game_profile,
             session_community.community_id,
             session.discord_user_id,
             session_community.discord_guild_id,
             session_community.verified_at,
             md5(session_community.game_profile || ':' || session_community.community_id::text
               || ':' || session.discord_user_id || ':' || session_community.discord_guild_id) AS digest
        FROM website_auth_session_communities AS session_community
        JOIN website_auth_sessions AS session
          ON session.game_profile = session_community.game_profile
         AND session.token_hash = session_community.session_token_hash
        JOIN booking_discord_guilds AS guild
          ON guild.game_profile = session_community.game_profile
         AND guild.discord_guild_id = session_community.discord_guild_id
         AND guild.community_id = session_community.community_id
       WHERE session_community.game_profile = target_profile
         AND session.revoked_at IS NULL
         AND session.expires_at > now()
         AND guild.link_status = 'active'
    )
    INSERT INTO community_access_grants (
      game_profile,id,community_id,discord_user_id,source_guild_id,source_type,verified_at
    )
    SELECT game_profile,
           (substr(digest,1,8) || '-' || substr(digest,9,4) || '-5' || substr(digest,14,3)
            || '-8' || substr(digest,18,3) || '-' || substr(digest,21,12))::uuid,
           community_id,discord_user_id,discord_guild_id,'legacy_session',verified_at
      FROM historical
    ON CONFLICT (game_profile,community_id,discord_user_id,source_guild_id) DO NOTHING;
  END LOOP;
END;
$$;

ALTER TABLE booking_participants
  ADD COLUMN source_discord_guild_id text,
  ADD CONSTRAINT booking_participants_source_guild_fk
    FOREIGN KEY (game_profile, source_discord_guild_id, community_id)
    REFERENCES booking_discord_guilds (game_profile, discord_guild_id, community_id)
    ON DELETE RESTRICT;

ALTER TABLE minister_bookings
  ADD COLUMN source_discord_guild_id text,
  ADD CONSTRAINT minister_bookings_source_guild_fk
    FOREIGN KEY (game_profile, source_discord_guild_id, community_id)
    REFERENCES booking_discord_guilds (game_profile, discord_guild_id, community_id)
    ON DELETE RESTRICT;

CREATE TABLE booking_cycle_schedule_overrides (
  game_profile text NOT NULL CHECK (game_profile = 'wos'),
  community_id uuid NOT NULL,
  cycle_index integer NOT NULL CHECK (cycle_index >= 1),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  created_by_actor_id text NOT NULL CHECK (btrim(created_by_actor_id) <> ''),
  updated_by_actor_id text NOT NULL CHECK (btrim(updated_by_actor_id) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, community_id, cycle_index),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id) ON DELETE CASCADE,
  CHECK (opens_at < closes_at)
);

CREATE TABLE player_points_ledger (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  participant_id uuid NOT NULL,
  community_id uuid NOT NULL,
  discord_user_id text,
  points_delta bigint NOT NULL CHECK (points_delta <> 0),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  booking_window_id uuid,
  booking_id uuid,
  source_guild_id text,
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, idempotency_key),
  FOREIGN KEY (game_profile, participant_id, community_id)
    REFERENCES booking_participants (game_profile, id, community_id) ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, booking_window_id, community_id)
    REFERENCES booking_windows (game_profile, id, community_id) ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, booking_id)
    REFERENCES minister_bookings (game_profile, id) ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, source_guild_id, community_id)
    REFERENCES booking_discord_guilds (game_profile, discord_guild_id, community_id)
    ON DELETE RESTRICT
);

CREATE INDEX player_points_ledger_balance_lookup
  ON player_points_ledger (game_profile, participant_id, created_at, id);

CREATE TABLE community_points_ledger (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  source_guild_id text NOT NULL,
  booking_window_id uuid NOT NULL,
  points_delta bigint NOT NULL CHECK (points_delta <> 0),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, idempotency_key),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id) ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, source_guild_id, community_id)
    REFERENCES booking_discord_guilds (game_profile, discord_guild_id, community_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, booking_window_id, community_id)
    REFERENCES booking_windows (game_profile, id, community_id) ON DELETE RESTRICT
);

CREATE INDEX community_points_ledger_balance_lookup
  ON community_points_ledger (game_profile, community_id, created_at, id);

CREATE FUNCTION reject_points_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'points ledgers are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER player_points_ledger_append_only
  BEFORE UPDATE OR DELETE ON player_points_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_points_ledger_mutation();

CREATE TRIGGER community_points_ledger_append_only
  BEFORE UPDATE OR DELETE ON community_points_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_points_ledger_mutation();

ALTER TABLE community_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY community_access_grants_profile_policy ON community_access_grants
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_cycle_schedule_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_cycle_schedule_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_cycle_schedule_overrides_profile_policy ON booking_cycle_schedule_overrides
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE player_points_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_points_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY player_points_ledger_profile_policy ON player_points_ledger
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE community_points_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_points_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY community_points_ledger_profile_policy ON community_points_ledger
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));
