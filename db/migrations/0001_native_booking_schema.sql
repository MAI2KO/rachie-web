CREATE TABLE booking_communities (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  location_code text NOT NULL CHECK (btrim(location_code) <> ''),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  bookings_open boolean NOT NULL DEFAULT false,
  join_password_hash text,
  join_password_rotated_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, location_code)
);

CREATE TABLE booking_discord_guilds (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  discord_guild_id text NOT NULL CHECK (btrim(discord_guild_id) <> ''),
  community_id uuid NOT NULL,
  discord_guild_name text NOT NULL CHECK (btrim(discord_guild_name) <> ''),
  announcement_channel_id text,
  linked_by_actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, discord_guild_id),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id)
    ON DELETE RESTRICT
);

CREATE TABLE booking_settings (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  community_id uuid NOT NULL,
  legacy_max_bookings_per_player_per_day integer
    CHECK (legacy_max_bookings_per_player_per_day IS NULL OR legacy_max_bookings_per_player_per_day >= 0),
  max_linked_guilds integer NOT NULL DEFAULT 5 CHECK (max_linked_guilds > 0),
  construction_fc_required boolean NOT NULL DEFAULT false,
  construction_rfc_required boolean NOT NULL DEFAULT false,
  construction_speedups_required boolean NOT NULL DEFAULT false,
  research_shards_required boolean NOT NULL DEFAULT false,
  research_speedups_required boolean NOT NULL DEFAULT false,
  troop_speedups_required boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, community_id),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id)
    ON DELETE CASCADE
);

CREATE TABLE booking_windows (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'open', 'closed', 'archived')),
  opens_at timestamptz,
  closes_at timestamptz,
  opened_at timestamptz,
  closed_at timestamptz,
  created_by_actor_type text NOT NULL
    CHECK (created_by_actor_type IN ('discord_user', 'website_user', 'admin', 'service', 'system', 'legacy_import')),
  created_by_actor_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, id, community_id),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id)
    ON DELETE RESTRICT,
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);

CREATE TABLE minister_services (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  service_code text NOT NULL
    CHECK (service_code IN ('construction', 'research', 'troop')),
  display_label text NOT NULL CHECK (btrim(display_label) <> ''),
  appointment_label text NOT NULL CHECK (btrim(appointment_label) <> ''),
  requirement_definitions jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(requirement_definitions) = 'object'),
  sort_order smallint NOT NULL CHECK (sort_order > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, service_code),
  UNIQUE (game_profile, sort_order)
);

INSERT INTO minister_services (
  game_profile,
  service_code,
  display_label,
  appointment_label,
  sort_order
) VALUES
  ('wos', 'construction', 'Construction', 'Minister booking', 1),
  ('wos', 'research', 'Research', 'Minister booking', 2),
  ('wos', 'troop', 'Troop', 'Minister booking', 3),
  ('kingshot', 'construction', 'Construction', 'Minister appointment', 1),
  ('kingshot', 'research', 'Research', 'Minister appointment', 2),
  ('kingshot', 'troop', 'Troop', 'Minister appointment', 3);

CREATE TABLE booking_service_dates (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  window_id uuid NOT NULL,
  service_code text NOT NULL,
  booking_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, window_id, service_code),
  UNIQUE (
    game_profile,
    id,
    community_id,
    window_id,
    service_code,
    booking_date
  ),
  FOREIGN KEY (game_profile, window_id, community_id)
    REFERENCES booking_windows (game_profile, id, community_id)
    ON DELETE CASCADE,
  FOREIGN KEY (game_profile, service_code)
    REFERENCES minister_services (game_profile, service_code)
    ON DELETE RESTRICT
);

CREATE TABLE appointment_slots (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  window_id uuid NOT NULL,
  service_date_id uuid NOT NULL,
  service_code text NOT NULL,
  booking_date date NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  display_time_label text NOT NULL CHECK (btrim(display_time_label) <> ''),
  local_start_time time without time zone,
  time_zone text,
  starts_at timestamptz,
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'disabled', 'retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, service_date_id, ordinal),
  UNIQUE (game_profile, service_date_id, display_time_label),
  UNIQUE (game_profile, id, community_id, window_id),
  UNIQUE (
    game_profile,
    id,
    community_id,
    window_id,
    service_code,
    service_date_id,
    booking_date
  ),
  FOREIGN KEY (
    game_profile,
    service_date_id,
    community_id,
    window_id,
    service_code,
    booking_date
  ) REFERENCES booking_service_dates (
    game_profile,
    id,
    community_id,
    window_id,
    service_code,
    booking_date
  ) ON DELETE CASCADE,
  CHECK (
    (local_start_time IS NULL AND time_zone IS NULL)
    OR (local_start_time IS NOT NULL AND time_zone IS NOT NULL AND btrim(time_zone) <> '')
  ),
  CHECK (ends_at IS NULL OR (starts_at IS NOT NULL AND ends_at > starts_at))
);

