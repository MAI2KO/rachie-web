import assert from "node:assert/strict";
import test from "node:test";

import { BookingAuthenticationRequiredError, BookingMembershipRefreshRequiredError } from "../server/auth/authenticated-booking-context-core.mjs";
import { createBookingCreationApi } from "../server/native-booking/booking-creation-api-core.mjs";
import { createBookingCreationService } from "../server/native-booking/booking-creation-service-core.mjs";
import { validateBookingChoice, validateRequirementAnswers } from "../server/native-booking/booking-creation-validation.mjs";

const slotId = "00000000-0000-4000-8000-000000000001";
const context = {
  gameProfile: "wos",
  session: { tokenHash: "session" },
  discordUser: { id: "discord-user" },
  community: { id: "community", membershipVerifiedAt: new Date() },
};

function request(body = {}, headers = {}) {
  return new Request("http://localhost/api/v1/bookings", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "booking-request-0001", ...headers }, body: JSON.stringify({ serviceCode: "construction", slotId, requirements: {}, ...body }) });
}

function api(overrides = {}) {
  return createBookingCreationApi({
    async resolveAuthenticatedContext() { return context; },
    async consumeMutationRateLimit() { return { allowed: true, retryAfterSeconds: 1 }; },
    verifyCsrf() { return true; },
    createRepository() { return { gameProfile: "wos" }; },
    createService() { return { async create(choice) { return { status: 201, body: { booking: choice }, replayed: false }; } }; },
    ...overrides,
  });
}

test("booking choice accepts only a known service and opaque UUID slot", () => {
  assert.deepEqual(validateBookingChoice({ serviceCode: "construction", slotId, requirements: {} }), { serviceCode: "construction", slotId, requirements: {} });
  assert.throws(() => validateBookingChoice({ serviceCode: "unknown", slotId }), (error) => error.code === "invalid_service");
  assert.throws(() => validateBookingChoice({ serviceCode: "construction", slotId: "row-7" }), (error) => error.code === "invalid_slot");
});

test("requirements are service-enabled, bounded, and profile-labelled", () => {
  const settings = { construction_fc_required: true, construction_rfc_required: true, construction_speedups_required: false };
  assert.deepEqual(validateRequirementAnswers("wos", "construction", settings, { fc: "12", rfc: 3 }), [
    { code: "fc", value: 12, displayLabel: "Fire Crystals", unit: null },
    { code: "rfc", value: 3, displayLabel: "Refined Fire Crystals", unit: null },
  ]);
  assert.equal(validateRequirementAnswers("kingshot", "construction", settings, { fc: 12, rfc: 3 })[0].displayLabel, "Truegold");
  assert.throws(() => validateRequirementAnswers("wos", "construction", settings, { fc: 1 }), (error) => error.code === "invalid_requirements" && /Refined Fire Crystals/.test(error.fields.rfc));
  assert.throws(() => validateRequirementAnswers("kingshot", "construction", settings, { fc: 0, rfc: 3 }), (error) => error.code === "invalid_requirements" && /Truegold/.test(error.fields.fc));
  assert.throws(() => validateRequirementAnswers("wos", "construction", settings, { fc: 1, rfc: 2, speedups: 3 }), (error) => error.code === "invalid_requirements");
});

