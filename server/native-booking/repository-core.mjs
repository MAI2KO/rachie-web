const GAME_PROFILES = new Set(["wos", "kingshot"]);

function assertGameProfile(gameProfile) {
  if (!GAME_PROFILES.has(gameProfile)) {
    throw new TypeError("Unsupported native booking game profile.");
  }
}

class ProfileScopedBookingSession {
  constructor(client, gameProfile) {
    this.client = client;
    this.gameProfile = gameProfile;
  }

  async findCommunityById(id) {
    const result = await this.client.query(
      `SELECT game_profile, id, location_code, display_name, status, bookings_open
       FROM booking_communities
       WHERE game_profile = $1 AND id = $2`,
      [this.gameProfile, id],
    );
    return result.rows[0] ?? null;
  }

  async findCommunityByLocationCode(locationCode) {
    const result = await this.client.query(
      `SELECT game_profile, id, location_code, display_name, status, bookings_open
       FROM booking_communities
       WHERE game_profile = $1 AND location_code = $2`,
      [this.gameProfile, locationCode],
    );
    return result.rows[0] ?? null;
  }

  async findCommunityForDiscordGuild(discordGuildId) {
    const result = await this.client.query(
      `SELECT c.game_profile, c.id, c.location_code, c.display_name,
              c.status, c.bookings_open
       FROM booking_discord_guilds AS guild
       JOIN booking_communities AS c
         ON c.game_profile = guild.game_profile
        AND c.id = guild.community_id
       WHERE guild.game_profile = $1 AND guild.discord_guild_id = $2`,
      [this.gameProfile, discordGuildId],
    );
    return result.rows[0] ?? null;
  }

