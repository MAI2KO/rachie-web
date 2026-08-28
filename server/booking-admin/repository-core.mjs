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
    const [services, settings, windows, dates, guestLinks, guilds, scheduleOverrides] = await Promise.all([
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

  async insertGuestLink({ id, communityId, tokenHash, tokenHint, actorId, rotatedFromLinkId }) {
    await this.client.query(
      `INSERT INTO booking_guest_share_links
         (game_profile,id,community_id,token_hash,token_hint,label,
          created_by_actor_id,rotated_from_link_id)
       VALUES ($1,$2,$3,$4,$5,'In-game guest booking link',$6,$7)`,
      [this.gameProfile, id, communityId, tokenHash, tokenHint, actorId, rotatedFromLinkId],
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
