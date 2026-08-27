ALTER TABLE booking_guest_share_links
  ADD COLUMN booking_window_id uuid,
  ADD CONSTRAINT booking_guest_share_links_window_fkey
    FOREIGN KEY (game_profile, booking_window_id, community_id)
    REFERENCES booking_windows (game_profile, id, community_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX booking_guest_share_links_one_per_window
  ON booking_guest_share_links (game_profile, booking_window_id)
  WHERE booking_window_id IS NOT NULL;

ALTER TABLE booking_discord_notifications
  DROP CONSTRAINT booking_discord_notifications_notification_type_check,
  ADD CONSTRAINT booking_discord_notifications_notification_type_check
    CHECK (notification_type IN (
      'manager_discovery', 'manager_request', 'manager_update',
      'player_confirmed', 'player_approved', 'player_rescheduled',
      'player_cancelled', 'appointment_reminder', 'booking_window_open'
    )),
  ADD COLUMN booking_window_id uuid,
  ADD COLUMN guest_share_link_id uuid,
  ADD CONSTRAINT booking_discord_notifications_window_fkey
    FOREIGN KEY (game_profile, booking_window_id, community_id)
    REFERENCES booking_windows (game_profile, id, community_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT booking_discord_notifications_guest_link_fkey
    FOREIGN KEY (game_profile, guest_share_link_id, community_id)
    REFERENCES booking_guest_share_links (game_profile, id, community_id)
    ON DELETE RESTRICT;

ALTER TABLE booking_discord_notifications
  DROP CONSTRAINT booking_discord_notifications_check,
  ADD CONSTRAINT booking_discord_notifications_recipient_check CHECK (
    (notification_type IN ('manager_discovery', 'booking_window_open')
      AND recipient_discord_user_id IS NULL)
    OR
    (notification_type NOT IN ('manager_discovery', 'booking_window_open')
      AND recipient_discord_user_id IS NOT NULL)
  ),
  ADD CONSTRAINT booking_discord_notifications_window_open_check CHECK (
    notification_type <> 'booking_window_open'
    OR (booking_window_id IS NOT NULL AND guest_share_link_id IS NOT NULL)
  );

CREATE UNIQUE INDEX booking_discord_notifications_one_open_per_window
  ON booking_discord_notifications (game_profile, booking_window_id)
  WHERE notification_type = 'booking_window_open';
