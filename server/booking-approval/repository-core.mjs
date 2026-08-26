import { withDevelopmentTiming } from "../development-timing.mjs";

const GAME_PROFILES = new Set(["wos", "kingshot"]);

class ProfileScopedApprovalSession {
  constructor(client, gameProfile) {
    this.client = client;
    this.gameProfile = gameProfile;
  }

  async findActiveShareLink(tokenHash) {
    const result = await this.client.query(
      `SELECT link.id, link.community_id, community.location_code,
              community.display_name, community.status AS community_status,
              community.bookings_open, settings.booking_approval_policy,
              settings.pending_hold_duration_seconds,
              settings.construction_fc_required,settings.construction_rfc_required,
              settings.construction_speedups_required,settings.research_shards_required,
              settings.research_speedups_required,settings.troop_speedups_required
       FROM booking_guest_share_links AS link
       JOIN booking_communities AS community
         ON community.game_profile = link.game_profile
        AND community.id = link.community_id
       JOIN booking_settings AS settings
         ON settings.game_profile = link.game_profile
        AND settings.community_id = link.community_id
       WHERE link.game_profile = $1
         AND link.token_hash = $2
         AND link.revoked_at IS NULL
         AND (link.expires_at IS NULL OR link.expires_at > now())
       FOR SHARE OF link`,
      [this.gameProfile, tokenHash],
    );
    return result.rows[0] ?? null;
  }

  async lockCommunity(communityId) {
    const result = await this.client.query(
      `SELECT id, location_code, display_name, status, bookings_open
       FROM booking_communities
       WHERE game_profile = $1 AND id = $2
       FOR UPDATE`,
      [this.gameProfile, communityId],
    );
    return result.rows[0] ?? null;
  }

  async lockSlot(communityId, slotId) {
    const result = await this.client.query(
      `SELECT slot.id, slot.community_id, slot.window_id, slot.service_date_id,
              slot.service_code, slot.booking_date, slot.display_time_label,
              slot.status AS slot_status, booking_window.status AS window_status,
              booking_window.opens_at, booking_window.closes_at,
              COALESCE(community_service.enabled, service.active) AS service_active,
              service.display_label AS service_label
       FROM appointment_slots AS slot
       JOIN booking_windows AS booking_window
         ON booking_window.game_profile = slot.game_profile
        AND booking_window.id = slot.window_id
        AND booking_window.community_id = slot.community_id
       JOIN minister_services AS service
         ON service.game_profile = slot.game_profile
        AND service.service_code = slot.service_code
       LEFT JOIN booking_community_services AS community_service
         ON community_service.game_profile = slot.game_profile
        AND community_service.community_id = slot.community_id
        AND community_service.service_code = slot.service_code
       WHERE slot.game_profile = $1 AND slot.community_id = $2 AND slot.id = $3
       FOR UPDATE OF slot`,
      [this.gameProfile, communityId, slotId],
    );
    return result.rows[0] ?? null;
  }