CREATE TABLE booking_idempotency_keys (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  community_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  operation text NOT NULL CHECK (btrim(operation) <> ''),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  request_id text,
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'failed')),
  response_status integer,
  response_body jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz,
  PRIMARY KEY (game_profile, community_id, idempotency_key),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id)
    ON DELETE CASCADE,
  CHECK (response_body IS NULL OR jsonb_typeof(response_body) = 'object'),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE booking_slot_blocks (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  window_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  reason text,
  source text NOT NULL
    CHECK (source IN ('discord', 'website', 'admin', 'legacy_import', 'compatibility')),
  actor_type text NOT NULL
    CHECK (actor_type IN ('discord_user', 'website_user', 'admin', 'service', 'system', 'legacy_import')),
  actor_id text,
  idempotency_key text NOT NULL,
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancelled_by_actor_type text
    CHECK (cancelled_by_actor_type IS NULL OR cancelled_by_actor_type IN ('discord_user', 'website_user', 'admin', 'service', 'system')),
  cancelled_by_actor_id text,
  PRIMARY KEY (game_profile, id),
  FOREIGN KEY (game_profile, slot_id, community_id, window_id)
    REFERENCES appointment_slots (game_profile, id, community_id, window_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, community_id, idempotency_key)
    REFERENCES booking_idempotency_keys (game_profile, community_id, idempotency_key)
    ON DELETE RESTRICT,
  CHECK (cancelled_at IS NOT NULL OR cancelled_by_actor_type IS NULL),
  CHECK (cancelled_at IS NOT NULL OR cancelled_by_actor_id IS NULL)
);

CREATE UNIQUE INDEX booking_slot_blocks_one_active_per_slot
  ON booking_slot_blocks (game_profile, slot_id)
  WHERE cancelled_at IS NULL;

CREATE TABLE booking_participants (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  discord_user_id text,
  discord_tag text,
  player_id text NOT NULL CHECK (btrim(player_id) <> ''),
  in_game_name text NOT NULL CHECK (btrim(in_game_name) <> ''),
  alliance text NOT NULL CHECK (btrim(alliance) <> ''),
  source text NOT NULL
    CHECK (source IN ('discord', 'website', 'admin', 'manual', 'legacy_import')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  idempotency_key text NOT NULL,
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, id, community_id),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, community_id, idempotency_key)
    REFERENCES booking_idempotency_keys (game_profile, community_id, idempotency_key)
    ON DELETE RESTRICT,
  CHECK (source NOT IN ('discord', 'website') OR discord_user_id IS NOT NULL),
  CHECK (discord_user_id IS NULL OR btrim(discord_user_id) <> '')
);

CREATE UNIQUE INDEX booking_participants_one_active_discord_registration
  ON booking_participants (game_profile, community_id, discord_user_id)
  WHERE status = 'active' AND discord_user_id IS NOT NULL;

CREATE INDEX booking_participants_player_lookup
  ON booking_participants (game_profile, community_id, player_id);

CREATE TABLE minister_bookings (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  window_id uuid NOT NULL,
  service_date_id uuid NOT NULL,
  service_code text NOT NULL,
  booking_date date NOT NULL,
  slot_id uuid NOT NULL,
  participant_id uuid,
  discord_user_id text,
  player_id_snapshot text NOT NULL CHECK (btrim(player_id_snapshot) <> ''),
  in_game_name_snapshot text NOT NULL CHECK (btrim(in_game_name_snapshot) <> ''),
  alliance_snapshot text NOT NULL CHECK (btrim(alliance_snapshot) <> ''),
  display_time_label_snapshot text NOT NULL CHECK (btrim(display_time_label_snapshot) <> ''),
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'cancelled', 'replaced', 'cleared')),
  source text NOT NULL
    CHECK (source IN ('discord', 'website', 'admin', 'legacy_import', 'compatibility')),
  actor_type text NOT NULL
    CHECK (actor_type IN ('discord_user', 'website_user', 'admin', 'service', 'system', 'legacy_import')),
  actor_id text,
  idempotency_key text NOT NULL,
  request_id text,
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  rescheduled_from_booking_id uuid,
  cancellation_reason text,
  cancelled_at timestamptz,
  cancelled_by_actor_type text
    CHECK (cancelled_by_actor_type IS NULL OR cancelled_by_actor_type IN ('discord_user', 'website_user', 'admin', 'service', 'system')),
  cancelled_by_actor_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, id, community_id, window_id, service_code),
  FOREIGN KEY (
    game_profile,
    slot_id,
    community_id,
    window_id,
    service_code,
    service_date_id,
    booking_date
  ) REFERENCES appointment_slots (
    game_profile,
    id,
    community_id,
    window_id,
    service_code,
    service_date_id,
    booking_date
  ) ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, participant_id, community_id)
    REFERENCES booking_participants (game_profile, id, community_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    game_profile,
    rescheduled_from_booking_id,
    community_id,
    window_id,
    service_code
  ) REFERENCES minister_bookings (
    game_profile,
    id,
    community_id,
    window_id,
    service_code
  ) ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, community_id, idempotency_key)
    REFERENCES booking_idempotency_keys (game_profile, community_id, idempotency_key)
    ON DELETE RESTRICT,
  CHECK (rescheduled_from_booking_id IS NULL OR rescheduled_from_booking_id <> id),
  CHECK (
    (status = 'confirmed' AND cancelled_at IS NULL)
    OR (status <> 'confirmed' AND cancelled_at IS NOT NULL)
  ),
  CHECK (cancelled_at IS NOT NULL OR cancellation_reason IS NULL),
  CHECK (cancelled_at IS NOT NULL OR cancelled_by_actor_type IS NULL),
  CHECK (cancelled_at IS NOT NULL OR cancelled_by_actor_id IS NULL)
);

