import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { profileTerms, requirementFields, resolveBookingUiState, shouldShowLogout, signedOutBookingState, sortSlots, uiError } from "../components/booking/booking-ui-model.mjs";

const selected = { authenticated: true, selectedCommunity: { locationCode: "1" } };
const context = { bookingsOpen: true };

test("booking UI resolves unauthenticated, community, registration, and dashboard states", () => {
  assert.equal(resolveBookingUiState({ authenticated: false }, null, null), "unauthenticated");
  assert.equal(resolveBookingUiState({ authenticated: true, selectedCommunity: null }, null, null), "community-selection");
  assert.equal(resolveBookingUiState(selected, context, { registration: { status: "unregistered" } }), "registration");
  assert.equal(resolveBookingUiState(selected, context, { registration: { status: "registered" } }), "dashboard");
  assert.equal(resolveBookingUiState(selected, null, null, "membership_refresh_required"), "reauthentication-required");
  assert.equal(resolveBookingUiState(selected, null, null, "service_unavailable"), "unavailable");
});

test("logout stays visible throughout every authenticated booking state", () => {
  const authenticatedStates = [
    [{ authenticated: true, communities: [], selectedCommunity: null }, null, null],
    [{ authenticated: true, communities: [{ locationCode: "1" }], selectedCommunity: null }, null, null],
    [selected, context, { registration: { status: "unregistered" } }],
    [selected, context, { registration: { status: "registered" } }],
  ];
  for (const [session, bookingContext, me] of authenticatedStates) {
    assert.equal(shouldShowLogout(session), true, resolveBookingUiState(session, bookingContext, me));
  }
  assert.equal(shouldShowLogout({ authenticated: false }), false);
});

test("successful logout clears authenticated booking state and returns to signed-out UI", () => {
  const state = signedOutBookingState({ authenticated: false });
  assert.equal(resolveBookingUiState(state.session, state.context, state.me, state.errorCode), "unauthenticated");
  assert.equal(shouldShowLogout(state.session), false);
  assert.deepEqual(state, {
    session: { authenticated: false }, context: null, me: null, availability: null, availabilityFailed: false,
    selectedService: "construction", selectedSlot: "", requirements: {}, mode: null,
    error: "", errorCode: null, success: "", confirmation: null,
  });
});

test("WOS and Kingshot terminology and required fields cannot leak across profiles", () => {
  assert.deepEqual(profileTerms("wos"), { community: "State", fc: "Fire Crystals", rfc: "Refined Fire Crystals", shards: "Fire Crystal Shards", speedups: "Speed-ups (days)" });
  assert.deepEqual(profileTerms("kingshot"), { community: "Kingdom", fc: "Truegold", rfc: "Tempered Truegold", shards: "Truegold Dust", speedups: "Speed-ups (days)" });
  const config = { construction: { fcRequired: true, rfcRequired: false, speedupsRequired: true }, research: { shardsRequired: true, speedupsRequired: false } };
  assert.deepEqual(requirementFields("wos", "construction", config).map((field) => field.label), ["Fire Crystals", "Speed-ups (days)"]);
  assert.deepEqual(requirementFields("kingshot", "research", config).map((field) => field.label), ["Truegold Dust"]);
  assert.deepEqual(requirementFields("wos", "construction", config)[1], { code: "speedups", label: "Speed-ups (days)", helpText: "Enter whole days only." });
});

test("availability remains deterministic and handles no slots", () => {
  assert.deepEqual(sortSlots([{ slotId: "b", ordinal: 2 }, { slotId: "z", ordinal: 1 }, { slotId: "a", ordinal: 2 }]).map((slot) => slot.slotId), ["z", "a", "b"]);
  assert.deepEqual(sortSlots([]), []);
});

test("booking conflicts, closed windows, stale membership, rate limits, and outages have actionable messages", () => {
  assert.match(uiError("slot_unavailable"), /refreshed/i);
  assert.match(uiError("booking_already_exists"), /already/i);
  assert.match(uiError("bookings_closed"), /closed/i);
  assert.match(uiError("membership_refresh_required"), /sign in again/i);
  assert.match(uiError("rate_limited", "12"), /12 seconds/i);
  assert.match(uiError("service_unavailable"), /temporarily unavailable/i);
});

test("shared booking component uses only native APIs and explicit confirmation flows", () => {
  const source = fs.readFileSync(new URL("../components/booking/booking-experience.tsx", import.meta.url), "utf8");
  for (const endpoint of ["/api/v1/auth/session", "/api/v1/auth/community", "/api/v1/auth/logout", "/api/v1/booking/context", "/api/v1/booking/availability", "/api/v1/booking/me", "/api/v1/bookings"]) assert.match(source, new RegExp(endpoint.replaceAll("/", "\\/")));
  assert.match(source, /method: "POST", headers: \{ "x-csrf-token": session\?\.csrfToken \?\? "" \}/);
  assert.match(source, /shouldShowLogout\(session\).*Log out/);
  assert.doesNotMatch(source, /Apps Script|APPS_SCRIPT|R\.A\.C\.H\.I\.E|P\.E\.G\.G\.I\.E/);
  assert.match(source, /Confirm cancellation/);
  assert.match(source, /Confirm reschedule/);
  assert.match(source, /Idempotency-Replayed|idempotency-key/i);
  assert.match(source, /step="1"/);
});