  async claimGuestRequestIdempotency({ communityId, idempotencyKey, requestHash, correlationId }) {
    const claimed = await this.client.query(
      `INSERT INTO booking_idempotency_keys
         (game_profile,community_id,idempotency_key,operation,request_hash,correlation_id)
       VALUES ($1,$2,$3,'guest_booking_request',$4,$5)
       ON CONFLICT (game_profile,community_id,idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [this.gameProfile, communityId, idempotencyKey, requestHash, correlationId],
    );
    if (claimed.rowCount === 1) return { state: "claimed" };
    const existing = await this.client.query(
      `SELECT operation,request_hash,status,response_status,response_body
       FROM booking_idempotency_keys
       WHERE game_profile=$1 AND community_id=$2 AND idempotency_key=$3`,
      [this.gameProfile, communityId, idempotencyKey],
    );
    return { state: "existing", record: existing.rows[0] ?? null };
  }

  async completeIdempotency(communityId, idempotencyKey, responseStatus, responseBody) {
    await this.client.query(
      `UPDATE booking_idempotency_keys
       SET status='completed',response_status=$4,response_body=$5,completed_at=now()
       WHERE game_profile=$1 AND community_id=$2 AND idempotency_key=$3`,
      [this.gameProfile, communityId, idempotencyKey, responseStatus, responseBody],
    );
  }

  async findSettings(communityId) {
    const result = await this.client.query(
      `SELECT community_id,booking_approval_policy,pending_hold_duration_seconds,
              construction_fc_required,construction_rfc_required,
              construction_speedups_required,research_shards_required,
              research_speedups_required,troop_speedups_required
       FROM booking_settings
       WHERE game_profile=$1 AND community_id=$2`,
      [this.gameProfile, communityId],
    );
    return result.rows[0] ?? null;
  }

  async hasActiveSlotBlock(slotId) {
    const result = await this.client.query(
      `SELECT EXISTS (
         SELECT 1 FROM booking_slot_blocks
         WHERE game_profile=$1 AND slot_id=$2 AND cancelled_at IS NULL
       ) AS exists`,
      [this.gameProfile, slotId],
    );
    return result.rows[0].exists;
  }

  async hasConfirmedBooking(slotId) {
    const result = await this.client.query(
      `SELECT EXISTS (
         SELECT 1 FROM minister_bookings
         WHERE game_profile=$1 AND slot_id=$2 AND status='confirmed'
       ) AS exists`,
      [this.gameProfile, slotId],
    );
    return result.rows[0].exists;
  }

  async expirePendingForSlot(slotId, at) {
    const result = await this.client.query(
      `UPDATE booking_approval_requests
       SET status='expired',decided_at=$3,version=version+1,updated_at=$3
       WHERE game_profile=$1 AND slot_id=$2
         AND status='pending_approval' AND hold_expires_at <= $3
       RETURNING id,community_id,correlation_id`,
      [this.gameProfile, slotId, at],
    );
    return result.rows;
  }

  async expirePendingForPlayerService(communityId, serviceCode, playerId, at) {
    const result = await this.client.query(
      `UPDATE booking_approval_requests
       SET status='expired',decided_at=$5,version=version+1,updated_at=$5
       WHERE game_profile=$1 AND community_id=$2 AND service_code=$3
         AND player_id_snapshot=$4 AND status='pending_approval'
         AND hold_expires_at <= $5
       RETURNING id,community_id,correlation_id`,
      [this.gameProfile, communityId, serviceCode, playerId, at],
    );
    return result.rows;
  }

  async lockGuestPlayerService(communityId, serviceCode, playerId) {
    await this.client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`guest-player:${this.gameProfile}:${communityId}:${serviceCode}:${playerId}`],
    );
  }

  async hasActivePendingForPlayerService(communityId, serviceCode, playerId, at) {
    const result = await this.client.query(
      `SELECT EXISTS (SELECT 1 FROM booking_approval_requests
       WHERE game_profile=$1 AND community_id=$2 AND service_code=$3
         AND player_id_snapshot=$4 AND status='pending_approval'
         AND hold_expires_at>$5) AS exists`,
      [this.gameProfile, communityId, serviceCode, playerId, at],
    );
    return result.rows[0].exists;
  }

  async listGuestBookingRows(communityId, at) {
    const result = await this.client.query(
      `WITH current_window AS (
         SELECT id FROM booking_windows
         WHERE game_profile=$1 AND community_id=$2 AND status='open'
           AND (opens_at IS NULL OR opens_at <= $3)
           AND (closes_at IS NULL OR closes_at > $3)
         ORDER BY created_at DESC,id DESC LIMIT 1
       )
       SELECT slot.id AS slot_id,slot.service_code,service.display_label AS service_label,
              service.sort_order,slot.booking_date,slot.display_time_label,slot.ordinal,
              EXISTS (SELECT 1 FROM minister_bookings AS booking
                WHERE booking.game_profile=slot.game_profile AND booking.slot_id=slot.id
                  AND booking.status='confirmed') AS is_confirmed,
              EXISTS (SELECT 1 FROM booking_approval_requests AS pending
                WHERE pending.game_profile=slot.game_profile AND pending.slot_id=slot.id
                  AND pending.status='pending_approval' AND pending.hold_expires_at>$3) AS has_active_hold
       FROM appointment_slots AS slot
       JOIN current_window ON current_window.id=slot.window_id
       JOIN minister_services AS service
         ON service.game_profile=slot.game_profile AND service.service_code=slot.service_code
       LEFT JOIN booking_community_services AS community_service
         ON community_service.game_profile=slot.game_profile
        AND community_service.community_id=slot.community_id
        AND community_service.service_code=slot.service_code
       WHERE slot.game_profile=$1 AND slot.community_id=$2 AND slot.status='available'
         AND COALESCE(community_service.enabled,service.active)=true
         AND NOT EXISTS (SELECT 1 FROM booking_slot_blocks AS block
           WHERE block.game_profile=slot.game_profile AND block.slot_id=slot.id
             AND block.cancelled_at IS NULL)
       ORDER BY service.sort_order,slot.ordinal,slot.id`,
      [this.gameProfile, communityId, at],
    );
    return result.rows;
  }

  async hasActiveApprovalHold(slotId, at) {
    const result = await this.client.query(
      `SELECT EXISTS (
         SELECT 1 FROM booking_approval_requests
         WHERE game_profile=$1 AND slot_id=$2
           AND status='pending_approval' AND hold_expires_at > $3
       ) AS exists`,
      [this.gameProfile, slotId, at],
    );
    return result.rows[0].exists;
  }

  async insertApprovalRequest(input) {
    const result = await this.client.query(
      `INSERT INTO booking_approval_requests
         (game_profile,id,community_id,window_id,service_date_id,service_code,
          booking_date,slot_id,request_source,share_link_id,player_id_snapshot,
          in_game_name_snapshot,alliance_snapshot,display_time_label_snapshot,
          hold_expires_at,idempotency_key,correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'guest_link',$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [this.gameProfile, input.id, input.communityId, input.windowId,
       input.serviceDateId, input.serviceCode, input.bookingDate, input.slotId,
       input.shareLinkId, input.playerId, input.inGameName, input.alliance,
       input.displayTime, input.holdExpiresAt, input.idempotencyKey,
       input.correlationId],
    );
    return result.rows[0];
  }

  async insertRequestAnswer({ requestId, code, value, displayLabel, unit }) {
    await this.client.query(
      `INSERT INTO booking_approval_request_answers
         (game_profile,request_id,requirement_code,raw_value,numeric_value,unit,display_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [this.gameProfile, requestId, code, String(value), value, unit, displayLabel],
    );
  }

  async insertApprovalEvent(input) {
    await this.client.query(
      `INSERT INTO booking_approval_events
         (game_profile,id,community_id,request_id,action,actor_type,
          acting_discord_user_id,acting_discord_display_name,previous_state,
          resulting_state,correlation_id,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [this.gameProfile, input.id, input.communityId, input.requestId,
       input.action, input.actorType, input.actorDiscordUserId ?? null,
       input.actorDisplayName ?? null, input.previousState ?? null,
       input.resultingState, input.correlationId, input.metadata ?? {}],
    );
  }

  async insertApprovalOutbox(input) {
    await this.client.query(
      `INSERT INTO booking_outbox
         (game_profile,id,community_id,event_type,payload,idempotency_key,correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [this.gameProfile, input.id, input.communityId, input.eventType,
       input.payload, input.idempotencyKey, input.correlationId],
    );
  }

  async markRequestMessagesForUpdate(requestId) {
    await this.client.query(
      `UPDATE booking_approval_discord_messages
       SET delivery_status='update_pending',updated_at=now()
       WHERE game_profile=$1 AND request_id=$2
         AND delivery_status IN ('sent','updated')`,
      [this.gameProfile, requestId],
    );
  }

  async findRequest(requestId) {
    const result = await this.client.query(
      `SELECT * FROM booking_approval_requests
       WHERE game_profile=$1 AND id=$2`,
      [this.gameProfile, requestId],
    );
    return result.rows[0] ?? null;
  }

  async lockRequest(requestId) {
    const result = await this.client.query(
      `SELECT * FROM booking_approval_requests
       WHERE game_profile=$1 AND id=$2
       FOR UPDATE`,
      [this.gameProfile, requestId],
    );
    return result.rows[0] ?? null;
  }

  async expireRequest(requestId, at) {
    const result = await this.client.query(
      `UPDATE booking_approval_requests
       SET status='expired',decided_at=$3,version=version+1,updated_at=$3
       WHERE game_profile=$1 AND id=$2 AND status='pending_approval'
         AND hold_expires_at <= $3
       RETURNING *`,
      [this.gameProfile, requestId, at],
    );
    return result.rows[0] ?? null;
  }

  async denyRequest(requestId, actor, at) {
    const result = await this.client.query(
      `UPDATE booking_approval_requests
       SET status='denied',decided_at=$4,decided_by_discord_user_id=$3,
           decided_by_display_name=$5,version=version+1,updated_at=$4
       WHERE game_profile=$1 AND id=$2 AND status='pending_approval'
         AND hold_expires_at > $4
       RETURNING *`,
      [this.gameProfile, requestId, actor.discordUserId, at, actor.displayName],
    );
    return result.rows[0] ?? null;
  }

  async insertConfirmedBookingFromRequest(request, bookingId, actor, correlationId) {
    const result = await this.client.query(
      `INSERT INTO minister_bookings
         (game_profile,id,community_id,window_id,service_date_id,service_code,
          booking_date,slot_id,player_id_snapshot,in_game_name_snapshot,
          alliance_snapshot,display_time_label_snapshot,source,actor_type,
          actor_id,idempotency_key,correlation_id,approval_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               'website','admin',$13,$14,$15,$16)
       RETURNING *`,
      [this.gameProfile, bookingId, request.community_id, request.window_id,
       request.service_date_id, request.service_code, request.booking_date,
       request.slot_id, request.player_id_snapshot, request.in_game_name_snapshot,
       request.alliance_snapshot, request.display_time_label_snapshot,
       actor.discordUserId, request.idempotency_key, correlationId, request.id],
    );
    return result.rows[0];
  }

  async copyRequestAnswersToBooking(requestId, bookingId) {
    await this.client.query(
      `INSERT INTO booking_requirement_answers
         (game_profile,booking_id,requirement_code,raw_value,numeric_value,unit,display_label)
       SELECT game_profile,$3,requirement_code,raw_value,numeric_value,unit,display_label
       FROM booking_approval_request_answers
       WHERE game_profile=$1 AND request_id=$2`,
      [this.gameProfile, requestId, bookingId],
    );
  }

  async confirmRequest(requestId, bookingId, actor, at) {
    const result = await this.client.query(
      `UPDATE booking_approval_requests
       SET status='confirmed',decided_at=$4,decided_by_discord_user_id=$3,
           decided_by_display_name=$5,confirmed_booking_id=$6,
           version=version+1,updated_at=$4
       WHERE game_profile=$1 AND id=$2 AND status='pending_approval'
         AND hold_expires_at > $4
       RETURNING *`,
      [this.gameProfile, requestId, actor.discordUserId, at, actor.displayName, bookingId],
    );
    return result.rows[0] ?? null;
  }

  async findActiveCommunityByLocationCode(locationCode) {
    const result = await this.client.query(
      `SELECT id,location_code,display_name
       FROM booking_communities
       WHERE game_profile=$1 AND location_code=$2 AND status='active'`,
      [this.gameProfile, locationCode],
    );
    return result.rows[0] ?? null;
  }

  async findActiveCommunityById(communityId) {
    const result = await this.client.query(
      `SELECT id,location_code,display_name
       FROM booking_communities
       WHERE game_profile=$1 AND id=$2 AND status='active'`,
      [this.gameProfile, communityId],
    );
    return result.rows[0] ?? null;
  }

  async listLinkedManagerGuilds(communityId) {
    const result = await this.client.query(
      `SELECT discord_guild_id,bot_manager_role_id
       FROM booking_discord_guilds
       WHERE game_profile=$1 AND community_id=$2
       ORDER BY discord_guild_id`,
      [this.gameProfile, communityId],
    );
    return result.rows;
  }

  async listBoardRows(communityId, at) {
    const result = await this.client.query(
      `WITH current_window AS (
         SELECT booking_window.id
         FROM booking_windows AS booking_window
         WHERE booking_window.game_profile=$1 AND booking_window.community_id=$2
           AND booking_window.status<>'archived'
         ORDER BY CASE booking_window.status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                  booking_window.created_at DESC,booking_window.id DESC
         LIMIT 1
       )
       SELECT slot.service_code,service.display_label AS service_label,service.sort_order,
              slot.booking_date,slot.display_time_label,slot.ordinal,
              (booking.id IS NOT NULL) AS is_confirmed,
              booking.alliance_snapshot AS confirmed_alliance,
              booking.in_game_name_snapshot AS confirmed_player_name,
              (pending.id IS NOT NULL) AS has_active_hold
       FROM appointment_slots AS slot
       JOIN current_window ON current_window.id=slot.window_id
       JOIN minister_services AS service
         ON service.game_profile=slot.game_profile AND service.service_code=slot.service_code
       LEFT JOIN minister_bookings AS booking
         ON booking.game_profile=slot.game_profile
        AND booking.slot_id=slot.id AND booking.status='confirmed'
       LEFT JOIN booking_approval_requests AS pending
         ON pending.game_profile=slot.game_profile
        AND pending.slot_id=slot.id AND pending.status='pending_approval'
        AND pending.hold_expires_at > $3
       WHERE slot.game_profile=$1 AND slot.community_id=$2
         AND slot.status='available'
         AND NOT EXISTS (
           SELECT 1 FROM booking_slot_blocks AS block
           WHERE block.game_profile=slot.game_profile AND block.slot_id=slot.id
             AND block.cancelled_at IS NULL
         )
       ORDER BY service.sort_order,slot.booking_date,slot.ordinal,slot.id`,
      [this.gameProfile, communityId, at],
    );
    return result.rows;
  }

  async listManagerBoardRows(communityId, at) {
    const result = await this.client.query(
      `WITH current_window AS (
         SELECT booking_window.id
         FROM booking_windows AS booking_window
         WHERE booking_window.game_profile=$1 AND booking_window.community_id=$2
           AND booking_window.status<>'archived'
         ORDER BY CASE booking_window.status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                  booking_window.created_at DESC,booking_window.id DESC
         LIMIT 1
       )
       SELECT slot.id AS slot_id,slot.service_code,service.display_label AS service_label,
              service.sort_order,slot.booking_date,slot.display_time_label,slot.ordinal,
              booking.id AS confirmed_booking_id,
              booking.in_game_name_snapshot AS confirmed_player_name,
              booking.player_id_snapshot AS confirmed_player_id,
              booking.alliance_snapshot AS confirmed_alliance,
              booking.discord_user_id AS confirmed_discord_user_id,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'code',answer.requirement_code,'label',answer.display_label,
                'value',answer.numeric_value,'unit',answer.unit
              ) ORDER BY answer.requirement_code)
              FROM booking_requirement_answers AS answer
              WHERE answer.game_profile=booking.game_profile AND answer.booking_id=booking.id),'[]'::jsonb)
                AS confirmed_requirements,
              pending.id AS pending_request_id,
              pending.in_game_name_snapshot AS pending_player_name,
              pending.player_id_snapshot AS pending_player_id,
              pending.alliance_snapshot AS pending_alliance,
              pending.discord_user_id AS pending_discord_user_id,
              pending.hold_expires_at AS pending_hold_expires_at,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'code',answer.requirement_code,'label',answer.display_label,
                'value',answer.numeric_value,'unit',answer.unit
              ) ORDER BY answer.requirement_code)
              FROM booking_approval_request_answers AS answer
              WHERE answer.game_profile=pending.game_profile AND answer.request_id=pending.id),'[]'::jsonb)
                AS pending_requirements
       FROM appointment_slots AS slot
       JOIN current_window ON current_window.id=slot.window_id
       JOIN minister_services AS service
         ON service.game_profile=slot.game_profile AND service.service_code=slot.service_code
       LEFT JOIN minister_bookings AS booking
         ON booking.game_profile=slot.game_profile AND booking.slot_id=slot.id
        AND booking.status='confirmed'
       LEFT JOIN booking_approval_requests AS pending
         ON pending.game_profile=slot.game_profile AND pending.slot_id=slot.id
        AND pending.status='pending_approval' AND pending.hold_expires_at>$3
       WHERE slot.game_profile=$1 AND slot.community_id=$2 AND slot.status='available'
         AND NOT EXISTS (SELECT 1 FROM booking_slot_blocks AS block
           WHERE block.game_profile=slot.game_profile AND block.slot_id=slot.id
             AND block.cancelled_at IS NULL)
       ORDER BY service.sort_order,slot.booking_date,slot.ordinal,slot.id`,
      [this.gameProfile, communityId, at],
    );
    return result.rows;
  }

  async listRecentApprovalActivity(communityId, limit) {
    const result = await this.client.query(
      `SELECT activity.* FROM (
         SELECT event.id,event.action,request.in_game_name_snapshot AS player_name,
                event.acting_discord_display_name,event.previous_state,
                event.resulting_state,NULL::text AS previous_time,NULL::text AS new_time,
                event.created_at
         FROM booking_approval_events AS event
         JOIN booking_approval_requests AS request
           ON request.game_profile=event.game_profile AND request.id=event.request_id
         WHERE event.game_profile=$1 AND event.community_id=$2
         UNION ALL
         SELECT event.id,event.event_type AS action,
                booking.in_game_name_snapshot AS player_name,
                event.after_data->>'actorDisplayName' AS acting_discord_display_name,
                event.before_data->>'status' AS previous_state,
                CASE event.event_type
                  WHEN 'manager_booking_rescheduled' THEN 'rescheduled'
                  ELSE 'cancelled'
                END AS resulting_state,
                event.before_data->>'displayTime' AS previous_time,
                event.after_data->>'displayTime' AS new_time,event.created_at
         FROM booking_change_events AS event
         JOIN minister_bookings AS booking
           ON booking.game_profile=event.game_profile AND booking.id=event.aggregate_id
         WHERE event.game_profile=$1 AND event.community_id=$2
           AND event.event_type IN ('manager_booking_rescheduled','manager_booking_cancelled')
       ) AS activity
       ORDER BY activity.created_at DESC,activity.id DESC
       LIMIT $3`,
      [this.gameProfile, communityId, limit],
    );
    return result.rows;
  }

  async findRequestDetail(communityId, requestId) {
    const result = await this.client.query(
      `SELECT request.*,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'code',answer.requirement_code,'label',answer.display_label,
             'value',answer.numeric_value,'unit',answer.unit
           ) ORDER BY answer.requirement_code)
           FROM booking_approval_request_answers AS answer
           WHERE answer.game_profile=request.game_profile
             AND answer.request_id=request.id
         ),'[]'::jsonb) AS requirements,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'action',event.action,'actorType',event.actor_type,
             'actingDiscordUserId',event.acting_discord_user_id,
             'actingDiscordDisplayName',event.acting_discord_display_name,
             'previousState',event.previous_state,
             'resultingState',event.resulting_state,
             'createdAt',event.created_at
           ) ORDER BY event.created_at,event.id)
           FROM booking_approval_events AS event
           WHERE event.game_profile=request.game_profile
             AND event.request_id=request.id
         ),'[]'::jsonb) AS audit
       FROM booking_approval_requests AS request
       WHERE request.game_profile=$1 AND request.community_id=$2 AND request.id=$3`,
      [this.gameProfile, communityId, requestId],
    );
    return result.rows[0] ?? null;
  }
}

export function createProfileScopedApprovalRepository(gameProfile, pool) {
  if (!GAME_PROFILES.has(gameProfile)) throw new TypeError("Unsupported approval game profile.");

  async function withTransaction(work) {
    return withDevelopmentTiming(`database approval transaction (${gameProfile})`, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.game_profile',$1,true)", [gameProfile]);
        const result = await work(new ProfileScopedApprovalSession(client, gameProfile));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

  return Object.freeze({ gameProfile, withTransaction });
}
