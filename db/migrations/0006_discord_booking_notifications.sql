CREATE TABLE booking_discord_notifications (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  id uuid NOT NULL,
  community_id uuid NOT NULL,
  notification_type text NOT NULL CHECK (notification_type IN (
    'manager_discovery', 'manager_request', 'manager_update',
    'player_confirmed', 'player_approved', 'player_rescheduled',
    'player_cancelled', 'appointment_reminder'
  )),
  request_id uuid,
  booking_id uuid,
  related_booking_id uuid,
  approval_message_id uuid,
  recipient_discord_user_id text,
  source_discord_guild_id text,
  attribution_display_name text,
  due_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'claimed', 'retry', 'sent', 'permanent_failure', 'superseded'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token uuid,
  claimed_at timestamptz,
  claimed_until timestamptz,
  next_attempt_at timestamptz,
  discord_channel_id text,
  discord_message_id text,
  last_error_code text,
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY (game_profile, id),
  UNIQUE (game_profile, community_id, idempotency_key),
  FOREIGN KEY (game_profile, community_id)
    REFERENCES booking_communities (game_profile, id) ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, request_id)
    REFERENCES booking_approval_requests (game_profile, id) ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, booking_id)
    REFERENCES minister_bookings (game_profile, id) ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, related_booking_id)
    REFERENCES minister_bookings (game_profile, id) ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, approval_message_id)
    REFERENCES booking_approval_discord_messages (game_profile, id) ON DELETE RESTRICT,
  FOREIGN KEY (game_profile, source_discord_guild_id, community_id)
    REFERENCES booking_discord_guilds (game_profile, discord_guild_id, community_id)
    ON DELETE RESTRICT,
  CHECK (
    (notification_type = 'manager_discovery' AND request_id IS NOT NULL
      AND recipient_discord_user_id IS NULL)
    OR
    (notification_type <> 'manager_discovery'
      AND recipient_discord_user_id IS NOT NULL)
  ),
  CHECK (
    status <> 'claimed'
    OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL AND claimed_until IS NOT NULL)
  ),
  CHECK (sent_at IS NULL OR status = 'sent'),
  CHECK (discord_message_id IS NULL OR discord_channel_id IS NOT NULL)
);

CREATE INDEX booking_discord_notifications_due
  ON booking_discord_notifications (game_profile, status, due_at, next_attempt_at)
  WHERE status IN ('pending', 'retry', 'claimed');

CREATE INDEX booking_discord_notifications_request
  ON booking_discord_notifications (game_profile, request_id, notification_type);

CREATE INDEX booking_discord_notifications_booking
  ON booking_discord_notifications (game_profile, booking_id, notification_type);

CREATE TABLE booking_integration_nonces (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16,128}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_profile, nonce),
  CHECK (expires_at > created_at)
);

CREATE INDEX booking_integration_nonces_expiry
  ON booking_integration_nonces (game_profile, expires_at);

ALTER TABLE booking_discord_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_discord_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_discord_notifications_profile_policy
  ON booking_discord_notifications
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));

ALTER TABLE booking_integration_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_integration_nonces FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_integration_nonces_profile_policy
  ON booking_integration_nonces
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));
