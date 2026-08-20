import { createHash } from "node:crypto";

const PROFILES = Object.freeze(["wos", "kingshot"]);
const SERVICE_REQUIREMENTS = Object.freeze({
  construction: Object.freeze(["fc", "rfc", "speedups"]),
  research: Object.freeze(["shards", "speedups"]),
  troop: Object.freeze(["speedups"]),
});
const SERVICE_CODES = Object.freeze(Object.keys(SERVICE_REQUIREMENTS));
const SETTINGS_COLUMNS = Object.freeze({
  construction: Object.freeze({
    fc: "construction_fc_required",
    rfc: "construction_rfc_required",
    speedups: "construction_speedups_required",
  }),
  research: Object.freeze({
    shards: "research_shards_required",
    speedups: "research_speedups_required",
  }),
  troop: Object.freeze({ speedups: "troop_speedups_required" }),
});
const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const REQUIRED_WRITE_TABLES = Object.freeze([
  "booking_communities",
  "booking_discord_guilds",
  "booking_settings",
  "booking_windows",
  "booking_service_dates",
  "appointment_slots",
]);

export class BookingBootstrapError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = "BookingBootstrapError";
    this.code = code;
    this.details = Object.freeze([...details]);
  }
}

function fail(message) {
  throw new BookingBootstrapError("invalid_config", message);
}

function expectObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object.`);
  }
  return value;
}

function expectKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${path} contains unsupported field(s): ${unknown.join(", ")}.`);
}

function requiredString(value, path, maximum = 120) {
  if (typeof value !== "string" || value.trim() !== value || !value || value.length > maximum) {
    fail(`${path} must be a non-empty string of at most ${maximum} characters without surrounding whitespace.`);
  }
  if (/\p{Cc}/u.test(value)) fail(`${path} must not contain control characters.`);
  return value;
}

function requiredBoolean(value, path) {
  if (typeof value !== "boolean") fail(`${path} must be true or false.`);
  return value;
}

function validDate(value, path) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${path} must use YYYY-MM-DD.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    fail(`${path} is not a valid calendar date.`);
  }
  return value;
}

function validLocalTime(value, path) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    fail(`${path} must use 24-hour HH:MM format.`);
  }
  return value;
}

function validTimeZone(value) {
  const zone = requiredString(value, "timeZone", 80);
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
  } catch {
    fail("timeZone must be a valid IANA time zone.");
  }
  return zone;
}

