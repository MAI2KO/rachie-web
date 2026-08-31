ALTER TABLE booking_discord_notifications
  DROP CONSTRAINT booking_discord_notifications_notification_type_check,
  ADD CONSTRAINT booking_discord_notifications_notification_type_check
    CHECK (notification_type IN (
      'manager_discovery', 'manager_request', 'manager_update', 'manager_guest_link',
      'player_confirmed', 'player_approved', 'player_rescheduled',
      'player_cancelled', 'appointment_reminder', 'booking_window_open'
    )),
  DROP CONSTRAINT booking_discord_notifications_recipient_check,
  ADD CONSTRAINT booking_discord_notifications_recipient_check CHECK (
    (notification_type IN ('manager_discovery', 'manager_guest_link', 'booking_window_open')
      AND recipient_discord_user_id IS NULL)
    OR
    (notification_type NOT IN ('manager_discovery', 'manager_guest_link', 'booking_window_open')
      AND recipient_discord_user_id IS NOT NULL)
  ),
  ADD CONSTRAINT booking_discord_notifications_manual_guest_link_check CHECK (
    notification_type <> 'manager_guest_link'
    OR (guest_share_link_id IS NOT NULL AND booking_window_id IS NULL)
  );
