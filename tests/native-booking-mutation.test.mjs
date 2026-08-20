import assert from "node:assert/strict";
import test from "node:test";

import {
  BookingCommunityMembershipLostError,
  BookingMembershipRefreshRequiredError,
  BookingMembershipVerificationUnavailableError,
} from "../server/auth/authenticated-booking-context-core.mjs";
import { createBookingMutationApi } from "../server/native-booking/booking-mutation-api-core.mjs";
import { BookingMutationError, BookingMutationIdempotencyConflictError } from "../server/native-booking/booking-mutation-service-core.mjs";

const bookingId = "00000000-0000-4000-8000-000000000001";
const slotId = "00000000-0000-4000-8000-000000000002";
const trusted = { gameProfile: "wos", session: { tokenHash: "session" }, discordUser: { id: "trusted-user" }, community: { id: "trusted-community", membershipVerifiedAt: new Date() } };
const request = (method, body, headers = {}) => new Request(`http://localhost/api/v1/bookings/${bookingId}`, { method, headers: { "content-type": "application/json", "idempotency-key": "booking-mutation-0001", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
function api(overrides = {}) { return createBookingMutationApi({ async resolveAuthenticatedContext() { return trusted; }, async consumeMutationRateLimit() { return { allowed: true, retryAfterSeconds: 1 }; }, verifyCsrf() { return true; }, createRepository() { return { gameProfile: "wos" }; }, createService() { return { async reschedule(id, choice) { return { status: 200, body: { id, choice }, replayed: false }; }, async cancel(id) { return { status: 200, body: { id, status: "cancelled" }, replayed: false }; } }; }, ...overrides }); }

test("mutation API ignores hostile ownership fields and accepts only slot and requirements", async () => {
  const response = await api().reschedule(request("PATCH", { slotId, requirements: { fc: 1 }, game_profile: "kingshot", communityId: "foreign", participantId: "foreign", playerId: "foreign" }), bookingId);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).choice, { slotId, requirements: { fc: 1 } });
});

test("mutation API enforces membership, CSRF, and rate limiting", async () => {
  assert.equal((await api({ async resolveAuthenticatedContext() { throw new BookingMembershipRefreshRequiredError(); } }).cancel(request("DELETE"), bookingId)).status, 401);
  assert.equal((await api({ verifyCsrf() { return false; } }).cancel(request("DELETE"), bookingId)).status, 403);
  const limited = await api({ async consumeMutationRateLimit() { return { allowed: false, retryAfterSeconds: 7 }; } }).cancel(request("DELETE"), bookingId);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "7");
});

test("stale membership refresh happens after CSRF and prevents an OAuth response", async () => {
  const stale = { ...trusted, community: { ...trusted.community, membershipVerifiedAt: new Date(0), discordGuildId: "trusted-guild" } };
  let refreshes = 0;
  const refreshed = await api({
    async resolveAuthenticatedContext() { return stale; },
    async refreshAuthenticatedMembership(context) {
      refreshes += 1;
      assert.equal(context.community.discordGuildId, "trusted-guild");
      return { ...context, community: { ...context.community, membershipVerifiedAt: new Date() } };
    },
  }).cancel(request("DELETE"), bookingId);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshes, 1);
  assert.notEqual((await refreshed.json()).code, "membership_refresh_required");

  const rejected = await api({
    async resolveAuthenticatedContext() { return stale; },
    verifyCsrf() { return false; },
    async refreshAuthenticatedMembership() { refreshes += 1; return stale; },
  }).cancel(request("DELETE"), bookingId);
  assert.equal(rejected.status, 403);
  assert.equal(refreshes, 1);
});

test("membership loss and verifier failure are controlled mutation errors", async () => {
  const lost = await api({
    async refreshAuthenticatedMembership() { throw new BookingCommunityMembershipLostError(); },
  }).cancel(request("DELETE"), bookingId);
  assert.equal(lost.status, 409);
  assert.equal((await lost.json()).code, "community_membership_lost");

  const unavailable = await api({
    async refreshAuthenticatedMembership() { throw new BookingMembershipVerificationUnavailableError(6); },
  }).cancel(request("DELETE"), bookingId);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("retry-after"), "6");
  assert.equal((await unavailable.json()).code, "membership_verification_unavailable");
});

test("mutation API maps ownership, active-state, idempotency, and failures safely", async () => {
  for (const [error, status, code] of [
    [new BookingMutationError("booking_not_found", "Booking was not found."), 404, "booking_not_found"],
    [new BookingMutationError("booking_not_active", "Booking is not active."), 409, "booking_not_active"],
    [new BookingMutationIdempotencyConflictError(), 409, "idempotency_conflict"],
  ]) {
    const response = await api({ createService() { return { async cancel() { throw error; } }; } }).cancel(request("DELETE"), bookingId);
    assert.equal(response.status, status); assert.equal((await response.json()).code, code);
  }
  const unavailable = await api({ createService() { return { async cancel() { throw new Error("sql secret"); } }; } }).cancel(request("DELETE"), bookingId);
  assert.deepEqual(await unavailable.json(), { ok: false, error: "Booking service is unavailable.", code: "service_unavailable" });
});