function deterministicUuid(...parts) {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export function validateBookingBootstrapConfig(input) {
  const root = expectObject(input, "configuration");
  expectKeys(root, ["schemaVersion", "profile", "community", "booking", "timeZone", "services"], "configuration");
  if (root.schemaVersion !== 1) fail("schemaVersion must be 1.");
  if (!PROFILES.includes(root.profile)) fail("profile must be either wos or kingshot.");

  const community = expectObject(root.community, "community");
  expectKeys(community, ["code", "displayName", "discordGuild"], "community");
  const code = requiredString(community.code, "community.code", 32);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(code)) {
    fail("community.code must start with a letter or digit and contain only letters, digits, hyphens, or underscores.");
  }
  const displayName = requiredString(community.displayName, "community.displayName");
  const guild = expectObject(community.discordGuild, "community.discordGuild");
  expectKeys(guild, ["id", "displayName"], "community.discordGuild");
  const guildId = requiredString(guild.id, "community.discordGuild.id", 25);
  if (!/^\d{15,25}$/.test(guildId)) fail("community.discordGuild.id must be a valid Discord guild ID.");
  const guildName = requiredString(guild.displayName, "community.discordGuild.displayName");

  const booking = expectObject(root.booking, "booking");
  expectKeys(booking, ["enabled", "open"], "booking");
  const enabled = requiredBoolean(booking.enabled, "booking.enabled");
  const open = requiredBoolean(booking.open, "booking.open");
  if (!enabled && open) fail("booking.open cannot be true when booking.enabled is false.");
  const timeZone = validTimeZone(root.timeZone);

  if (!Array.isArray(root.services) || root.services.length !== SERVICE_CODES.length) {
    fail(`services must contain exactly one configuration for each of: ${SERVICE_CODES.join(", ")}.`);
  }
  const seenServices = new Set();
  const seenDates = new Set();
  const services = root.services.map((rawService, serviceIndex) => {
    const path = `services[${serviceIndex}]`;
    const service = expectObject(rawService, path);
    expectKeys(service, ["code", "bookingDate", "requirements", "slots"], path);
    const serviceCode = requiredString(service.code, `${path}.code`, 32);
    if (!SERVICE_CODES.includes(serviceCode)) fail(`${path}.code is not a supported service code.`);
    if (seenServices.has(serviceCode)) fail(`services contains duplicate service code ${serviceCode}.`);
    seenServices.add(serviceCode);
    const bookingDate = validDate(service.bookingDate, `${path}.bookingDate`);
    if (seenDates.has(bookingDate)) fail(`services contains duplicate service date ${bookingDate}.`);
    seenDates.add(bookingDate);

    if (!Array.isArray(service.requirements)) fail(`${path}.requirements must be an array.`);
    const supported = SERVICE_REQUIREMENTS[serviceCode];
    const seenRequirements = new Set();
    const requirements = service.requirements.map((rawCode, requirementIndex) => {
      const requirementCode = requiredString(rawCode, `${path}.requirements[${requirementIndex}]`, 32);
      if (!supported.includes(requirementCode)) {
        fail(`${path}.requirements contains unsupported requirement code ${requirementCode}.`);
      }
      if (seenRequirements.has(requirementCode)) fail(`${path}.requirements contains duplicate code ${requirementCode}.`);
      seenRequirements.add(requirementCode);
      return requirementCode;
    });

    if (!Array.isArray(service.slots) || service.slots.length === 0) fail(`${path}.slots must be a non-empty array.`);
    const seenLabels = new Set();
    const seenTimes = new Set();
    const slots = service.slots.map((rawSlot, slotIndex) => {
      const slotPath = `${path}.slots[${slotIndex}]`;
      const slot = expectObject(rawSlot, slotPath);
      expectKeys(slot, ["displayTimeLabel", "localStartTime"], slotPath);
      const displayTimeLabel = requiredString(slot.displayTimeLabel, `${slotPath}.displayTimeLabel`, 64);
      const localStartTime = validLocalTime(slot.localStartTime, `${slotPath}.localStartTime`);
      if (seenLabels.has(displayTimeLabel)) fail(`${path}.slots contains duplicate displayTimeLabel ${displayTimeLabel}.`);
      if (seenTimes.has(localStartTime)) fail(`${path}.slots contains duplicate localStartTime ${localStartTime}.`);
      seenLabels.add(displayTimeLabel);
      seenTimes.add(localStartTime);
      return Object.freeze({ displayTimeLabel, localStartTime, ordinal: slotIndex });
    });
    return Object.freeze({ code: serviceCode, bookingDate, requirements: Object.freeze(requirements), slots: Object.freeze(slots) });
  });

  for (const code of SERVICE_CODES) {
    if (!seenServices.has(code)) fail(`services is missing mandatory service ${code}.`);
  }

  const normalized = {
    schemaVersion: 1,
    profile: root.profile,
    community: { code, displayName, discordGuild: { id: guildId, displayName: guildName } },
    booking: { enabled, open },
    timeZone,
    services,
  };
  return Object.freeze(normalized);
}

export function assertBookingBootstrapSafety(databaseUrl, { confirmRemote = false, environment = process.env } = {}) {
  if (String(environment.BOOKING_BOOTSTRAP_ENABLED ?? "").trim() !== "true") {
    throw new BookingBootstrapError("bootstrap_disabled", "Bootstrap refused: set BOOKING_BOOTSTRAP_ENABLED=true for this operator command.");
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new BookingBootstrapError("database_configuration", "Bootstrap refused: DATABASE_URL is missing or invalid.");
  }
  if (!LOCAL_DATABASE_HOSTS.has(parsed.hostname) && !confirmRemote) {
    throw new BookingBootstrapError("remote_confirmation_required", "Remote bootstrap refused: pass --confirm-remote-bootstrap as well as BOOKING_BOOTSTRAP_ENABLED=true.");
  }
  return Object.freeze({ remote: !LOCAL_DATABASE_HOSTS.has(parsed.hostname) });
}

