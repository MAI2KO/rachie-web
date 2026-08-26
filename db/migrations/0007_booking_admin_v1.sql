CREATE TABLE booking_community_services (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  community_id uuid NOT NULL,
  service_code text NOT NULL,
  enabled boolean NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, community_id, service_code),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id)
    ON DELETE CASCADE,
  FOREIGN KEY (game_profile, service_code)
    REFERENCES minister_services (game_profile, service_code)
    ON DELETE RESTRICT
);

SELECT set_config('app.game_profile', 'wos', true);

INSERT INTO booking_community_services
  (game_profile, community_id, service_code, enabled)
SELECT community.game_profile, community.id, service.service_code, service.active
FROM booking_communities AS community
JOIN minister_services AS service
  ON service.game_profile = community.game_profile
WHERE community.game_profile = 'wos';

INSERT INTO booking_settings (game_profile, community_id)
SELECT game_profile, id FROM booking_communities WHERE game_profile = 'wos'
ON CONFLICT (game_profile, community_id) DO NOTHING;

SELECT set_config('app.game_profile', 'kingshot', true);

INSERT INTO booking_community_services
  (game_profile, community_id, service_code, enabled)
SELECT community.game_profile, community.id, service.service_code, service.active
FROM booking_communities AS community
JOIN minister_services AS service
  ON service.game_profile = community.game_profile
WHERE community.game_profile = 'kingshot';

INSERT INTO booking_settings (game_profile, community_id)
SELECT game_profile, id FROM booking_communities WHERE game_profile = 'kingshot'
ON CONFLICT (game_profile, community_id) DO NOTHING;

SELECT set_config('app.game_profile', '', true);

ALTER TABLE booking_community_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_community_services FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_community_services_profile_policy ON booking_community_services
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));
