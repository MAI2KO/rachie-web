CREATE TABLE booking_community_window_defaults (
  game_profile text NOT NULL CHECK (game_profile = 'wos'),
  community_id uuid NOT NULL,
  open_minute_utc smallint NOT NULL
    CHECK (open_minute_utc BETWEEN 0 AND 1439),
  close_offset_minutes integer NOT NULL,
  created_by_actor_id text NOT NULL CHECK (btrim(created_by_actor_id) <> ''),
  updated_by_actor_id text NOT NULL CHECK (btrim(updated_by_actor_id) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, community_id),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id) ON DELETE CASCADE,
  CHECK (close_offset_minutes > open_minute_utc),
  CHECK (close_offset_minutes <= open_minute_utc + 20160)
);

COMMENT ON TABLE booking_community_window_defaults IS
  'Per-community recurring WOS booking window offsets from the deterministic Wednesday cycle anchor.';
COMMENT ON COLUMN booking_community_window_defaults.open_minute_utc IS
  'Opening minute after Wednesday 00:00 UTC for every cycle.';
COMMENT ON COLUMN booking_community_window_defaults.close_offset_minutes IS
  'Closing minute after Wednesday 00:00 UTC for every cycle.';

ALTER TABLE booking_community_window_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_community_window_defaults FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_community_window_defaults_profile_policy
  ON booking_community_window_defaults
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));
