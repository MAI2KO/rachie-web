import pg from "pg";

import { resolveDatabaseUrl } from "../server/database/database-url.mjs";

const profiles = [
  {
    profile: "wos",
    communityId: "10000000-0000-4000-8000-000000001001",
    windowId: "10000000-0000-4000-8000-000000001101",
    locationCode: "DEV-WOS-1001",
    displayName: "Development State 1001",
    guildEnvironment: "WOS_DEV_DISCORD_GUILD_ID",
    guildName: "WOS Development Guild",
  },
  {
    profile: "kingshot",
    communityId: "20000000-0000-4000-8000-000000002002",
    windowId: "20000000-0000-4000-8000-000000002202",
    locationCode: "DEV-KS-2002",
    displayName: "Development Kingdom 2002",
    guildEnvironment: "KINGSHOT_DEV_DISCORD_GUILD_ID",
    guildName: "Kingshot Development Guild",
  },
];

const services = [
  { code: "construction", dateOffset: 1, dateSuffix: "01", times: ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"] },
  { code: "research", dateOffset: 2, dateSuffix: "02", times: ["12:00", "12:30", "13:00", "13:30", "14:00", "14:30"] },
  { code: "troop", dateOffset: 3, dateSuffix: "03", times: ["15:00", "15:30", "16:00", "16:30", "17:00", "17:30"] },
];

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value || value.startsWith("replace-with-")) throw new Error(`${name} must be set in .env.local.`);
  return value;
}

function guildId(name) {
  const value = required(name);
  if (!/^\d{15,25}$/.test(value)) throw new Error(`${name} must be a Discord guild ID.`);
  return value;
}

function dateOnly(offset) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const databaseUrl = resolveDatabaseUrl();
if (!databaseUrl) throw new Error("DATABASE_URL must be set in .env.local.");

const parsedDatabaseUrl = new URL(databaseUrl);
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (
  process.env.ALLOW_DEVELOPMENT_DATABASE_SEED !== "true"
  || process.env.NODE_ENV === "production"
  || !localHosts.has(parsedDatabaseUrl.hostname)
  || parsedDatabaseUrl.pathname !== "/rachie_peggie_dev"
) {
  throw new Error(
    "Development seed refused: use the local rachie_peggie_dev database and set ALLOW_DEVELOPMENT_DATABASE_SEED=true.",
  );
}

const client = new pg.Client({ application_name: "rachie-peggie-web-development-seed", connectionString: databaseUrl });
await client.connect();
try {
  for (const config of profiles) {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.game_profile', $1, true)", [config.profile]);
      await client.query(
        `INSERT INTO booking_communities
           (game_profile,id,location_code,display_name,status,bookings_open)
         VALUES ($1,$2,$3,$4,'active',true)
         ON CONFLICT (game_profile,id) DO UPDATE
         SET location_code=EXCLUDED.location_code, display_name=EXCLUDED.display_name,
             status='active', bookings_open=true, updated_at=now()`,
        [config.profile, config.communityId, config.locationCode, config.displayName],
      );
      await client.query(
        `INSERT INTO booking_discord_guilds
           (game_profile,discord_guild_id,community_id,discord_guild_name,linked_by_actor_id)
         VALUES ($1,$2,$3,$4,'development-seed')
         ON CONFLICT (game_profile,discord_guild_id) DO UPDATE
         SET community_id=EXCLUDED.community_id, discord_guild_name=EXCLUDED.discord_guild_name,
             linked_by_actor_id='development-seed', updated_at=now()`,
        [config.profile, guildId(config.guildEnvironment), config.communityId, config.guildName],
      );
      await client.query(
        `INSERT INTO booking_settings
           (game_profile,community_id,construction_fc_required,
            construction_rfc_required,construction_speedups_required,
            research_shards_required,research_speedups_required,
            troop_speedups_required)
         VALUES ($1,$2,true,true,false,true,true,true)
         ON CONFLICT (game_profile,community_id) DO UPDATE
         SET construction_fc_required=true, construction_rfc_required=true,
             construction_speedups_required=false, research_shards_required=true,
             research_speedups_required=true, troop_speedups_required=true,
             updated_at=now()`,
        [config.profile, config.communityId],
      );
      await client.query(
        `INSERT INTO booking_windows
           (game_profile,id,community_id,status,opens_at,closes_at,opened_at,
            created_by_actor_type,created_by_actor_id)
         VALUES ($1,$2,$3,'open',now()-interval '1 day',now()+interval '30 days',
                 now(),'system','development-seed')
         ON CONFLICT (game_profile,id) DO UPDATE
         SET status='open', opens_at=now()-interval '1 day',
             closes_at=now()+interval '30 days', closed_at=NULL, updated_at=now()`,
        [config.profile, config.windowId, config.communityId],
      );

      for (const [serviceIndex, service] of services.entries()) {
        const serviceDateId = `${config.profile === "wos" ? "1" : "2"}0000000-0000-4000-8000-00000000${service.dateSuffix}01`;
        const bookingDate = dateOnly(service.dateOffset);
        await client.query(
          `UPDATE minister_services SET active=true, updated_at=now()
           WHERE game_profile=$1 AND service_code=$2`,
          [config.profile, service.code],
        );
        await client.query(
          `INSERT INTO booking_service_dates
             (game_profile,id,community_id,window_id,service_code,booking_date)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (game_profile,id) DO NOTHING`,
          [config.profile, serviceDateId, config.communityId, config.windowId, service.code, bookingDate],
        );
        for (const [ordinal, displayTime] of service.times.entries()) {
          const slotId = `${config.profile === "wos" ? "1" : "2"}${serviceIndex + 1}000000-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
          await client.query(
            `INSERT INTO appointment_slots
               (game_profile,id,community_id,window_id,service_date_id,
                service_code,booking_date,ordinal,display_time_label,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'available')
             ON CONFLICT (game_profile,id) DO NOTHING`,
            [config.profile, slotId, config.communityId, config.windowId,
             serviceDateId, service.code, bookingDate, ordinal, displayTime],
          );
        }
      }
      await client.query("COMMIT");
      process.stdout.write(`Seeded ${config.displayName}.\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  process.stdout.write("Development booking seed is current.\n");
} finally {
  await client.end();
}
