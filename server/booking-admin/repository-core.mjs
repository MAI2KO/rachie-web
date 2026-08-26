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
    const [services, settings, windows, dates] = await Promise.all([
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
    ]);
    return {
      community,
      services: services.rows,
      settings: settings.rows[0] ?? null,
      windows: windows.rows,
      dates: dates.rows,
    };
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
