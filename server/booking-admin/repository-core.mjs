import { withDevelopmentTiming } from "../development-timing.mjs";
import { BOOKING_ADMIN_REQUIREMENT_COLUMNS } from "./domain-core.mjs";

const PROFILES = new Set(["wos", "kingshot"]);

class BookingAdminSession {
  constructor(client, gameProfile) {
    this.client = client;
    this.gameProfile = gameProfile;
  }

  async lockCommunity(communityId) {
    const result = await this.client.query(
      `SELECT id,location_code,display_name,status,bookings_open
         FROM booking_communities
        WHERE game_profile=$1 AND id=$2
        FOR UPDATE`,
      [this.gameProfile, communityId],
    );
    return result.rows[0] ?? null;
  }

  async readSnapshot(communityId, lockedCommunity = null) {
    const community = lockedCommunity ?? (await this.client.query(
      `SELECT id,location_code,display_name,status,bookings_open
         FROM booking_communities
        WHERE game_profile=$1 AND id=$2 AND status='active'`,
      [this.gameProfile, communityId],
    )).rows[0] ?? null;
    if (!community || community.status !== "active") return null;
    const [services, settings, windows, dates, guestLinks, guilds, scheduleOverrides,
      recurringDefaults, guildLinkRequests, activityPage] = await Promise.all([
      this.client.query(
        `SELECT service.service_code,service.display_label,service.sort_order,
                COALESCE(community_service.enabled,service.active) AS enabled
           FROM minister_services AS service
           LEFT JOIN booking_community_services AS community_service
             ON community_service.game_profile=service.game_profile
            AND community_service.community_id=$2
            AND community_service.service_code=service.service_code
          WHERE service.game_profile=$1
          ORDER BY service.sort_order,service.service_code`,
        [this.gameProfile, communityId],
      ),
      this.client.query(
        `SELECT construction_fc_required,construction_rfc_required,
                construction_speedups_required,research_shards_required,
                research_speedups_required,troop_speedups_required
           FROM booking_settings
          WHERE game_profile=$1 AND community_id=$2`,
        [this.gameProfile, communityId],
      ),
      this.client.query(
        `SELECT id,status,opens_at,closes_at
           FROM booking_windows
          WHERE game_profile=$1 AND community_id=$2 AND status<>'archived'
          ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                   created_at DESC,id DESC`,
        [this.gameProfile, communityId],
      ),
      this.client.query(
        `SELECT dates.service_code,service.display_label,dates.booking_date,
                booking_window.status AS window_status
           FROM booking_service_dates AS dates
           JOIN booking_windows AS booking_window
             ON booking_window.game_profile=dates.game_profile
            AND booking_window.id=dates.window_id
            AND booking_window.community_id=dates.community_id
           JOIN minister_services AS service
             ON service.game_profile=dates.game_profile
            AND service.service_code=dates.service_code
          WHERE dates.game_profile=$1 AND dates.community_id=$2
            AND booking_window.status<>'archived'
          ORDER BY dates.booking_date,service.sort_order,dates.service_code`,
        [this.gameProfile, communityId],
      ),
      this.client.query(
        `SELECT id,created_at,expires_at,revoked_at
           FROM booking_guest_share_links
          WHERE game_profile=$1 AND community_id=$2
          ORDER BY created_at DESC,id DESC
          LIMIT 1`,
        [this.gameProfile, communityId],
      ),
      this.client.query(
        `SELECT discord_guild_id,discord_guild_name,guild_kind,link_status,revoked_at
           FROM booking_discord_guilds
          WHERE game_profile=$1 AND community_id=$2
          ORDER BY CASE guild_kind WHEN 'state' THEN 0 ELSE 1 END,discord_guild_name,discord_guild_id`,
        [this.gameProfile, communityId],
      ),
      this.client.query(
        `SELECT cycle_index,opens_at,closes_at,created_at,updated_at
           FROM booking_cycle_schedule_overrides
          WHERE game_profile=$1 AND community_id=$2
          ORDER BY cycle_index`,
        [this.gameProfile, communityId],
      ),
      this.client.query(
        `SELECT open_minute_utc,close_offset_minutes,created_at,updated_at
           FROM booking_community_window_defaults
          WHERE game_profile=$1 AND community_id=$2`,
        [this.gameProfile, communityId],
      ),
      this.client.query(
        `SELECT id,requesting_discord_guild_id,requesting_discord_guild_name,
                requested_guild_kind,alliance_abbreviation,
                requested_by_discord_user_id,requested_at
           FROM community_guild_link_requests
          WHERE game_profile=$1 AND community_id=$2 AND status='pending'
          ORDER BY requested_at,id`,
        [this.gameProfile, communityId],
      ),
      this.listRecentActivity(communityId, 100),
    ]);
    return {
      community,
      services: services.rows,
      settings: settings.rows[0] ?? null,
      windows: windows.rows,
      dates: dates.rows,
      guestLink: guestLinks.rows[0] ?? null,
      guilds: guilds.rows,
      scheduleOverrides: scheduleOverrides.rows,
      recurringDefault: recurringDefaults.rows[0] ?? null,
      guildLinkRequests: guildLinkRequests.rows,
      activity: activityPage.rows,
      activityNextCursor: activityPage.nextCursor,
    };
  }

