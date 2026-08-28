import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateBookingBootstrapConfig } from "./booking-community-bootstrap.mjs";

export const DEFAULT_OUTPUT_DIRECTORY = "/home/mark/rachie-staging-config";

export const PROFILE_DETAILS = Object.freeze({
  wos: Object.freeze({
    label: "R.A.C.H.I.E / Whiteout Survival",
    communityTerm: "State",
    filename: "staging-wos-booking-community.json",
    requirements: Object.freeze({
      construction: Object.freeze([
        Object.freeze({ code: "fc", label: "Fire Crystals" }),
        Object.freeze({ code: "rfc", label: "Refined Fire Crystals" }),
        Object.freeze({ code: "speedups", label: "Speed-ups (days)" }),
      ]),
      research: Object.freeze([
        Object.freeze({ code: "shards", label: "Fire Crystal Shards" }),
        Object.freeze({ code: "speedups", label: "Speed-ups (days)" }),
      ]),
      troop: Object.freeze([
        Object.freeze({ code: "speedups", label: "Speed-ups (days)" }),
      ]),
    }),
  }),
  kingshot: Object.freeze({
    label: "P.E.G.G.I.E / Kingshot",
    communityTerm: "Kingdom",
    filename: "staging-kingshot-booking-community.json",
    requirements: Object.freeze({
      construction: Object.freeze([
        Object.freeze({ code: "fc", label: "Truegold" }),
        Object.freeze({ code: "rfc", label: "Tempered Truegold" }),
        Object.freeze({ code: "speedups", label: "Speed-ups (days)" }),
      ]),
      research: Object.freeze([
        Object.freeze({ code: "shards", label: "Truegold Dust" }),
        Object.freeze({ code: "speedups", label: "Speed-ups (days)" }),
      ]),
      troop: Object.freeze([
        Object.freeze({ code: "speedups", label: "Speed-ups (days)" }),
      ]),
    }),
  }),
});

const SERVICE_LABELS = Object.freeze({
  construction: "Construction",
  research: "Research",
  troop: "Troop",
});

function invalid(message) {
  throw new Error(message);
}

export function validateCommunityCode(value) {
  const code = String(value).trim();
  if (!code || code.length > 32 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(code)) {
    invalid("Use 1-32 letters, digits, hyphens, or underscores, starting with a letter or digit (for example: 1234).");
  }
  return code;
}

export function validateHumanName(value, label = "Name") {
  const name = String(value).trim();
  if (!name || name.length > 120 || /\p{Cc}/u.test(name)) invalid(`${label} must be 1-120 characters.`);
  return name;
}

export function validateDiscordGuildId(value) {
  const id = String(value).trim();
  if (!/^[1-9]\d{14,19}$/.test(id) || BigInt(id) > 18_446_744_073_709_551_615n) {
    invalid("Enter a valid Discord snowflake as 15-20 digits (for example: 123456789012345678).");
  }
  return id;
}

export function validateDate(value) {
  const dateText = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) invalid("Use YYYY-MM-DD (for example: 2026-09-01).");
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== dateText) {
    invalid("Enter a real calendar date using YYYY-MM-DD (for example: 2026-09-01).");
  }
  return dateText;
}

export function validateTimeZone(value) {
  const timeZone = String(value).trim();
  if (!timeZone || timeZone.length > 80) invalid("Enter an IANA timezone (for example: Europe/London).");
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    invalid("Enter a valid IANA timezone (for example: Europe/London).");
  }
  return timeZone;
}

export function validateTime(value) {
  const time = String(value).trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) invalid("Use 24-hour HH:MM (for example: 09:30).");
  return time;
}

export function validatePositiveInteger(value, label, maximum) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) invalid(`${label} must be a whole number between 1 and ${maximum}.`);
  const number = Number(text);
  if (number < 1 || number > maximum) invalid(`${label} must be a whole number between 1 and ${maximum}.`);
  return number;
}

export function generateAppointmentSchedule({ firstSlotTime, intervalMinutes, numberOfSlots }) {
  const first = validateTime(firstSlotTime);
  const interval = validatePositiveInteger(intervalMinutes, "Slot interval in minutes", 1439);
  const count = validatePositiveInteger(numberOfSlots, "Number of slots", 1440);
  const [hours, minutes] = first.split(":").map(Number);
  const firstMinute = (hours * 60) + minutes;
  const lastMinute = firstMinute + ((count - 1) * interval);
  if (lastMinute >= 1440) invalid("The schedule runs past 23:59. Use fewer slots, an earlier first time, or a shorter interval.");
  return Array.from({ length: count }, (_, index) => {
    const minute = firstMinute + (index * interval);
    const localStartTime = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    return { displayTimeLabel: localStartTime, localStartTime };
  });
}

