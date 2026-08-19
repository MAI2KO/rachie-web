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
