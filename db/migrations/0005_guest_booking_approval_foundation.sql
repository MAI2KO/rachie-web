ALTER TABLE booking_settings
  ADD COLUMN booking_approval_policy text NOT NULL DEFAULT 'auto_approve'
    CHECK (booking_approval_policy IN ('auto_approve', 'require_approval')),
  ADD COLUMN pending_hold_duration_seconds integer NOT NULL DEFAULT 1800
    CHECK (pending_hold_duration_seconds BETWEEN 60 AND 86400);

ALTER TABLE booking_discord_guilds
  ADD COLUMN bot_manager_role_id text
    CHECK (bot_manager_role_id IS NULL OR btrim(bot_manager_role_id) <> '');

CREATE TABLE booking_guest_share_links (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text CHECK (token_hint IS NULL OR btrim(token_hint) <> ''),
  label text CHECK (label IS NULL OR btrim(label) <> ''),
  created_by_actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by_actor_id text,
  rotated_from_link_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (token_hash),
  UNIQUE (game_profile, id, community_id),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, rotated_from_link_id)
    REFERENCES booking_guest_share_links (game_profile, id)
    ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (rotated_from_link_id IS NULL OR rotated_from_link_id <> id)
);

CREATE UNIQUE INDEX booking_guest_share_links_one_active_per_community
  ON booking_guest_share_links (game_profile, community_id)
  WHERE revoked_at IS NULL;

CREATE TABLE booking_approval_requests (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  window_id uuid NOT NULL,
  service_date_id uuid NOT NULL,
  service_code text NOT NULL,
  booking_date date NOT NULL,
  slot_id uuid NOT NULL,
  request_source text NOT NULL
    CHECK (request_source IN ('guest_link', 'discord')),
  share_link_id uuid,
  participant_id uuid,
  discord_user_id text,
  player_id_snapshot text NOT NULL CHECK (btrim(player_id_snapshot) <> ''),
  in_game_name_snapshot text NOT NULL CHECK (btrim(in_game_name_snapshot) <> ''),
  alliance_snapshot text NOT NULL CHECK (btrim(alliance_snapshot) <> ''),
  display_time_label_snapshot text NOT NULL
    CHECK (btrim(display_time_label_snapshot) <> ''),
  status text NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'confirmed', 'denied', 'expired')),
  hold_expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by_discord_user_id text,
  decided_by_display_name text,
  confirmed_booking_id uuid,
  idempotency_key text NOT NULL,
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, id, community_id),
  UNIQUE (game_profile, id, community_id, slot_id),
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
  FOREIGN KEY (game_profile, share_link_id, community_id)
    REFERENCES booking_guest_share_links (game_profile, id, community_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, participant_id, community_id)
    REFERENCES booking_participants (game_profile, id, community_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, community_id, idempotency_key)
    REFERENCES booking_idempotency_keys (game_profile, community_id, idempotency_key)
    ON DELETE RESTRICT,
  CHECK (hold_expires_at > created_at),
  CHECK (
    (request_source = 'guest_link' AND share_link_id IS NOT NULL
      AND participant_id IS NULL AND discord_user_id IS NULL)
    OR
    (request_source = 'discord' AND share_link_id IS NULL
      AND participant_id IS NOT NULL AND discord_user_id IS NOT NULL)
  ),
  CHECK (
    (status = 'pending_approval' AND decided_at IS NULL
      AND decided_by_discord_user_id IS NULL AND confirmed_booking_id IS NULL)
    OR
    (status = 'confirmed' AND decided_at IS NOT NULL
      AND decided_by_discord_user_id IS NOT NULL AND confirmed_booking_id IS NOT NULL)
    OR
    (status = 'denied' AND decided_at IS NOT NULL
      AND decided_by_discord_user_id IS NOT NULL AND confirmed_booking_id IS NULL)
    OR
    (status = 'expired' AND decided_at IS NOT NULL
      AND confirmed_booking_id IS NULL)
  )
);

CREATE UNIQUE INDEX booking_approval_requests_one_pending_per_slot
  ON booking_approval_requests (game_profile, slot_id)
  WHERE status = 'pending_approval';

CREATE INDEX booking_approval_requests_due_holds
  ON booking_approval_requests (game_profile, community_id, hold_expires_at)
  WHERE status = 'pending_approval';