function emptyPlan(config) {
  return {
    profile: config.profile,
    communityCode: config.community.code,
    community: "existing",
    guildMapping: "existing",
    services: { existing: 0, changes: 0 },
    dates: { existing: 0, create: 0 },
    slots: { existing: 0, create: 0 },
    settings: "existing",
    conflicts: [],
    operations: [],
  };
}

function settingsFromConfig(config) {
  const settings = Object.fromEntries(Object.values(SETTINGS_COLUMNS).flatMap((mapping) => Object.values(mapping)).map((column) => [column, false]));
  for (const service of config.services) {
    for (const requirement of service.requirements) settings[SETTINGS_COLUMNS[service.code][requirement]] = true;
  }
  return settings;
}

async function setProfile(client, profile) {
  await client.query("SELECT set_config('app.game_profile', $1, true)", [profile]);
}

async function checkAdministrativeRole(client) {
  const result = await client.query(
    `SELECT table_name,
            has_table_privilege(current_user, table_name, 'INSERT') AS can_insert,
            has_table_privilege(current_user, table_name, 'UPDATE') AS can_update
     FROM unnest($1::text[]) AS table_name`,
    [REQUIRED_WRITE_TABLES],
  );
  const denied = result.rows.filter((row) => !row.can_insert || !row.can_update).map((row) => row.table_name);
  if (denied.length) {
    throw new BookingBootstrapError("insufficient_role", "Bootstrap refused: DATABASE_URL must use the migration/bootstrap administrative role.");
  }
}

async function findAcrossProfiles(client, sql, values) {
  const rows = [];
  for (const profile of PROFILES) {
    await setProfile(client, profile);
    const result = await client.query(sql, [profile, ...values]);
    rows.push(...result.rows);
  }
  return rows;
}

function comparableTime(value) {
  return value == null ? null : String(value).slice(0, 5);
}

