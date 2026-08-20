import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildBookingCommunityConfig,
  generateAppointmentSchedule,
  requirementChoices,
  validateDate,
  validateDiscordGuildId,
  validateTime,
  validateTimeZone,
  writeBookingConfigFile,
} from "../server/bootstrap/booking-community-config.mjs";
import { validateBookingBootstrapConfig } from "../server/bootstrap/booking-community-bootstrap.mjs";

const slots = generateAppointmentSchedule({ firstSlotTime: "08:00", intervalMinutes: 30, numberOfSlots: 4 });

function input(profile, overrides = {}) {
  return {
    profile,
    communityCode: profile === "wos" ? "1234" : "K-5678",
    displayName: profile === "wos" ? "State 1234" : "Kingdom 5678",
    discordGuildId: profile === "wos" ? "123456789012345678" : "223456789012345678",
    discordGuildDisplayName: profile === "wos" ? "Rachie staging" : "Peggie staging",
    timeZone: "Europe/London",
    serviceDates: { construction: "2026-09-01", research: "2026-09-02", troop: "2026-09-03" },
    requirements: { construction: ["fc", "rfc", "speedups"], research: ["shards"], troop: ["speedups"] },
    slots,
    ...overrides,
  };
}

test("generates a WOS booking community configuration", () => {
  const config = buildBookingCommunityConfig(input("wos"));
  assert.equal(config.profile, "wos");
  assert.equal(config.community.code, "1234");
  assert.equal(config.services[0].slots.length, 4);
});

test("generates a Kingshot booking community configuration", () => {
  const config = buildBookingCommunityConfig(input("kingshot"));
  assert.equal(config.profile, "kingshot");
  assert.equal(config.community.code, "K-5678");
  assert.equal(config.community.displayName, "Kingdom 5678");
});

test("rejects an invalid Discord guild ID", () => {
  for (const value of ["1234", "12345678901234x", "12345678901234", "000123456789012345", "99999999999999999999"]) {
    assert.throws(() => validateDiscordGuildId(value), /Discord snowflake/);
  }
});

test("rejects invalid dates", () => {
  for (const value of ["01-09-2026", "2026-02-30", "2026-9-01"]) {
    assert.throws(() => validateDate(value), /YYYY-MM-DD|calendar date/);
  }
});

test("rejects invalid IANA timezones", () => {
  assert.throws(() => validateTimeZone("Mars/Olympus"), /IANA timezone/);
});

test("rejects invalid slot times and schedules that cross midnight", () => {
  for (const value of ["9:00", "24:00", "12:60", "noon"]) {
    assert.throws(() => validateTime(value), /HH:MM/);
  }
  assert.throws(
    () => generateAppointmentSchedule({ firstSlotTime: "23:30", intervalMinutes: 30, numberOfSlots: 2 }),
    /past 23:59/,
  );
});

test("refuses to overwrite an existing file without explicit confirmation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "booking-config-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "existing.json");
  await writeFile(outputPath, "keep me", "utf8");
  const result = await writeBookingConfigFile(outputPath, buildBookingCommunityConfig(input("wos")), {
    confirmOverwrite: async () => false,
  });
  assert.deepEqual(result, { written: false, reason: "overwrite_refused" });
  assert.equal(await readFile(outputPath, "utf8"), "keep me");
});

test("booking-open defaults to false", () => {
  assert.equal(buildBookingCommunityConfig(input("wos")).booking.open, false);
  assert.equal(buildBookingCommunityConfig(input("wos", { bookingOpen: true })).booking.open, true);
});

test("human requirement labels map to native compatibility codes", () => {
  assert.deepEqual(requirementChoices("wos").construction.map(({ code, label }) => [label, code]), [
    ["Fire Crystals", "fc"],
    ["Refined Fire Crystals", "rfc"],
    ["Speed-ups (days)", "speedups"],
  ]);
  assert.deepEqual(requirementChoices("kingshot").construction.map(({ code, label }) => [label, code]), [
    ["Truegold", "fc"],
    ["Tempered Truegold", "rfc"],
    ["Speed-ups (days)", "speedups"],
  ]);
  assert.deepEqual(requirementChoices("kingshot").research.map(({ code, label }) => [label, code]), [
    ["Truegold Dust", "shards"],
    ["Speed-ups (days)", "speedups"],
  ]);
});

test("generated output passes the existing bootstrap validator", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "booking-config-valid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const profile of ["wos", "kingshot"]) {
    const outputPath = path.join(directory, `${profile}.json`);
    const result = await writeBookingConfigFile(outputPath, buildBookingCommunityConfig(input(profile)));
    assert.equal(result.written, true);
    const parsed = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(validateBookingBootstrapConfig(parsed).profile, profile);
  }
});