test("speed-ups are whole days for both profiles", () => {
  const settings = { troop_speedups_required: true };
  for (const profile of ["wos", "kingshot"]) {
    assert.deepEqual(validateRequirementAnswers(profile, "troop", settings, { speedups: 1 }), [
      { code: "speedups", value: 1, displayLabel: "Speed-ups (days)", unit: "days" },
    ]);
    assert.deepEqual(validateRequirementAnswers(profile, "troop", settings, { speedups: "365" }), [
      { code: "speedups", value: 365, displayLabel: "Speed-ups (days)", unit: "days" },
    ]);
  }
  for (const value of [0, -1, 1.5, "1.5", "1 day", "1e2", "", null]) {
    assert.throws(
      () => validateRequirementAnswers("wos", "troop", settings, { speedups: value }),
      (error) => error.code === "invalid_requirements" && /Speed-ups \(days\)/.test(error.fields.speedups),
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test("API ignores hostile ownership fields and enforces CSRF, rate, and freshness", async () => {
  let captured;
  const successful = api({ createService() { return { async create(choice) { captured = choice; return { status: 201, body: { booking: { bookingId: "public" } }, replayed: false }; } }; } });
  const response = await successful.create(request({ game_profile: "kingshot", communityId: "hostile", discordUserId: "hostile", guildId: "hostile", playerId: "hostile" }));
  assert.equal(response.status, 201);
  assert.deepEqual(captured, { serviceCode: "construction", slotId, requirements: {} });

  assert.equal((await api({ verifyCsrf() { return false; } }).create(request())).status, 403);
  assert.equal((await api({ async consumeMutationRateLimit() { return { allowed: false, retryAfterSeconds: 9 }; } }).create(request())).status, 429);
  assert.equal((await api({ async resolveAuthenticatedContext() { throw new BookingAuthenticationRequiredError(); } }).create(request())).status, 401);
  assert.equal((await api({ async resolveAuthenticatedContext() { throw new BookingMembershipRefreshRequiredError(); } }).create(request())).status, 401);
});

test("API returns stable controlled booking errors without internals", async () => {
  const response = await api({ createService() { return { async create() { const error = new Error("closed"); error.name = "BookingCreationError"; throw error; } }; } }).create(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "Booking service is unavailable.", code: "service_unavailable" });
});

function memberBookingFixture(participants) {
  let inserted = null;
  const session = {
    async lockCommunityForBooking() { return { status: "active", bookings_open: true }; },
    async claimBookingIdempotency() { return { state: "claimed" }; },
    async lockActiveParticipantsByDiscordUser() { return participants; },
    async lockAppointmentSlot() { return { id: slotId, window_id: "window", service_date_id: "date",
      service_code: "construction", booking_date: "2030-01-01", display_time_label: "08:00",
      service_label: "Construction", slot_status: "available", window_status: "open",
      service_active: true }; },
    async hasActiveSlotBlock() { return false; }, async hasActiveApprovalHoldForSlot() { return false; },
    async hasConfirmedBookingForSlot() { return false; },
    async hasConfirmedBookingForParticipantService() { return false; },
    async findBookingSettings() { return {}; },
    async insertConfirmedBooking(input) { inserted = input; return { id: input.id,
      service_code: input.serviceCode, booking_date: input.bookingDate,
      display_time_label_snapshot: input.displayTime, in_game_name_snapshot: input.inGameName,
      alliance_snapshot: input.alliance, status: "confirmed" }; },
    async insertBookingRequirementAnswer() {}, async insertBookingCreatedEvent() {},
    async insertBookingOutboxEvent() {}, async insertPlayerPointsEntry() { return true; },
    async insertCommunityParticipationPoints() { return true; }, async completeBookingIdempotency() {},
  };
  return { get inserted() { return inserted; }, repository: { gameProfile: "wos",
    async withTransaction(work) { return work(session); } } };
}

test("member booking auto-selects one character and persists an explicitly selected non-main character", async () => {
  const main = { id: "00000000-0000-4000-8000-000000000010", player_id: "10",
    in_game_name: "Main", alliance: "ONE", is_primary: true };
  const alt = { id: "00000000-0000-4000-8000-000000000011", player_id: "11",
    in_game_name: "Alt", alliance: "TWO", is_primary: false };
  const one = memberBookingFixture([main]);
  await createBookingCreationService({ context, repository: one.repository }).create(
    { serviceCode: "construction", slotId, requirements: {} }, "single-character-0001");
  assert.equal(one.inserted.participantId, main.id);

  const multiple = memberBookingFixture([main, alt]);
  await createBookingCreationService({ context, repository: multiple.repository }).create(
    { serviceCode: "construction", slotId, participantId: alt.id, requirements: {} },
    "selected-character-0001");
  assert.equal(multiple.inserted.participantId, alt.id);
  assert.equal(multiple.inserted.playerId, "11");
});

test("member booking cannot select another owner's or another community's character", async () => {
  const owned = { id: "00000000-0000-4000-8000-000000000010", player_id: "10",
    in_game_name: "Owned", alliance: "OWN", is_primary: true };
  const fixture = memberBookingFixture([owned]);
  await assert.rejects(createBookingCreationService({ context, repository: fixture.repository }).create(
    { serviceCode: "construction", slotId,
      participantId: "00000000-0000-4000-8000-000000000099", requirements: {} },
    "foreign-character-0001"), (error) => error.code === "invalid_character");
  assert.equal(fixture.inserted, null);
});