export async function planBookingCommunityBootstrap(client, config) {
  const plan = emptyPlan(config);
  const communityId = deterministicUuid("booking-community", config.profile, config.community.code);
  const crossCode = await findAcrossProfiles(
    client,
    "SELECT game_profile, id FROM booking_communities WHERE game_profile=$1 AND location_code=$2",
    [config.community.code],
  );
  const wrongProfileCode = crossCode.find((row) => row.game_profile !== config.profile);
  if (wrongProfileCode) {
    plan.community = "conflict";
    plan.conflicts.push(`Community code ${config.community.code} already belongs to another profile.`);
  }

  await setProfile(client, config.profile);
  const selectedCommunity = crossCode.find((row) => row.game_profile === config.profile);
  let effectiveCommunityId = communityId;
  let communityRow = null;
  if (selectedCommunity) {
    effectiveCommunityId = selectedCommunity.id;
    communityRow = (await client.query(
      `SELECT id, display_name, status, bookings_open FROM booking_communities
       WHERE game_profile=$1 AND id=$2`,
      [config.profile, effectiveCommunityId],
    )).rows[0];
    const expectedStatus = config.booking.enabled ? "active" : "archived";
    if (communityRow.status !== expectedStatus) plan.conflicts.push(`booking.enabled differs from the existing community status (${communityRow.status}).`);
    if (communityRow.display_name !== config.community.displayName || communityRow.bookings_open !== config.booking.open) {
      plan.community = "update";
      plan.operations.push({ type: "updateCommunity", id: effectiveCommunityId });
    }
  } else {
    plan.community = "create";
    plan.operations.push({ type: "createCommunity", id: communityId });
  }

  const guildRows = await findAcrossProfiles(
    client,
    `SELECT game_profile, discord_guild_id, community_id, discord_guild_name
     FROM booking_discord_guilds WHERE game_profile=$1 AND discord_guild_id=$2`,
    [config.community.discordGuild.id],
  );
  const guildRow = guildRows.find((row) => row.game_profile === config.profile);
  if (guildRows.some((row) => row.game_profile !== config.profile)) {
    plan.guildMapping = "conflict";
    plan.conflicts.push("Discord guild ID is already mapped to another profile.");
  }
  if (!guildRow) {
    plan.guildMapping = "create";
    plan.operations.push({ type: "createGuild", communityId: effectiveCommunityId });
  } else if (guildRow.community_id !== effectiveCommunityId) {
    plan.guildMapping = "conflict";
    plan.conflicts.push("Discord guild ID is already mapped to a different community.");
  } else if (guildRow.discord_guild_name !== config.community.discordGuild.displayName) {
    plan.guildMapping = "update";
    plan.operations.push({ type: "updateGuild" });
  }

  await setProfile(client, config.profile);
  const servicesResult = await client.query(
    `SELECT service_code, active FROM minister_services
     WHERE game_profile=$1 AND service_code = ANY($2::text[])`,
    [config.profile, SERVICE_CODES],
  );
  plan.services.existing = servicesResult.rowCount;
  for (const code of SERVICE_CODES) {
    const row = servicesResult.rows.find((service) => service.service_code === code);
    if (!row) plan.conflicts.push(`Required service ${code} is missing; run reviewed migrations first.`);
    else if (!row.active) plan.conflicts.push(`Required service ${code} is inactive; bootstrap will not change global service definitions.`);
  }

  const expectedWindowId = deterministicUuid("booking-window", config.profile, effectiveCommunityId);
  const windows = selectedCommunity
    ? (await client.query(
      `SELECT id, status FROM booking_windows WHERE game_profile=$1 AND community_id=$2 ORDER BY id`,
      [config.profile, effectiveCommunityId],
    )).rows
    : [];
  let windowId = expectedWindowId;
  if (windows.length === 0) {
    plan.operations.push({ type: "createWindow", id: windowId, communityId: effectiveCommunityId });
  } else if (windows.length !== 1 || windows[0].id !== expectedWindowId) {
    plan.conflicts.push("Existing booking window identity differs from this bootstrap configuration.");
    windowId = windows[0]?.id ?? expectedWindowId;
  } else {
    const expectedWindowStatus = config.booking.open ? "open" : "closed";
    if (windows[0].status !== expectedWindowStatus) plan.operations.push({ type: "updateWindow", id: windowId });
  }

  const expectedSettings = settingsFromConfig(config);
  const settingsRow = selectedCommunity
    ? (await client.query("SELECT * FROM booking_settings WHERE game_profile=$1 AND community_id=$2", [config.profile, effectiveCommunityId])).rows[0]
    : null;
  if (!settingsRow) {
    plan.settings = "create";
    plan.operations.push({ type: "createSettings", communityId: effectiveCommunityId });
  } else if (Object.entries(expectedSettings).some(([column, value]) => settingsRow[column] !== value)) {
    plan.settings = "update";
    plan.operations.push({ type: "updateSettings", communityId: effectiveCommunityId });
  }

  const existingDates = selectedCommunity && windows.length === 1
    ? (await client.query(
      `SELECT id, service_code, booking_date::text AS booking_date
       FROM booking_service_dates WHERE game_profile=$1 AND community_id=$2 AND window_id=$3 ORDER BY service_code`,
      [config.profile, effectiveCommunityId, windowId],
    )).rows
    : [];
  const configuredCodes = new Set(config.services.map((service) => service.code));
  for (const row of existingDates) {
    if (!configuredCodes.has(row.service_code)) plan.conflicts.push(`Existing service date for ${row.service_code} is not present in the configuration.`);
  }

  for (const service of config.services) {
    const dateId = deterministicUuid("booking-service-date", config.profile, effectiveCommunityId, service.code);
    const dateRow = existingDates.find((row) => row.service_code === service.code);
    if (!dateRow) {
      plan.dates.create += 1;
      plan.slots.create += service.slots.length;
      plan.operations.push({ type: "createDate", id: dateId, communityId: effectiveCommunityId, windowId, service });
      continue;
    }
    plan.dates.existing += 1;
    if (dateRow.id !== dateId || dateRow.booking_date !== service.bookingDate) {
      plan.conflicts.push(`Structural drift found for ${service.code} service date.`);
      continue;
    }
    const slots = (await client.query(
      `SELECT id, ordinal, display_time_label, local_start_time::text AS local_start_time,
              time_zone, status
       FROM appointment_slots WHERE game_profile=$1 AND service_date_id=$2 ORDER BY ordinal, id`,
      [config.profile, dateId],
    )).rows;
    plan.slots.existing += slots.length;
    if (slots.length !== service.slots.length) {
      plan.conflicts.push(`Structural drift found for ${service.code} slots (expected ${service.slots.length}, found ${slots.length}).`);
      continue;
    }
    for (const expected of service.slots) {
      const actual = slots[expected.ordinal];
      const expectedId = deterministicUuid("appointment-slot", config.profile, effectiveCommunityId, service.code, String(expected.ordinal));
      if (!actual || actual.id !== expectedId || actual.ordinal !== expected.ordinal
          || actual.display_time_label !== expected.displayTimeLabel
          || comparableTime(actual.local_start_time) !== expected.localStartTime
          || actual.time_zone !== config.timeZone || actual.status !== "available") {
        plan.conflicts.push(`Structural drift found for ${service.code} slot ${expected.ordinal}.`);
      }
    }
  }

  if (plan.conflicts.some((conflict) => conflict.includes("Structural drift") || conflict.includes("window identity"))) {
    const bookingCount = Number((await client.query(
      "SELECT count(*)::int AS count FROM minister_bookings WHERE game_profile=$1 AND community_id=$2",
      [config.profile, effectiveCommunityId],
    )).rows[0]?.count ?? 0);
    if (bookingCount > 0) plan.conflicts.push(`Unsafe structural reconciliation refused: the community has ${bookingCount} existing booking record(s).`);
  }

  return Object.freeze({ ...plan, conflicts: Object.freeze(plan.conflicts), operations: Object.freeze(plan.operations) });
}

