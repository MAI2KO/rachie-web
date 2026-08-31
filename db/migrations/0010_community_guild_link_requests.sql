CREATE TABLE community_guild_link_requests (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  requesting_discord_guild_id text NOT NULL CHECK (btrim(requesting_discord_guild_id) <> ''),
  requesting_discord_guild_name text NOT NULL CHECK (btrim(requesting_discord_guild_name) <> ''),
  alliance_abbreviation text NOT NULL CHECK (alliance_abbreviation ~ '^[A-Z0-9]{3}$'),
  requested_by_discord_user_id text NOT NULL CHECK (btrim(requested_by_discord_user_id) <> ''),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by_discord_user_id text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'pending' AND decided_by_discord_user_id IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected')
        AND btrim(decided_by_discord_user_id) <> '' AND decided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX community_guild_link_requests_one_pending_guild
  ON community_guild_link_requests (game_profile, requesting_discord_guild_id)
  WHERE status = 'pending';

CREATE INDEX community_guild_link_requests_pending_community
  ON community_guild_link_requests (game_profile, community_id, requested_at, id)
  WHERE status = 'pending';

ALTER TABLE community_guild_link_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_guild_link_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY community_guild_link_requests_profile_policy ON community_guild_link_requests
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));