  async listRecentActivity(communityId, limit, cursor = null) {
    const result = await this.client.query(
      `SELECT activity.* FROM (
         SELECT event.id,event.action,'approvals'::text AS category,
                request.in_game_name_snapshot AS player_name,
                request.player_id_snapshot AS player_id,
                event.acting_discord_user_id AS actor_discord_user_id,
                event.acting_discord_display_name AS actor_display_name,
                request.service_code,event.previous_state,event.resulting_state,
                NULL::text AS previous_time,request.display_time_label_snapshot AS new_time,
                request.booking_date::text AS booking_date,NULL::text AS setting_section,
                NULL::text AS requirement_code,NULL::text AS enabled,
                NULL::text AS guild_name,NULL::text AS cycle_index,event.created_at
           FROM booking_approval_events AS event
           JOIN booking_approval_requests AS request
             ON request.game_profile=event.game_profile AND request.id=event.request_id
          WHERE event.game_profile=$1 AND event.community_id=$2
         UNION ALL
         SELECT event.id,event.event_type AS action,
                CASE
                  WHEN event.event_type LIKE '%cancel%' THEN 'cancellations'
                  WHEN event.event_type IN ('booking_created','booking_rescheduled',
                    'manager_booking_rescheduled','manager_manual_booking') THEN 'bookings'
                  WHEN event.event_type='booking_admin_updated'
                    OR event.event_type LIKE 'booking_cycle_override_%'
                    OR event.event_type LIKE 'booking_recurring_window_default_%'
                    OR event.event_type LIKE 'guest_link_%' THEN 'configuration'
                  ELSE 'manager_actions'
                END AS category,
                COALESCE(booking.in_game_name_snapshot,event.after_data->>'playerName',
                  event.after_data#>>'{participant,inGameName}') AS player_name,
                COALESCE(booking.player_id_snapshot,event.after_data->>'playerId',
                  event.after_data#>>'{participant,playerId}') AS player_id,
                event.actor_id AS actor_discord_user_id,
                COALESCE(event.after_data->>'actorDisplayName',identity.global_name,
                  identity.username) AS actor_display_name,
                COALESCE(booking.service_code,event.after_data->>'serviceCode') AS service_code,
                event.before_data->>'status' AS previous_state,
                CASE event.event_type
                  WHEN 'manager_booking_rescheduled' THEN 'rescheduled'
                  WHEN 'booking_rescheduled' THEN 'rescheduled'
                  WHEN 'manager_booking_cancelled' THEN 'cancelled'
                  WHEN 'booking_cancelled' THEN 'cancelled'
                  ELSE COALESCE(event.after_data->>'status',event.event_type)
                END AS resulting_state,
                event.before_data->>'displayTime' AS previous_time,
                COALESCE(event.after_data->>'displayTime',
                  CASE WHEN event.event_type IN ('booking_created','manager_manual_booking')
                    THEN booking.display_time_label_snapshot END) AS new_time,
                COALESCE(booking.booking_date::text,event.after_data->>'date',
                  event.before_data->>'date') AS booking_date,
                event.after_data->>'section' AS setting_section,
                event.after_data->>'requirementCode' AS requirement_code,
                event.after_data->>'enabled' AS enabled,
                COALESCE(event.before_data->>'guildName',event.after_data->>'guildName') AS guild_name,
                event.after_data->>'cycleIndex' AS cycle_index,event.created_at
           FROM booking_change_events AS event
           LEFT JOIN minister_bookings AS booking
             ON event.aggregate_type='minister_booking'
            AND booking.game_profile=event.game_profile AND booking.id=event.aggregate_id
           LEFT JOIN website_discord_identities AS identity
             ON identity.game_profile=event.game_profile
            AND identity.discord_user_id=event.actor_id
          WHERE event.game_profile=$1 AND event.community_id=$2
       ) AS activity
       WHERE ($4::timestamptz IS NULL OR activity.created_at < $4::timestamptz
         OR (activity.created_at = $4::timestamptz AND activity.id < $5::uuid))
       ORDER BY activity.created_at DESC,activity.id DESC
       LIMIT $3`,
      [this.gameProfile, communityId, limit + 1, cursor?.createdAt ?? null, cursor?.id ?? null],
    );
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      rows,
      nextCursor: result.rows.length > limit && last ? {
        createdAt: last.created_at instanceof Date
          ? last.created_at.toISOString() : String(last.created_at),
        id: String(last.id),
      } : null,
    };
  }

  async lockDiscordTopology(communityId) {
    return (await this.client.query(
      `SELECT discord_guild_id,discord_guild_name,guild_kind,link_status,revoked_at
         FROM booking_discord_guilds
        WHERE game_profile=$1 AND community_id=$2
        ORDER BY discord_guild_id FOR UPDATE`,
      [this.gameProfile, communityId],
    )).rows;
  }

  async lockGuildLinkRequest(communityId, requestId) {
    return (await this.client.query(
      `SELECT id,community_id,requesting_discord_guild_id,requesting_discord_guild_name,
              requested_guild_kind,alliance_abbreviation,
              requested_by_discord_user_id,status,requested_at
         FROM community_guild_link_requests
        WHERE game_profile=$1 AND community_id=$2 AND id=$3 FOR UPDATE`,
      [this.gameProfile, communityId, requestId],
    )).rows[0] ?? null;
  }

  async activateRequestedGuildLink({ communityId, request, actorId }) {
    const existing = (await this.client.query(
      `SELECT community_id,guild_kind FROM booking_discord_guilds
        WHERE game_profile=$1 AND discord_guild_id=$2 FOR UPDATE`,
      [this.gameProfile, request.requesting_discord_guild_id],
    )).rows[0] ?? null;
    if (existing && (existing.community_id !== communityId
        || existing.guild_kind !== request.requested_guild_kind)) {
      return { status: "conflict" };
    }
    if (request.requested_guild_kind === "state") {
      const otherState = (await this.client.query(
        `SELECT 1 FROM booking_discord_guilds
          WHERE game_profile=$1 AND community_id=$2 AND guild_kind='state'
            AND link_status='active' AND discord_guild_id<>$3`,
        [this.gameProfile, communityId, request.requesting_discord_guild_id],
      )).rowCount;
      if (otherState) return { status: "state_conflict" };
    }
    await this.client.query(
      `INSERT INTO booking_discord_guilds
         (game_profile,discord_guild_id,community_id,discord_guild_name,linked_by_actor_id,guild_kind)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (game_profile,discord_guild_id) DO UPDATE
         SET discord_guild_name=EXCLUDED.discord_guild_name,
             linked_by_actor_id=EXCLUDED.linked_by_actor_id,link_status='active',
             revoked_at=NULL,revoked_by_actor_id=NULL,revocation_reason=NULL,updated_at=now()`,
      [this.gameProfile, request.requesting_discord_guild_id, communityId,
       request.requesting_discord_guild_name, actorId, request.requested_guild_kind],
    );
    return { status: existing ? "reactivated" : "created" };
  }

  async decideGuildLinkRequest({ requestId, decision, actorId }) {
    await this.client.query(
      `UPDATE community_guild_link_requests
          SET status=$3,decided_by_discord_user_id=$4,decided_at=now(),updated_at=now()
        WHERE game_profile=$1 AND id=$2 AND status='pending'`,
      [this.gameProfile, requestId, decision, actorId],
    );
  }

  async insertGuildLinkDecisionAudit(input) {
    const eventType = `${input.beforeData.guildKind === "state" ? "state" : "alliance"}_guild_link_${input.decision}`;
    await this.client.query(
      `INSERT INTO booking_change_events
         (game_profile,id,community_id,aggregate_type,aggregate_id,event_type,source,
          actor_type,actor_id,correlation_id,before_data,after_data)
       VALUES ($1,$2,$3,'discord_guild_link_request',$4,$5,'website','discord_user',$6,$7,$8,$9)`,
      [this.gameProfile, input.id, input.communityId, input.requestId,
       eventType, input.actorId, input.correlationId,
       input.beforeData, input.afterData],
    );
  }

  async revokeAllianceGuildAccess({ communityId, guildId, actorId }) {
    const link = await this.client.query(
      `UPDATE booking_discord_guilds
          SET link_status='revoked',revoked_at=now(),revoked_by_actor_id=$4,
              revocation_reason='native_owner_unlink',updated_at=now()
        WHERE game_profile=$1 AND community_id=$2 AND discord_guild_id=$3
          AND guild_kind='alliance' AND link_status='active'
        RETURNING discord_guild_id`,
      [this.gameProfile, communityId, guildId, actorId],
    );
    if (link.rowCount === 0) return { changed: false, affectedGrantCount: 0 };
    const revoked = await this.client.query(
      `UPDATE community_access_grants
          SET status='revoked',revoked_at=now(),revoked_by_actor_id=$4,
              revocation_reason='source_guild_unlinked',updated_at=now()
        WHERE game_profile=$1 AND community_id=$2 AND source_guild_id=$3
          AND status='active'
        RETURNING discord_user_id`,
      [this.gameProfile, communityId, guildId, actorId],
    );
    await this.client.query(
      `UPDATE website_auth_session_communities AS session_community
          SET discord_guild_id=replacement.source_guild_id,verified_at=replacement.verified_at
         FROM website_auth_sessions AS session
         CROSS JOIN LATERAL (
           SELECT access.source_guild_id,access.verified_at
             FROM community_access_grants AS access
             JOIN booking_discord_guilds AS guild
               ON guild.game_profile=access.game_profile
              AND guild.community_id=access.community_id
              AND guild.discord_guild_id=access.source_guild_id
            WHERE access.game_profile=$1 AND access.community_id=$2
              AND access.discord_user_id=session.discord_user_id
              AND access.status='active' AND access.source_guild_id<>$3
              AND guild.guild_kind='alliance' AND guild.link_status='active'
            ORDER BY access.source_guild_id LIMIT 1
         ) AS replacement
        WHERE session_community.game_profile=$1 AND session_community.community_id=$2
          AND session_community.discord_guild_id=$3
          AND session.game_profile=session_community.game_profile
          AND session.token_hash=session_community.session_token_hash`,
      [this.gameProfile, communityId, guildId],
    );
    await this.client.query(
      `DELETE FROM website_auth_session_communities
        WHERE game_profile=$1 AND community_id=$2 AND discord_guild_id=$3`,
      [this.gameProfile, communityId, guildId],
    );
    return { changed: true, affectedGrantCount: revoked.rowCount };
  }

  async insertGuildUnlinkAudit(input) {
    await this.client.query(
      `INSERT INTO booking_change_events
         (game_profile,id,community_id,aggregate_type,event_type,source,actor_type,
          actor_id,correlation_id,before_data,after_data)
       VALUES ($1,$2,$3,'discord_guild_link','alliance_discord_unlinked','website',
               'discord_user',$4,$5,$6,$7)`,
      [this.gameProfile, input.id, input.communityId, input.actorId, input.correlationId,
       input.beforeData, input.afterData],
    );
  }

  async upsertCycleScheduleOverride({ communityId, cycleIndex, opensAt, closesAt, actorId }) {
    return (await this.client.query(
      `INSERT INTO booking_cycle_schedule_overrides
         (game_profile,community_id,cycle_index,opens_at,closes_at,
          created_by_actor_id,updated_by_actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$6)
       ON CONFLICT (game_profile,community_id,cycle_index) DO UPDATE
         SET opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,
             updated_by_actor_id=EXCLUDED.updated_by_actor_id,updated_at=now()
       RETURNING cycle_index,opens_at,closes_at`,
      [this.gameProfile, communityId, cycleIndex, opensAt, closesAt, actorId],
    )).rows[0];
  }

  async removeCycleScheduleOverride(communityId, cycleIndex) {
    return (await this.client.query(
      `DELETE FROM booking_cycle_schedule_overrides
        WHERE game_profile=$1 AND community_id=$2 AND cycle_index=$3
        RETURNING cycle_index,opens_at,closes_at`,
      [this.gameProfile, communityId, cycleIndex],
    )).rows[0] ?? null;
  }

  async insertCycleScheduleAudit(input) {
    await this.client.query(
      `INSERT INTO booking_change_events
         (game_profile,id,community_id,aggregate_type,event_type,source,actor_type,
          actor_id,correlation_id,before_data,after_data)
       VALUES ($1,$2,$3,'booking_cycle_schedule',$4,'website','discord_user',$5,$6,$7,$8)`,
      [this.gameProfile, input.id, input.communityId, input.eventType, input.actorId,
       input.correlationId, input.beforeData, input.afterData],
    );
  }

  async upsertRecurringWindowDefault({ communityId, openMinuteUtc, closeOffsetMinutes, actorId }) {
    return (await this.client.query(
      `INSERT INTO booking_community_window_defaults
         (game_profile,community_id,open_minute_utc,close_offset_minutes,
          created_by_actor_id,updated_by_actor_id)
       VALUES ($1,$2,$3,$4,$5,$5)
       ON CONFLICT (game_profile,community_id) DO UPDATE
         SET open_minute_utc=EXCLUDED.open_minute_utc,
             close_offset_minutes=EXCLUDED.close_offset_minutes,
             updated_by_actor_id=EXCLUDED.updated_by_actor_id,updated_at=now()
       RETURNING open_minute_utc,close_offset_minutes`,
      [this.gameProfile, communityId, openMinuteUtc, closeOffsetMinutes, actorId],
    )).rows[0];
  }

  async insertRecurringWindowDefaultAudit(input) {
    await this.client.query(
      `INSERT INTO booking_change_events
         (game_profile,id,community_id,aggregate_type,event_type,source,actor_type,
          actor_id,correlation_id,before_data,after_data)
       VALUES ($1,$2,$3,'booking_community_window_default',$4,'website','discord_user',
               $5,$6,$7,$8)`,
      [this.gameProfile, input.id, input.communityId, input.eventType, input.actorId,
       input.correlationId, input.beforeData, input.afterData],
    );
  }

  async lockGuestLinks(communityId) {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `guest-link:${this.gameProfile}:${communityId}`,
    ]);
    return (await this.client.query(
      `SELECT id,created_at,expires_at,revoked_at
         FROM booking_guest_share_links
        WHERE game_profile=$1 AND community_id=$2 AND revoked_at IS NULL
        ORDER BY created_at DESC,id DESC
        LIMIT 1 FOR UPDATE`,
      [this.gameProfile, communityId],
    )).rows[0] ?? null;
  }

  async revokeGuestLink(linkId, actorId) {
    await this.client.query(
      `UPDATE booking_guest_share_links
          SET revoked_at=now(),revoked_by_actor_id=$3,updated_at=now()
        WHERE game_profile=$1 AND id=$2 AND revoked_at IS NULL`,
      [this.gameProfile, linkId, actorId],
    );
  }

  async supersedeManualGuestLinkNotification(linkId) {
    await this.client.query(
      `UPDATE booking_discord_notifications
          SET status='superseded',claim_token=NULL,claimed_at=NULL,claimed_until=NULL,updated_at=now()
        WHERE game_profile=$1 AND guest_share_link_id=$2
          AND notification_type='manager_guest_link'
          AND status IN ('pending','retry','claimed')`,
      [this.gameProfile, linkId],
    );
  }

  async insertGuestLink({ id, communityId, tokenHash, tokenHint, actorId, rotatedFromLinkId }) {
    await this.client.query(
      `INSERT INTO booking_guest_share_links
         (game_profile,id,community_id,token_hash,token_hint,label,
          created_by_actor_id,rotated_from_link_id)
       VALUES ($1,$2,$3,$4,$5,'In-game guest booking link',$6,$7)`,
      [this.gameProfile, id, communityId, tokenHash, tokenHint, actorId, rotatedFromLinkId],
    );
  }

  async insertManualGuestLinkNotification({ id, communityId, guestLinkId }) {
    await this.client.query(
      `INSERT INTO booking_discord_notifications
         (game_profile,id,community_id,notification_type,guest_share_link_id,idempotency_key)
       VALUES ($1,$2,$3,'manager_guest_link',$4,$5)
       ON CONFLICT (game_profile,community_id,idempotency_key) DO NOTHING`,
      [this.gameProfile, id, communityId, guestLinkId, `manual-guest-link:${guestLinkId}`],
    );
  }

  async setBookingEnabled(communityId, enabled) {
    await this.client.query(
      `UPDATE booking_communities
          SET bookings_open=$3,version=version+1,updated_at=now()
        WHERE game_profile=$1 AND id=$2`,
      [this.gameProfile, communityId, enabled],
    );
  }

  async setServiceEnabled(communityId, serviceCode, enabled, actorId) {
    await this.client.query(
      `INSERT INTO booking_community_services
         (game_profile,community_id,service_code,enabled,updated_by_actor_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (game_profile,community_id,service_code) DO UPDATE
         SET enabled=EXCLUDED.enabled,updated_by_actor_id=EXCLUDED.updated_by_actor_id,
             version=booking_community_services.version+1,updated_at=now()`,
      [this.gameProfile, communityId, serviceCode, enabled, actorId],
    );
  }

  async setRequirementEnabled(communityId, serviceCode, requirementCode, enabled) {
    const column = BOOKING_ADMIN_REQUIREMENT_COLUMNS[serviceCode]?.[requirementCode];
    if (!column) throw new TypeError("Unsupported booking requirement.");
    const result = await this.client.query(
      `UPDATE booking_settings
          SET ${column}=$3,version=version+1,updated_at=now()
        WHERE game_profile=$1 AND community_id=$2`,
      [this.gameProfile, communityId, enabled],
    );
    if (result.rowCount !== 1) throw new Error("Booking settings are unavailable.");
  }

  async insertAudit(input) {
    await this.client.query(
      `INSERT INTO booking_change_events
         (game_profile,id,community_id,aggregate_type,aggregate_id,event_type,
          source,actor_type,actor_id,correlation_id,before_data,after_data)
       VALUES ($1,$2,$3,'booking_configuration',$3,'booking_admin_updated',
               'website','discord_user',$4,$5,$6,$7)`,
      [this.gameProfile, input.id, input.communityId, input.actorId,
       input.correlationId, input.beforeData, input.afterData],
    );
  }

  async insertGuestLinkAudit(input) {
    await this.client.query(
      `INSERT INTO booking_change_events
         (game_profile,id,community_id,aggregate_type,aggregate_id,event_type,
          source,actor_type,actor_id,correlation_id,before_data,after_data)
       VALUES ($1,$2,$3,'guest_share_link',$4,$5,
               'website','discord_user',$6,$7,$8,$9)`,
      [this.gameProfile, input.id, input.communityId, input.aggregateId,
       `guest_link_${input.action}`, input.actorId, input.correlationId,
       input.beforeData, input.afterData],
    );
  }
}

export function createProfileScopedBookingAdminRepository(gameProfile, pool) {
  if (!PROFILES.has(gameProfile)) throw new TypeError("Unsupported booking-admin game profile.");
  async function withTransaction(work) {
    return withDevelopmentTiming(`database booking admin (${gameProfile})`, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.game_profile',$1,true)", [gameProfile]);
        const result = await work(new BookingAdminSession(client, gameProfile));
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
