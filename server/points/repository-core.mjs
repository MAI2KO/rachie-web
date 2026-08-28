import { withDevelopmentTiming } from "../development-timing.mjs";

const PROFILES = new Set(["wos", "kingshot"]);

class PointsSession {
  constructor(client, gameProfile) {
    this.client = client;
    this.gameProfile = gameProfile;
  }

  async getPlayerBalance(participantId) {
    const result = await this.client.query(
      `SELECT COALESCE(sum(points_delta),0)::bigint AS balance
         FROM player_points_ledger
        WHERE game_profile=$1 AND participant_id=$2`,
      [this.gameProfile, participantId],
    );
    return Number(result.rows[0].balance);
  }

  async getCommunityBalance(communityId) {
    const result = await this.client.query(
      `SELECT COALESCE(sum(points_delta),0)::bigint AS balance
         FROM community_points_ledger
        WHERE game_profile=$1 AND community_id=$2`,
      [this.gameProfile, communityId],
    );
    return Number(result.rows[0].balance);
  }

  async listPlayerEntries(participantId, { limit = 50, before = null } = {}) {
    const bounded = Math.max(1, Math.min(100, Number(limit) || 50));
    return (await this.client.query(
      `SELECT id,points_delta,reason,booking_window_id,booking_id,source_guild_id,created_at,metadata
         FROM player_points_ledger
        WHERE game_profile=$1 AND participant_id=$2
          AND ($3::timestamptz IS NULL OR created_at<$3)
        ORDER BY created_at DESC,id DESC LIMIT $4`,
      [this.gameProfile, participantId, before, bounded],
    )).rows;
  }

  async listCommunityEntries(communityId, { limit = 50, before = null } = {}) {
    const bounded = Math.max(1, Math.min(100, Number(limit) || 50));
    return (await this.client.query(
      `SELECT id,source_guild_id,booking_window_id,points_delta,reason,created_at,metadata
         FROM community_points_ledger
        WHERE game_profile=$1 AND community_id=$2
          AND ($3::timestamptz IS NULL OR created_at<$3)
        ORDER BY created_at DESC,id DESC LIMIT $4`,
      [this.gameProfile, communityId, before, bounded],
    )).rows;
  }

  async appendPlayerEntry(input) {
    if (!Number.isSafeInteger(input.pointsDelta) || input.pointsDelta === 0) {
      throw new TypeError("Points delta must be a non-zero safe integer.");
    }
    return (await this.client.query(
      `INSERT INTO player_points_ledger
         (game_profile,id,participant_id,community_id,discord_user_id,points_delta,reason,
          booking_window_id,booking_id,source_guild_id,idempotency_key,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (game_profile,idempotency_key) DO NOTHING
       RETURNING id`,
      [this.gameProfile, input.id, input.participantId, input.communityId,
       input.discordUserId ?? null, input.pointsDelta, input.reason,
       input.bookingWindowId ?? null, input.bookingId ?? null, input.sourceGuildId ?? null,
       input.idempotencyKey, input.metadata ?? {}],
    )).rowCount === 1;
  }

  async appendCommunityEntry(input) {
    if (!Number.isSafeInteger(input.pointsDelta) || input.pointsDelta === 0) {
      throw new TypeError("Points delta must be a non-zero safe integer.");
    }
    return (await this.client.query(
      `INSERT INTO community_points_ledger
         (game_profile,id,community_id,source_guild_id,booking_window_id,
          points_delta,reason,idempotency_key,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (game_profile,idempotency_key) DO NOTHING
       RETURNING id`,
      [this.gameProfile, input.id, input.communityId, input.sourceGuildId,
       input.bookingWindowId, input.pointsDelta, input.reason,input.idempotencyKey,
       input.metadata ?? {}],
    )).rowCount === 1;
  }
}

export function createProfileScopedPointsRepository(gameProfile, pool) {
  if (!PROFILES.has(gameProfile)) throw new TypeError("Unsupported points game profile.");
  async function withTransaction(work) {
    return withDevelopmentTiming(`database points (${gameProfile})`, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.game_profile',$1,true)", [gameProfile]);
        const result = await work(new PointsSession(client, gameProfile));
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
  return Object.freeze({ gameProfile, withTransaction,
    getPlayerBalance: (participantId) => withTransaction((session) => session.getPlayerBalance(participantId)),
    getCommunityBalance: (communityId) => withTransaction((session) => session.getCommunityBalance(communityId)),
    listPlayerEntries: (participantId, options) => withTransaction(
      (session) => session.listPlayerEntries(participantId, options)),
    listCommunityEntries: (communityId, options) => withTransaction(
      (session) => session.listCommunityEntries(communityId, options)),
    appendPlayerEntry: (input) => withTransaction((session) => session.appendPlayerEntry(input)),
    appendCommunityEntry: (input) => withTransaction((session) => session.appendCommunityEntry(input)),
  });
}
