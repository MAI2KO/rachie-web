import { withDevelopmentTiming } from "../development-timing.mjs";

const PROFILES = new Set(["wos", "kingshot"]);

export function createProfileScopedAllianceEventsRepository(gameProfile, pool) {
  if (!PROFILES.has(gameProfile)) throw new TypeError("Unsupported alliance-events game profile.");

  async function findCommunityGuilds(communityCode) {
    return withDevelopmentTiming(`database alliance events (${gameProfile})`, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SELECT set_config('app.game_profile',$1,true)", [gameProfile]);
        const community = (await client.query(
          `SELECT id, location_code, display_name
             FROM booking_communities
            WHERE game_profile=$1 AND location_code=$2 AND status='active'`,
          [gameProfile, communityCode],
        )).rows[0] ?? null;
        if (!community) {
          await client.query("COMMIT");
          return null;
        }
        const guilds = await client.query(
          `SELECT discord_guild_id
            FROM booking_discord_guilds
            WHERE game_profile=$1 AND community_id=$2
              AND guild_kind IN ('unclassified','alliance') AND link_status='active'
            ORDER BY discord_guild_id`,
          [gameProfile, community.id],
        );
        await client.query("COMMIT");
        return Object.freeze({
          community,
          guildIds: Object.freeze(guilds.rows.map((row) => String(row.discord_guild_id))),
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

  return Object.freeze({ gameProfile, findCommunityGuilds });
}
