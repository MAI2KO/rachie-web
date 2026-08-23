import { withDevelopmentTiming } from "../development-timing.mjs";

const PROFILES = new Set(["wos", "kingshot"]);

export function createProfileScopedWorldMapRepository(gameProfile, pool) {
  if (!PROFILES.has(gameProfile)) throw new TypeError("Unsupported world-map game profile.");

  async function listRegisteredCommunities() {
    return withDevelopmentTiming(`database world map (${gameProfile})`, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SELECT set_config('app.game_profile',$1,true)", [gameProfile]);
        const result = await client.query(
          `SELECT location_code,display_name
             FROM booking_communities
            WHERE game_profile=$1 AND status='active'`,
          [gameProfile],
        );
        await client.query("COMMIT");
        return result.rows;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

  return Object.freeze({ gameProfile, listRegisteredCommunities });
}