async function applyPlan(client, config, plan, injectFailureAfter) {
  let applied = 0;
  const settings = settingsFromConfig(config);
  const afterOperation = () => {
    applied += 1;
    if (injectFailureAfter === applied) throw new BookingBootstrapError("injected_failure", "Injected bootstrap failure.");
  };
  for (const operation of plan.operations) {
    if (operation.type === "createCommunity") {
      await client.query(
        `INSERT INTO booking_communities (game_profile,id,location_code,display_name,status,bookings_open)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [config.profile, operation.id, config.community.code, config.community.displayName, config.booking.enabled ? "active" : "archived", config.booking.open],
      );
    } else if (operation.type === "updateCommunity") {
      await client.query(
        `UPDATE booking_communities SET display_name=$3, bookings_open=$4, version=version+1, updated_at=now()
         WHERE game_profile=$1 AND id=$2`,
        [config.profile, operation.id, config.community.displayName, config.booking.open],
      );
    } else if (operation.type === "createGuild") {
      await client.query(
        `INSERT INTO booking_discord_guilds
           (game_profile,discord_guild_id,community_id,discord_guild_name,linked_by_actor_id)
         VALUES ($1,$2,$3,$4,'booking-bootstrap')`,
        [config.profile, config.community.discordGuild.id, operation.communityId, config.community.discordGuild.displayName],
      );
    } else if (operation.type === "updateGuild") {
      await client.query(
        `UPDATE booking_discord_guilds SET discord_guild_name=$3, linked_by_actor_id='booking-bootstrap', updated_at=now()
         WHERE game_profile=$1 AND discord_guild_id=$2`,
        [config.profile, config.community.discordGuild.id, config.community.discordGuild.displayName],
      );
    } else if (operation.type === "createWindow") {
      await client.query(
        `INSERT INTO booking_windows
           (game_profile,id,community_id,status,opened_at,closed_at,created_by_actor_type,created_by_actor_id)
         VALUES ($1,$2,$3,$4,CASE WHEN $4='open' THEN now() END,CASE WHEN $4='closed' THEN now() END,'admin','booking-bootstrap')`,
        [config.profile, operation.id, operation.communityId, config.booking.open ? "open" : "closed"],
      );
    } else if (operation.type === "updateWindow") {
      await client.query(
        `UPDATE booking_windows SET status=$3,
             opened_at=CASE WHEN $3='open' THEN COALESCE(opened_at,now()) ELSE opened_at END,
             closed_at=CASE WHEN $3='closed' THEN now() ELSE NULL END,
             version=version+1,updated_at=now()
         WHERE game_profile=$1 AND id=$2`,
        [config.profile, operation.id, config.booking.open ? "open" : "closed"],
      );
    } else if (operation.type === "createSettings" || operation.type === "updateSettings") {
      await client.query(
        `INSERT INTO booking_settings
           (game_profile,community_id,construction_fc_required,construction_rfc_required,
            construction_speedups_required,research_shards_required,research_speedups_required,troop_speedups_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (game_profile,community_id) DO UPDATE SET
           construction_fc_required=EXCLUDED.construction_fc_required,
           construction_rfc_required=EXCLUDED.construction_rfc_required,
           construction_speedups_required=EXCLUDED.construction_speedups_required,
           research_shards_required=EXCLUDED.research_shards_required,
           research_speedups_required=EXCLUDED.research_speedups_required,
           troop_speedups_required=EXCLUDED.troop_speedups_required,
           version=booking_settings.version+1,updated_at=now()`,
        [config.profile, operation.communityId, settings.construction_fc_required, settings.construction_rfc_required,
          settings.construction_speedups_required, settings.research_shards_required,
          settings.research_speedups_required, settings.troop_speedups_required],
      );
    } else if (operation.type === "createDate") {
      await client.query(
        `INSERT INTO booking_service_dates
           (game_profile,id,community_id,window_id,service_code,booking_date)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [config.profile, operation.id, operation.communityId, operation.windowId, operation.service.code, operation.service.bookingDate],
      );
      for (const slot of operation.service.slots) {
        const slotId = deterministicUuid("appointment-slot", config.profile, operation.communityId, operation.service.code, String(slot.ordinal));
        await client.query(
          `INSERT INTO appointment_slots
             (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,
              ordinal,display_time_label,local_start_time,time_zone,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'available')`,
          [config.profile, slotId, operation.communityId, operation.windowId, operation.id, operation.service.code,
            operation.service.bookingDate, slot.ordinal, slot.displayTimeLabel, slot.localStartTime, config.timeZone],
        );
      }
    }
    afterOperation();
  }
}

export async function runBookingCommunityBootstrap({ pool, config, dryRun = false, injectFailureAfter } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await checkAdministrativeRole(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`booking-bootstrap:${config.profile}:${config.community.code}`]);
    const plan = await planBookingCommunityBootstrap(client, config);
    if (plan.conflicts.length && !dryRun) {
      throw new BookingBootstrapError("configuration_conflict", "Bootstrap refused because existing configuration conflicts with the reviewed file.", plan.conflicts);
    }
    if (!dryRun) await applyPlan(client, config, plan, injectFailureAfter);
    if (dryRun) await client.query("ROLLBACK");
    else await client.query("COMMIT");
    return plan;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export function formatBookingBootstrapSummary(plan, { dryRun = false } = {}) {
  const lines = [
    `Profile: ${plan.profile}`,
    `Community: ${plan.communityCode} (${plan.community})`,
    `Guild mapping: ${plan.guildMapping}`,
    `Services: ${plan.services.existing} existing / ${plan.services.changes} changes`,
    `Dates: ${plan.dates.existing} existing / ${plan.dates.create} create`,
    `Slots: ${plan.slots.existing} existing / ${plan.slots.create} create`,
    `Settings: ${plan.settings}`,
  ];
  if (plan.conflicts.length) {
    lines.push(`Conflicts: ${plan.conflicts.length}`);
    for (const conflict of plan.conflicts) lines.push(`- ${conflict}`);
  }
  lines.push(`Result: ${plan.conflicts.length ? "conflicts found" : dryRun ? "dry-run only" : "bootstrap complete"}`);
  return `${lines.join("\n")}\n`;
}