  async findIdempotencyRecord(communityId, idempotencyKey) {
    const result = await this.client.query(
      `SELECT game_profile, community_id, idempotency_key, operation,
              request_hash, request_id, correlation_id, status,
              response_status, response_body
       FROM booking_idempotency_keys
       WHERE game_profile = $1
         AND community_id = $2
         AND idempotency_key = $3`,
      [this.gameProfile, communityId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }

  async claimRegistrationIdempotency({
    communityId,
    idempotencyKey,
    requestHash,
    correlationId,
  }) {
    const claimed = await this.client.query(
      `INSERT INTO booking_idempotency_keys
         (game_profile, community_id, idempotency_key, operation,
          request_hash, correlation_id)
       VALUES ($1, $2, $3, 'participant_registration_upsert', $4, $5)
       ON CONFLICT (game_profile, community_id, idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [
        this.gameProfile,
        communityId,
        idempotencyKey,
        requestHash,
        correlationId,
      ],
    );
    if (claimed.rowCount === 1) return { state: "claimed" };

    const existing = await this.client.query(
      `SELECT operation, request_hash, status, response_status, response_body
       FROM booking_idempotency_keys
       WHERE game_profile = $1
         AND community_id = $2
         AND idempotency_key = $3`,
      [this.gameProfile, communityId, idempotencyKey],
    );
    return { state: "existing", record: existing.rows[0] ?? null };
  }

  async completeRegistrationIdempotency(
    communityId,
    idempotencyKey,
    responseStatus,
    responseBody,
  ) {
    await this.client.query(
      `UPDATE booking_idempotency_keys
       SET status = 'completed',
           response_status = $4,
           response_body = $5,
           completed_at = now()
       WHERE game_profile = $1
         AND community_id = $2
         AND idempotency_key = $3`,
      [
        this.gameProfile,
        communityId,
        idempotencyKey,
        responseStatus,
        responseBody,
      ],
    );
  }

  async claimBookingIdempotency({ communityId, idempotencyKey, requestHash, correlationId }) {
    const claimed = await this.client.query(
      `INSERT INTO booking_idempotency_keys
         (game_profile, community_id, idempotency_key, operation, request_hash, correlation_id)
       VALUES ($1, $2, $3, 'booking_create', $4, $5)
       ON CONFLICT (game_profile, community_id, idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [this.gameProfile, communityId, idempotencyKey, requestHash, correlationId],
    );
    if (claimed.rowCount === 1) return { state: "claimed" };
    const existing = await this.client.query(
      `SELECT operation, request_hash, status, response_status, response_body
       FROM booking_idempotency_keys
       WHERE game_profile = $1 AND community_id = $2 AND idempotency_key = $3`,
      [this.gameProfile, communityId, idempotencyKey],
    );
    return { state: "existing", record: existing.rows[0] ?? null };
  }

  async completeBookingIdempotency(communityId, idempotencyKey, responseStatus, responseBody) {
    await this.client.query(
      `UPDATE booking_idempotency_keys
       SET status = 'completed', response_status = $4, response_body = $5, completed_at = now()
       WHERE game_profile = $1 AND community_id = $2 AND idempotency_key = $3`,
      [this.gameProfile, communityId, idempotencyKey, responseStatus, responseBody],
    );
  }

  async lockCommunityForBooking(communityId) {
    const result = await this.client.query(
      `SELECT game_profile, id, status, bookings_open
       FROM booking_communities
       WHERE game_profile = $1 AND id = $2
       FOR UPDATE`,
      [this.gameProfile, communityId],
    );
    return result.rows[0] ?? null;
  }

  async lockAppointmentSlot(communityId, slotId) {
    const result = await this.client.query(
      `SELECT slot.id, slot.community_id, slot.window_id, slot.service_date_id,
              slot.service_code, slot.booking_date, slot.display_time_label,
              slot.status AS slot_status, booking_window.status AS window_status,
              booking_window.opens_at, booking_window.closes_at,
              service.active AS service_active, service.display_label AS service_label
       FROM appointment_slots AS slot
       JOIN booking_windows AS booking_window
         ON booking_window.game_profile = slot.game_profile
        AND booking_window.id = slot.window_id
        AND booking_window.community_id = slot.community_id
       JOIN minister_services AS service
         ON service.game_profile = slot.game_profile
        AND service.service_code = slot.service_code
       WHERE slot.game_profile = $1 AND slot.community_id = $2 AND slot.id = $3
       FOR UPDATE OF slot`,
      [this.gameProfile, communityId, slotId],
    );
    return result.rows[0] ?? null;
  }

  async hasActiveSlotBlock(slotId) {
    const result = await this.client.query(
      `SELECT EXISTS (
         SELECT 1 FROM booking_slot_blocks
         WHERE game_profile = $1 AND slot_id = $2 AND cancelled_at IS NULL
       ) AS exists`,
      [this.gameProfile, slotId],
    );
    return result.rows[0].exists;
  }

  async hasConfirmedBookingForSlot(slotId) {
    const result = await this.client.query(
      `SELECT EXISTS (
         SELECT 1 FROM minister_bookings
         WHERE game_profile = $1 AND slot_id = $2 AND status = 'confirmed'
       ) AS exists`,
      [this.gameProfile, slotId],
    );
    return result.rows[0].exists;
  }

  async hasConfirmedBookingForParticipantService(communityId, windowId, serviceCode, participantId) {
    const result = await this.client.query(
      `SELECT EXISTS (
         SELECT 1 FROM minister_bookings
         WHERE game_profile = $1 AND community_id = $2 AND window_id = $3
           AND service_code = $4 AND participant_id = $5 AND status = 'confirmed'
       ) AS exists`,
      [this.gameProfile, communityId, windowId, serviceCode, participantId],
    );
    return result.rows[0].exists;
  }

  async insertWebsiteBooking(input) {
    const result = await this.client.query(
      `INSERT INTO minister_bookings
         (game_profile, id, community_id, window_id, service_date_id, service_code,
          booking_date, slot_id, participant_id, discord_user_id, player_id_snapshot,
          in_game_name_snapshot, alliance_snapshot, display_time_label_snapshot,
          source, actor_type, actor_id, idempotency_key, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               'website','discord_user',$10,$15,$16)
       RETURNING id, service_code, booking_date, display_time_label_snapshot,
                 in_game_name_snapshot, alliance_snapshot, status`,
      [this.gameProfile, input.id, input.communityId, input.windowId,
       input.serviceDateId, input.serviceCode, input.bookingDate, input.slotId,
       input.participantId, input.discordUserId, input.playerId, input.inGameName,
       input.alliance, input.displayTime, input.idempotencyKey, input.correlationId],
    );
    return result.rows[0];
  }

  async insertBookingRequirementAnswer({ bookingId, code, value, displayLabel, unit }) {
    await this.client.query(
      `INSERT INTO booking_requirement_answers
         (game_profile, booking_id, requirement_code, raw_value, numeric_value, unit, display_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [this.gameProfile, bookingId, code, String(value), value, unit, displayLabel],
    );
  }

  async insertBookingCreatedEvent({ id, communityId, bookingId, actorId, correlationId, afterData }) {
    await this.client.query(
      `INSERT INTO booking_change_events
         (game_profile, id, community_id, aggregate_type, aggregate_id, event_type,
          source, actor_type, actor_id, correlation_id, after_data)
       VALUES ($1,$2,$3,'minister_booking',$4,'booking_created',
               'website','discord_user',$5,$6,$7)`,
      [this.gameProfile, id, communityId, bookingId, actorId, correlationId, afterData],
    );
  }

  async insertBookingOutboxEvent({ id, communityId, idempotencyKey, correlationId, payload }) {
    await this.client.query(
      `INSERT INTO booking_outbox
         (game_profile, id, community_id, event_type, payload, idempotency_key, correlation_id)
       VALUES ($1,$2,$3,'booking.created',$4,$5,$6)`,
      [this.gameProfile, id, communityId, payload, idempotencyKey, correlationId],
    );
  }

  async findCurrentBookingWindow(communityId) {
    const result = await this.client.query(
      `SELECT game_profile, id, community_id, status
       FROM booking_windows
       WHERE game_profile = $1
         AND community_id = $2
         AND status IN ('open', 'closed')
       ORDER BY
         CASE WHEN status = 'open' THEN 0 ELSE 1 END,
         COALESCE(opened_at, created_at) DESC,
         id
       LIMIT 1`,
      [this.gameProfile, communityId],
    );
    return result.rows[0] ?? null;
  }

  async listActiveMinisterServices() {
    const result = await this.client.query(
      `SELECT game_profile, service_code, display_label, appointment_label,
              sort_order
       FROM minister_services
       WHERE game_profile = $1 AND active = true
       ORDER BY sort_order, service_code`,
      [this.gameProfile],
    );
    return result.rows;
  }

  async listServiceDates(communityId, windowId) {
    const result = await this.client.query(
      `SELECT dates.game_profile, dates.service_code, dates.booking_date
       FROM booking_service_dates AS dates
       JOIN minister_services AS service
         ON service.game_profile = dates.game_profile
        AND service.service_code = dates.service_code
       WHERE dates.game_profile = $1
         AND dates.community_id = $2
         AND dates.window_id = $3
         AND service.active = true
       ORDER BY service.sort_order, dates.service_code`,
      [this.gameProfile, communityId, windowId],
    );
    return result.rows;
  }

  async findBookingSettings(communityId) {
    const result = await this.client.query(
      `SELECT game_profile, community_id,
              construction_fc_required,
              construction_rfc_required,
              construction_speedups_required,
              research_shards_required,
              research_speedups_required,
              troop_speedups_required
       FROM booking_settings
       WHERE game_profile = $1 AND community_id = $2`,
      [this.gameProfile, communityId],
    );
    return result.rows[0] ?? null;
  }

  async listAvailableAppointmentSlots(communityId, windowId, serviceCode) {
    const result = await this.client.query(
      `SELECT slot.id, slot.service_code, slot.booking_date,
              slot.display_time_label, slot.ordinal
       FROM appointment_slots AS slot
       JOIN booking_communities AS community
         ON community.game_profile = slot.game_profile
        AND community.id = slot.community_id
       JOIN booking_windows AS booking_window
         ON booking_window.game_profile = slot.game_profile
        AND booking_window.id = slot.window_id
        AND booking_window.community_id = slot.community_id
       JOIN minister_services AS service
         ON service.game_profile = slot.game_profile
        AND service.service_code = slot.service_code
       WHERE slot.game_profile = $1
         AND slot.community_id = $2
         AND slot.window_id = $3
         AND slot.service_code = $4
         AND slot.status = 'available'
         AND community.status = 'active'
         AND community.bookings_open = true
         AND booking_window.status = 'open'
         AND service.active = true
         AND NOT EXISTS (
           SELECT 1
           FROM minister_bookings AS booking
           WHERE booking.game_profile = slot.game_profile
             AND booking.slot_id = slot.id
             AND booking.status = 'confirmed'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM booking_slot_blocks AS block
           WHERE block.game_profile = slot.game_profile
             AND block.slot_id = slot.id
             AND block.cancelled_at IS NULL
         )
       ORDER BY slot.ordinal, slot.id`,
      [this.gameProfile, communityId, windowId, serviceCode],
    );
    return result.rows;
  }

  async findActiveParticipantByDiscordUser(communityId, discordUserId) {
    const participants = await this.listActiveParticipantsByDiscordUser(
      communityId,
      discordUserId,
    );
    return participants[0] ?? null;
  }

  async listActiveParticipantsByDiscordUser(communityId, discordUserId) {
    const result = await this.client.query(
      `SELECT game_profile, id, community_id, discord_user_id, player_id,
              in_game_name, alliance
       FROM booking_participants
       WHERE game_profile = $1
         AND community_id = $2
         AND discord_user_id = $3
         AND status = 'active'
       ORDER BY id
       LIMIT 2`,
      [this.gameProfile, communityId, discordUserId],
    );
    return result.rows;
  }

  async lockActiveParticipantsByDiscordUser(communityId, discordUserId) {
    const result = await this.client.query(
      `SELECT game_profile, id, community_id, discord_user_id, player_id,
              in_game_name, alliance
       FROM booking_participants
       WHERE game_profile = $1
         AND community_id = $2
         AND discord_user_id = $3
         AND status = 'active'
       ORDER BY id
       LIMIT 2
       FOR UPDATE`,
      [this.gameProfile, communityId, discordUserId],
    );
    return result.rows;
  }

  async insertWebsiteParticipant({
    id,
    communityId,
    discordUserId,
    playerId,
    inGameName,
    alliance,
    idempotencyKey,
    correlationId,
  }) {
    const result = await this.client.query(
      `INSERT INTO booking_participants
         (game_profile, id, community_id, discord_user_id, player_id,
          in_game_name, alliance, source, idempotency_key, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'website', $8, $9)
       RETURNING game_profile, id, community_id, discord_user_id, player_id,
                 in_game_name, alliance`,
      [
        this.gameProfile,
        id,
        communityId,
        discordUserId,
        playerId,
        inGameName,
        alliance,
        idempotencyKey,
        correlationId,
      ],
    );
    return result.rows[0];
  }

  async updateWebsiteParticipant({
    id,
    communityId,
    discordUserId,
    playerId,
    inGameName,
    alliance,
    idempotencyKey,
    correlationId,
  }) {
    const result = await this.client.query(
      `UPDATE booking_participants
       SET player_id = $5,
           in_game_name = $6,
           alliance = $7,
           source = 'website',
           idempotency_key = $8,
           correlation_id = $9,
           updated_at = now()
       WHERE game_profile = $1
         AND id = $2
         AND community_id = $3
         AND discord_user_id = $4
         AND status = 'active'
       RETURNING game_profile, id, community_id, discord_user_id, player_id,
                 in_game_name, alliance`,
      [
        this.gameProfile,
        id,
        communityId,
        discordUserId,
        playerId,
        inGameName,
        alliance,
        idempotencyKey,
        correlationId,
      ],
    );
    return result.rows[0] ?? null;
  }

  async insertParticipantChangeEvent({
    id,
    communityId,
    participantId,
    eventType,
    actorId,
    correlationId,
    beforeData,
    afterData,
  }) {
    await this.client.query(
      `INSERT INTO booking_change_events
         (game_profile, id, community_id, aggregate_type, aggregate_id,
          event_type, source, actor_type, actor_id, correlation_id,
          before_data, after_data)
       VALUES ($1, $2, $3, 'booking_participant', $4, $5, 'website',
               'discord_user', $6, $7, $8, $9)`,
      [
        this.gameProfile,
        id,
        communityId,
        participantId,
        eventType,
        actorId,
        correlationId,
        beforeData,
        afterData,
      ],
    );
  }

  async listConfirmedBookingsForParticipant(communityId, participantId) {
    const result = await this.client.query(
      `SELECT booking.id, booking.service_code, booking.booking_date,
              booking.display_time_label_snapshot,
              slot.ordinal
       FROM minister_bookings AS booking
       JOIN appointment_slots AS slot
         ON slot.game_profile = booking.game_profile
        AND slot.id = booking.slot_id
       WHERE booking.game_profile = $1
         AND booking.community_id = $2
         AND booking.participant_id = $3
         AND booking.status = 'confirmed'
       ORDER BY booking.booking_date, slot.ordinal, booking.id`,
      [this.gameProfile, communityId, participantId],
    );
    return result.rows;
  }
}

export function createProfileScopedBookingRepository(gameProfile, pool) {
  assertGameProfile(gameProfile);

  async function withTransaction(work) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.game_profile', $1, true)",
        [gameProfile],
      );
      const result = await work(
        new ProfileScopedBookingSession(client, gameProfile),
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    gameProfile,
    withTransaction,
    findCommunityById(id) {
      return withTransaction((session) => session.findCommunityById(id));
    },
    findCommunityByLocationCode(locationCode) {
      return withTransaction((session) =>
        session.findCommunityByLocationCode(locationCode),
      );
    },
    findCommunityForDiscordGuild(discordGuildId) {
      return withTransaction((session) =>
        session.findCommunityForDiscordGuild(discordGuildId),
      );
    },
    findIdempotencyRecord(communityId, idempotencyKey) {
      return withTransaction((session) =>
        session.findIdempotencyRecord(communityId, idempotencyKey),
      );
    },
    findCurrentBookingWindow(communityId) {
      return withTransaction((session) =>
        session.findCurrentBookingWindow(communityId),
      );
    },
    listActiveMinisterServices() {
      return withTransaction((session) =>
        session.listActiveMinisterServices(),
      );
    },
    listServiceDates(communityId, windowId) {
      return withTransaction((session) =>
        session.listServiceDates(communityId, windowId),
      );
    },
    findBookingSettings(communityId) {
      return withTransaction((session) =>
        session.findBookingSettings(communityId),
      );
    },
    listAvailableAppointmentSlots(communityId, windowId, serviceCode) {
      return withTransaction((session) =>
        session.listAvailableAppointmentSlots(
          communityId,
          windowId,
          serviceCode,
        ),
      );
    },
    findActiveParticipantByDiscordUser(communityId, discordUserId) {
      return withTransaction((session) =>
        session.findActiveParticipantByDiscordUser(
          communityId,
          discordUserId,
        ),
      );
    },
    listActiveParticipantsByDiscordUser(communityId, discordUserId) {
      return withTransaction((session) =>
        session.listActiveParticipantsByDiscordUser(
          communityId,
          discordUserId,
        ),
      );
    },
    listConfirmedBookingsForParticipant(communityId, participantId) {
      return withTransaction((session) =>
        session.listConfirmedBookingsForParticipant(
          communityId,
          participantId,
        ),
      );
    },
  });
}