export function requirementChoices(profile) {
  const details = PROFILE_DETAILS[profile];
  if (!details) invalid("Profile must be wos or kingshot.");
  return details.requirements;
}

export function buildBookingCommunityConfig({
  profile,
  communityCode,
  displayName,
  stateGuild = null,
  timeZone,
  bookingOpen = false,
  serviceDates,
  requirements,
  slots,
}) {
  if (!PROFILE_DETAILS[profile]) invalid("Profile must be wos or kingshot.");
  const uniqueDates = new Set(Object.values(serviceDates));
  if (uniqueDates.size !== 3) invalid("Construction, Research, and Troop must use different dates.");
  const input = {
    schemaVersion: 2,
    profile,
    community: {
      code: validateCommunityCode(communityCode),
      displayName: validateHumanName(displayName, "Public display name"),
      stateGuild: stateGuild === null ? null : {
        id: validateDiscordGuildId(stateGuild.id),
        displayName: validateHumanName(stateGuild.displayName, "State/Kingdom Discord display name"),
      },
    },
    booking: { enabled: true, open: Boolean(bookingOpen) },
    timeZone: validateTimeZone(timeZone),
    services: Object.keys(SERVICE_LABELS).map((code) => ({
      code,
      bookingDate: validateDate(serviceDates[code]),
      requirements: [...(requirements[code] ?? [])],
      slots: slots.map((slot) => ({ ...slot })),
    })),
  };
  validateBookingBootstrapConfig(input);
  return input;
}

export function formatBookingConfigSummary(config) {
  const details = PROFILE_DETAILS[config.profile];
  const lines = [
    "Configuration summary",
    `Profile: ${details.label} (${config.profile})`,
    `${details.communityTerm}: ${config.community.code} — ${config.community.displayName}`,
    `Shared ${details.communityTerm} Discord: ${config.community.stateGuild
      ? `${config.community.stateGuild.displayName} (${config.community.stateGuild.id})`
      : "None configured"}`,
    `Timezone: ${config.timeZone}`,
    `Booking: ${config.booking.open ? "OPEN" : "CLOSED"}`,
    "Service dates and requirements:",
  ];
  for (const service of config.services) {
    const namesByCode = new Map(details.requirements[service.code].map(({ code, label }) => [code, label]));
    const labels = service.requirements.map((code) => namesByCode.get(code)).join(", ") || "None";
    lines.push(`  ${SERVICE_LABELS[service.code]}: ${service.bookingDate}; required: ${labels}`);
  }
  const slots = config.services[0].slots;
  lines.push(`Appointment slots: ${slots.length}`);
  lines.push(`First/last slot: ${slots[0].localStartTime} / ${slots.at(-1).localStartTime}`);
  return `${lines.join("\n")}\n`;
}

export function defaultOutputPath(profile, outputDirectory = DEFAULT_OUTPUT_DIRECTORY) {
  const details = PROFILE_DETAILS[profile];
  if (!details) invalid("Profile must be wos or kingshot.");
  return path.join(outputDirectory, details.filename);
}

export async function writeBookingConfigFile(outputPath, config, { confirmOverwrite = async () => false } = {}) {
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  try {
    const handle = await open(outputPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!await confirmOverwrite(outputPath)) return { written: false, reason: "overwrite_refused" };
    await writeFile(outputPath, contents, { encoding: "utf8", mode: 0o600 });
  }
  const written = JSON.parse(await readFile(outputPath, "utf8"));
  validateBookingBootstrapConfig(written);
  return { written: true, path: outputPath };
}

async function askValidated(prompter, question, validator) {
  for (;;) {
    const answer = await prompter.input(question);
    try {
      return validator(answer);
    } catch (error) {
      prompter.message(`Please try again: ${error.message}`);
    }
  }
}

export function bookingConfigWizardQuestions(profile) {
  const details = PROFILE_DETAILS[profile];
  if (!details) invalid("Profile must be wos or kingshot.");
  return Object.freeze({
    communityCode: `${details.communityTerm} code - the in-game ${details.communityTerm} number, e.g. 9999: `,
    publicDisplayName: "Public display name - the name shown on the website, e.g. Test Server: ",
    discordDisplayName: `Shared ${details.communityTerm} Discord display name: `,
  });
}

