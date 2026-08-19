CREATE UNIQUE INDEX minister_bookings_one_active_participant_service
  ON minister_bookings (
    game_profile,
    community_id,
    window_id,
    service_code,
    participant_id
  )
  WHERE status = 'confirmed' AND participant_id IS NOT NULL;
