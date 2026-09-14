ALTER TABLE booking_settings
  ADD COLUMN require_unregistered_guest_approval boolean NOT NULL DEFAULT true;

ALTER TABLE booking_participants
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false;

DROP INDEX booking_participants_one_active_discord_registration;

CREATE UNIQUE INDEX booking_participants_one_active_owned_player
  ON booking_participants (game_profile, community_id, discord_user_id, player_id)
  WHERE status = 'active' AND discord_user_id IS NOT NULL;

CREATE UNIQUE INDEX booking_participants_one_active_primary
  ON booking_participants (game_profile, community_id, discord_user_id)
  WHERE status = 'active' AND discord_user_id IS NOT NULL AND is_primary = true;

ALTER TABLE minister_bookings
  ADD COLUMN entry_provenance text NOT NULL DEFAULT 'legacy',
  ADD COLUMN guest_share_link_id uuid;

DO $migration$
DECLARE
  profile_name text;
BEGIN
  FOREACH profile_name IN ARRAY ARRAY['wos', 'kingshot'] LOOP
    PERFORM set_config('app.game_profile', profile_name, true);

    UPDATE minister_bookings AS booking
       SET entry_provenance='guest_unregistered',
           guest_share_link_id=request.share_link_id
      FROM booking_approval_requests AS request
     WHERE booking.game_profile=profile_name
       AND request.game_profile=booking.game_profile
       AND request.id=booking.approval_request_id
       AND request.community_id=booking.community_id
       AND request.request_source='guest_link'
       AND request.share_link_id IS NOT NULL;

    UPDATE minister_bookings AS booking
       SET entry_provenance='admin'
     WHERE booking.game_profile=profile_name
       AND booking.approval_request_id IS NULL
       AND (booking.source='admin' OR booking.actor_type='admin'
         OR EXISTS (
           SELECT 1 FROM booking_change_events AS event
            WHERE event.game_profile=booking.game_profile
              AND event.community_id=booking.community_id
              AND event.aggregate_type='minister_booking'
              AND event.aggregate_id=booking.id
              AND event.event_type='manager_manual_booking'
         ));

    UPDATE minister_bookings AS booking
       SET entry_provenance='member'
     WHERE booking.game_profile=profile_name
       AND booking.approval_request_id IS NULL
       AND booking.participant_id IS NOT NULL
       AND booking.discord_user_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM booking_change_events AS event
          WHERE event.game_profile=booking.game_profile
            AND event.community_id=booking.community_id
            AND event.aggregate_type='minister_booking'
            AND event.aggregate_id=booking.id
            AND event.event_type='booking_created'
            AND event.source='website'
            AND event.actor_type='discord_user'
       );
  END LOOP;
  PERFORM set_config('app.game_profile', '', true);
END
$migration$;

ALTER TABLE minister_bookings
  ADD CONSTRAINT minister_bookings_entry_provenance_check
    CHECK (entry_provenance IN (
      'member', 'guest_registered', 'guest_unregistered', 'admin', 'legacy'
    )),
  ADD CONSTRAINT minister_bookings_guest_share_link_fkey
    FOREIGN KEY (game_profile, guest_share_link_id, community_id)
    REFERENCES booking_guest_share_links (game_profile, id, community_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT minister_bookings_guest_provenance_check CHECK (
    (entry_provenance IN ('guest_registered', 'guest_unregistered')
      AND guest_share_link_id IS NOT NULL)
    OR
    (entry_provenance NOT IN ('guest_registered', 'guest_unregistered')
      AND guest_share_link_id IS NULL)
  );

CREATE INDEX booking_participants_registered_player_match
  ON booking_participants (game_profile, community_id, player_id, id)
  WHERE status = 'active';

CREATE INDEX minister_bookings_guest_provenance
  ON minister_bookings (game_profile, community_id, entry_provenance, created_at, id)
  WHERE guest_share_link_id IS NOT NULL;
