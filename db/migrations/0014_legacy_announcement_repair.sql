ALTER TABLE booking_discord_notifications
  ADD COLUMN payload_version smallint NOT NULL DEFAULT 1
    CHECK (payload_version BETWEEN 1 AND 32767),
  ADD COLUMN repair_status text
    CHECK (repair_status IS NULL OR repair_status IN ('rotated', 'completed')),
  ADD COLUMN repaired_at timestamptz,
  ADD CONSTRAINT booking_discord_notifications_repair_state_check CHECK (
    (repair_status IS NULL AND repaired_at IS NULL)
    OR (repair_status = 'rotated' AND repaired_at IS NULL
      AND notification_type = 'booking_window_open')
    OR (repair_status = 'completed' AND repaired_at IS NOT NULL
      AND notification_type = 'booking_window_open' AND payload_version >= 2)
  );

DROP INDEX booking_guest_share_links_one_per_window;

CREATE UNIQUE INDEX booking_guest_share_links_one_active_per_window
  ON booking_guest_share_links (game_profile, booking_window_id)
  WHERE booking_window_id IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX booking_discord_notifications_legacy_announcement_repair
  ON booking_discord_notifications (game_profile, payload_version, repair_status, sent_at)
  WHERE notification_type = 'booking_window_open' AND status = 'sent';