CREATE TABLE booking_approval_request_answers (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  request_id uuid NOT NULL,
  requirement_code text NOT NULL CHECK (btrim(requirement_code) <> ''),
  raw_value text,
  numeric_value numeric,
  unit text,
  display_label text NOT NULL CHECK (btrim(display_label) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, request_id, requirement_code),
  FOREIGN KEY (game_profile, request_id)
    REFERENCES booking_approval_requests (game_profile, id)
    ON DELETE CASCADE
);

CREATE TABLE booking_approval_events (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('submitted', 'approved', 'denied', 'expired')),
  actor_type text NOT NULL CHECK (actor_type IN ('guest', 'discord_user', 'system')),
  acting_discord_user_id text,
  acting_discord_display_name text,
  previous_state text,
  resulting_state text NOT NULL
    CHECK (resulting_state IN ('pending_approval', 'confirmed', 'denied', 'expired')),
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  FOREIGN KEY (game_profile, request_id, community_id)
    REFERENCES booking_approval_requests (game_profile, id, community_id)
    ON DELETE RESTRICT,
  CHECK (
    (actor_type = 'discord_user' AND acting_discord_user_id IS NOT NULL)
    OR (actor_type <> 'discord_user' AND acting_discord_user_id IS NULL)
  )
);

CREATE INDEX booking_approval_events_request_history
  ON booking_approval_events (
    game_profile,
    community_id,
    request_id,
    created_at,
    id
  );

CREATE TABLE booking_approval_discord_messages (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  request_id uuid NOT NULL,
  discord_guild_id text NOT NULL CHECK (btrim(discord_guild_id) <> ''),
  discord_channel_id text NOT NULL CHECK (btrim(discord_channel_id) <> ''),
  discord_message_id text,
  recipient_discord_user_id text,
  delivery_status text NOT NULL DEFAULT 'queued'
    CHECK (delivery_status IN ('queued', 'sent', 'update_pending', 'updated', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  sent_at timestamptz,
  updated_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, id),
  FOREIGN KEY (game_profile, request_id, community_id)
    REFERENCES booking_approval_requests (game_profile, id, community_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, discord_guild_id, community_id)
    REFERENCES booking_discord_guilds (
      game_profile,
      discord_guild_id,
      community_id
    ) ON DELETE RESTRICT,
  CHECK (discord_message_id IS NULL OR btrim(discord_message_id) <> ''),
  CHECK (sent_at IS NULL OR discord_message_id IS NOT NULL),
  CHECK (updated_message_at IS NULL OR delivery_status = 'updated')
);

CREATE UNIQUE INDEX booking_approval_discord_messages_remote_message
  ON booking_approval_discord_messages (
    game_profile,
    discord_guild_id,
    discord_channel_id,
    discord_message_id
  ) WHERE discord_message_id IS NOT NULL;

CREATE INDEX booking_approval_discord_messages_request_delivery
  ON booking_approval_discord_messages (
    game_profile,
    community_id,
    request_id,
    delivery_status
  );

ALTER TABLE minister_bookings
  ADD COLUMN approval_request_id uuid;

ALTER TABLE minister_bookings
  ADD CONSTRAINT minister_bookings_profile_id_community_slot_key
    UNIQUE (game_profile, id, community_id, slot_id),
  ADD CONSTRAINT minister_bookings_approval_request_fkey
    FOREIGN KEY (game_profile, approval_request_id, community_id, slot_id)
    REFERENCES booking_approval_requests (
      game_profile,
      id,
      community_id,
      slot_id
    ) ON DELETE RESTRICT;

CREATE UNIQUE INDEX minister_bookings_one_per_approval_request
  ON minister_bookings (game_profile, approval_request_id)
  WHERE approval_request_id IS NOT NULL;

ALTER TABLE booking_approval_requests
  ADD CONSTRAINT booking_approval_requests_confirmed_booking_fkey
    FOREIGN KEY (
      game_profile,
      confirmed_booking_id,
      community_id,
      slot_id
    ) REFERENCES minister_bookings (
      game_profile,
      id,
      community_id,
      slot_id
    ) ON DELETE RESTRICT;

ALTER TABLE booking_guest_share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_guest_share_links FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_guest_share_links_profile_policy ON booking_guest_share_links
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_approval_requests_profile_policy ON booking_approval_requests
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_approval_request_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_approval_request_answers FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_approval_request_answers_profile_policy ON booking_approval_request_answers
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_approval_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_approval_events FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_approval_events_profile_policy ON booking_approval_events
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_approval_discord_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_approval_discord_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_approval_discord_messages_profile_policy ON booking_approval_discord_messages
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));