CREATE UNIQUE INDEX minister_bookings_one_active_per_slot
  ON minister_bookings (game_profile, slot_id)
  WHERE status = 'confirmed';

CREATE UNIQUE INDEX minister_bookings_one_active_player_service
  ON minister_bookings (
    game_profile,
    community_id,
    window_id,
    service_code,
    player_id_snapshot
  ) WHERE status = 'confirmed';

CREATE UNIQUE INDEX minister_bookings_one_reschedule_successor
  ON minister_bookings (game_profile, rescheduled_from_booking_id)
  WHERE rescheduled_from_booking_id IS NOT NULL;

CREATE TABLE booking_requirement_answers (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  booking_id uuid NOT NULL,
  requirement_code text NOT NULL CHECK (btrim(requirement_code) <> ''),
  raw_value text,
  numeric_value numeric,
  unit text,
  display_label text NOT NULL CHECK (btrim(display_label) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, booking_id, requirement_code),
  FOREIGN KEY (game_profile, booking_id)
    REFERENCES minister_bookings (game_profile, id)
    ON DELETE CASCADE
);

CREATE TABLE booking_change_events (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  aggregate_type text NOT NULL CHECK (btrim(aggregate_type) <> ''),
  aggregate_id uuid,
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  source text NOT NULL
    CHECK (source IN ('discord', 'website', 'admin', 'legacy_import', 'compatibility', 'system')),
  actor_type text NOT NULL
    CHECK (actor_type IN ('discord_user', 'website_user', 'admin', 'service', 'system', 'legacy_import')),
  actor_id text,
  request_id text,
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id)
    ON DELETE RESTRICT,
  CHECK (before_data IS NULL OR jsonb_typeof(before_data) = 'object'),
  CHECK (after_data IS NULL OR jsonb_typeof(after_data) = 'object')
);

CREATE INDEX booking_change_events_aggregate_history
  ON booking_change_events (
    game_profile,
    community_id,
    aggregate_type,
    aggregate_id,
    created_at
  );

CREATE TABLE booking_outbox (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, community_id, idempotency_key),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id)
    ON DELETE RESTRICT,
  CHECK (delivered_at IS NULL OR status = 'delivered')
);

CREATE INDEX booking_outbox_pending_delivery
  ON booking_outbox (game_profile, status, available_at)
  WHERE status IN ('pending', 'failed');

ALTER TABLE booking_communities ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_communities FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_communities_profile_policy ON booking_communities
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_discord_guilds ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_discord_guilds FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_discord_guilds_profile_policy ON booking_discord_guilds
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_settings_profile_policy ON booking_settings
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_windows_profile_policy ON booking_windows
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE minister_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE minister_services FORCE ROW LEVEL SECURITY;
CREATE POLICY minister_services_profile_policy ON minister_services
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_service_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_service_dates FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_service_dates_profile_policy ON booking_service_dates
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE appointment_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_slots_profile_policy ON appointment_slots
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_idempotency_keys_profile_policy ON booking_idempotency_keys
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_slot_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_slot_blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_slot_blocks_profile_policy ON booking_slot_blocks
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_participants_profile_policy ON booking_participants
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE minister_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE minister_bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY minister_bookings_profile_policy ON minister_bookings
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_requirement_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_requirement_answers FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_requirement_answers_profile_policy ON booking_requirement_answers
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_change_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_change_events FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_change_events_profile_policy ON booking_change_events
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_outbox_profile_policy ON booking_outbox
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));
