import {
  assertFutureBookingMutationMembershipFresh,
  AuthenticatedBookingHostNotFoundError,
  BookingAuthenticationRequiredError,
  BookingCommunityMembershipLostError,
  BookingCommunitySelectionRequiredError,
  BookingMembershipRefreshRequiredError,
  BookingMembershipVerificationUnavailableError,
} from "../auth/authenticated-booking-context-core.mjs";
import { InvalidIdempotencyKeyError, validateIdempotencyKey } from "./registration-validation.mjs";
import { InvalidBookingRequestError, validateRescheduleChoice } from "./booking-creation-validation.mjs";
import { BookingMutationError, BookingMutationIdempotencyConflictError } from "./booking-mutation-service-core.mjs";

const NO_STORE = Object.freeze({ "Cache-Control": "no-store" });
const errorResponse = (status, error, code, extra = {}, headers = {}) => Response.json({ ok: false, error, code, ...extra }, { status, headers: { ...NO_STORE, ...headers } });
const validId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function unexpected(dependencies, operation, error, request) {
  dependencies.logUnexpectedError?.({ operation, error, request });
}

function contextError(error, dependencies, operation, request) {
  if (error instanceof AuthenticatedBookingHostNotFoundError) return errorResponse(404, "Native booking context not found.", "not_found");
  if (error instanceof BookingAuthenticationRequiredError) return errorResponse(401, "Authentication is required.", "authentication_required");
  if (error instanceof BookingMembershipRefreshRequiredError) return errorResponse(401, "Discord membership must be refreshed by signing in again.", "membership_refresh_required");
  if (error instanceof BookingCommunityMembershipLostError) return errorResponse(409, "Your Discord membership in the selected community could not be confirmed.", "community_membership_lost");
  if (error instanceof BookingMembershipVerificationUnavailableError) return errorResponse(503, "Discord membership could not be verified right now.", "membership_verification_unavailable", {}, error.retryAfterSeconds === null ? {} : { "Retry-After": String(error.retryAfterSeconds) });
  if (error instanceof BookingCommunitySelectionRequiredError) return errorResponse(409, "A verified booking community must be selected.", "community_selection_required");
  unexpected(dependencies, operation, error, request);
  return errorResponse(503, "Booking service is unavailable.", "service_unavailable");
}

async function prepare(request, bookingId, dependencies, operation) {
  if (!validId(bookingId)) return { error: errorResponse(404, "Booking was not found.", "booking_not_found") };
  let context;
  try { context = await dependencies.resolveAuthenticatedContext(request); }
  catch (error) { return { error: contextError(error, dependencies, `${operation}_context`, request) }; }
  try {
    const limit = await dependencies.consumeMutationRateLimit(context.gameProfile, `${context.session.tokenHash}:${context.community.id}`);
    if (!limit.allowed) return { error: errorResponse(429, "Too many requests.", "rate_limited", {}, { "Retry-After": String(limit.retryAfterSeconds) }) };
  } catch (error) {
    unexpected(dependencies, `${operation}_rate_limit`, error, request);
    return { error: errorResponse(503, "Booking service is unavailable.", "service_unavailable") };
  }
  if (!dependencies.verifyCsrf(request, context)) return { error: errorResponse(403, "The request could not be verified.", "csrf_invalid") };
  try {
    if (dependencies.refreshAuthenticatedMembership) {
      context = await dependencies.refreshAuthenticatedMembership(context);
    }
    assertFutureBookingMutationMembershipFresh(context);
  } catch (error) { return { error: contextError(error, dependencies, `${operation}_membership`, request) }; }
  try {
    const idempotencyKey = validateIdempotencyKey(request.headers.get("idempotency-key"));
    const repository = dependencies.createRepository(context.gameProfile);
    if (!repository) return { error: errorResponse(503, "Booking service is unavailable.", "service_unavailable") };
    return { context, idempotencyKey, service: dependencies.createService(context, repository) };
  } catch (error) {
    if (error instanceof InvalidIdempotencyKeyError) return { error: errorResponse(400, error.message, "idempotency_key_invalid") };
    unexpected(dependencies, `${operation}_prepare`, error, request);
    return { error: errorResponse(503, "Booking service is unavailable.", "service_unavailable") };
  }
}

function controlled(error, dependencies, operation, request) {
  if (error instanceof InvalidBookingRequestError) return errorResponse(400, error.message, error.code, { fields: error.fields });
  if (error instanceof BookingMutationIdempotencyConflictError) return errorResponse(409, error.message, "idempotency_conflict");
  if (error instanceof BookingMutationError) {
    const status = error.code === "booking_not_found" ? 404 : error.code === "invalid_slot" ? 400 : 409;
    return errorResponse(status, error.message, error.code);
  }
  unexpected(dependencies, operation, error, request);
  return errorResponse(503, "Booking service is unavailable.", "service_unavailable");
}
const success = (result) => Response.json(result.body, { status: result.status, headers: { ...NO_STORE, ...(result.replayed ? { "Idempotency-Replayed": "true" } : {}) } });

export function createBookingMutationApi(dependencies) {
  return Object.freeze({
    async reschedule(request, bookingId) {
      const prepared = await prepare(request, bookingId, dependencies, "booking_reschedule");
      if (prepared.error) return prepared.error;
      let choice;
      try { choice = validateRescheduleChoice(await request.json()); }
      catch (error) { return controlled(error, dependencies, "booking_reschedule_prepare", request); }
      try { return success(await prepared.service.reschedule(bookingId, choice, prepared.idempotencyKey)); }
      catch (error) { return controlled(error, dependencies, "booking_reschedule", request); }
    },
    async cancel(request, bookingId) {
      const prepared = await prepare(request, bookingId, dependencies, "booking_cancel");
      if (prepared.error) return prepared.error;
      try { return success(await prepared.service.cancel(bookingId, prepared.idempotencyKey)); }
      catch (error) { return controlled(error, dependencies, "booking_cancel", request); }
    },
  });
}