export async function runBookingConfigWizard({ prompter, outputDirectory = DEFAULT_OUTPUT_DIRECTORY }) {
  prompter.message("Booking community configuration wizard");
  prompter.message("This creates JSON only. It does not connect to PostgreSQL, Railway, or Discord.");
  prompter.message("SECURITY: Never put bot tokens, OAuth secrets, database passwords, or session secrets in these files.\n");

  const profile = await prompter.select("Which profile?", Object.entries(PROFILE_DETAILS).map(([value, details]) => ({ value, label: details.label })));
  const details = PROFILE_DETAILS[profile];
  const questions = bookingConfigWizardQuestions(profile);
  const communityCode = await askValidated(prompter, questions.communityCode, validateCommunityCode);
  const displayName = await askValidated(prompter, questions.publicDisplayName, (value) => validateHumanName(value, "Public display name"));
  const hasStateGuild = await prompter.confirm(
    `Does this community currently have a reviewed shared ${details.communityTerm} Discord?`, false,
  );
  const stateGuild = hasStateGuild ? {
    id: await askValidated(prompter, `Shared ${details.communityTerm} Discord server ID: `, validateDiscordGuildId),
    displayName: await askValidated(prompter, questions.discordDisplayName,
      (value) => validateHumanName(value, `Shared ${details.communityTerm} Discord display name`)),
  } : null;
  const timeZone = await askValidated(prompter, "IANA timezone (for example Europe/London): ", validateTimeZone);
  const keepClosed = await prompter.confirm("Keep bookings closed initially?", true);

  let serviceDates;
  for (;;) {
    serviceDates = {};
    for (const [code, label] of Object.entries(SERVICE_LABELS)) {
      serviceDates[code] = await askValidated(prompter, `${label} date (YYYY-MM-DD): `, validateDate);
    }
    if (new Set(Object.values(serviceDates)).size === 3) break;
    prompter.message("Each service needs a different date. Please enter the three dates again.");
  }

  const requirements = {};
  for (const [serviceCode, choices] of Object.entries(details.requirements)) {
    requirements[serviceCode] = [];
    prompter.message(`${SERVICE_LABELS[serviceCode]} requirements:`);
    for (const requirement of choices) {
      if (await prompter.confirm(`Require ${requirement.label}?`, false)) requirements[serviceCode].push(requirement.code);
    }
  }

  prompter.message("The recovered source proves there were 48 template rows, but it does not contain their exact times or interval.");
  prompter.message("Build the appointment schedule (the same schedule is used for all three services):");
  let slots;
  for (;;) {
    const firstSlotTime = await askValidated(prompter, "First slot time (HH:MM): ", validateTime);
    const intervalMinutes = await askValidated(prompter, "Slot interval in minutes: ", (value) => validatePositiveInteger(value, "Slot interval in minutes", 1439));
    const numberOfSlots = await askValidated(prompter, "Number of slots: ", (value) => validatePositiveInteger(value, "Number of slots", 1440));
    try {
      slots = generateAppointmentSchedule({ firstSlotTime, intervalMinutes, numberOfSlots });
      prompter.message(`Schedule preview: ${slots.map((slot) => slot.localStartTime).join(", ")}`);
      if (await prompter.confirm("Use this schedule?", false)) break;
    } catch (error) {
      prompter.message(`Please try again: ${error.message}`);
    }
  }

  const config = buildBookingCommunityConfig({
    profile,
    communityCode,
    displayName,
    stateGuild,
    timeZone,
    bookingOpen: !keepClosed,
    serviceDates,
    requirements,
    slots,
  });
  const outputPath = defaultOutputPath(profile, outputDirectory);
  prompter.message(`\n${formatBookingConfigSummary(config)}Output file: ${outputPath}`);
  if (!await prompter.confirm("Write this configuration?", false)) return { written: false, reason: "write_refused", config, outputPath };

  const result = await writeBookingConfigFile(outputPath, config, {
    confirmOverwrite: (existingPath) => prompter.confirm(`File already exists: ${existingPath}\nOverwrite it?`, false),
  });
  if (!result.written) prompter.message("Existing file was not changed.");
  else prompter.message(`Configuration written and validated locally: ${result.path}`);
  return { ...result, config, outputPath };
}
