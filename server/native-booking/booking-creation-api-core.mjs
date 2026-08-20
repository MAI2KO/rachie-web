import {
  assertFutureBookingMutationMembershipFresh,
  AuthenticatedBookingHostNotFoundError,
  BookingAuthenticationRequiredError,
  BookingCommunityMembershipLostError,
  BookingCommunitySelectionRequiredError,
  BookingMembershipRefreshRequiredError,
  BookingMembershipVerificationUnavailableError,
} from "../auth/authenticated-booking-context-core.mjs";
import { InvalidIdempotencyKeyError } from "./registration-validation.mjs";
import { BookingCreationError, BookingIdempotencyConflictError } from "./booking-creation-service-core.mjs";
import { InvalidBookingRequestError, validateBookingChoice, validateIdempotencyKey } from "./booking-creation-validation.mjs";

const NO_STORE = Object.freeze({ "Cache-Control": "no-store" });
const errorResponse = (status, error, code, extra = {}, headers = {}) => Response.json({ ok: false, error, code, ...extra }, { status, headers: { ...NO_STORE, ...headers } });

function contextError(error) {
  if (error instanceof AuthenticatedBookingHostNotFoundError) return errorResponse(404, "Native booking context not found.", "not_found");
  if (error instanceof BookingAuthenticationRequiredError) return errorResponse(401, "Authentication is required.", "authentication_required");
  if (error instanceof BookingMembershipRefreshRequiredError) return errorResponse(401, "Discord membership must be refreshed by signing in again.", "membership_refresh_required");
  if (error instanceof BookingCommunityMembershipLostError) return errorResponse(409, "Your Discord membership in the selected community could not be confirmed.", "community_membership_lost");
  if (error instanceof BookingMembershipVerificationUnavailableError) return errorResponse(503, "Discord membership could not be verified right now.", "membership_verification_unavailable", {}, error.retryAfterSeconds === null ? {} : { "Retry-After": String(error.retryAfterSeconds) });
  if (error instanceof BookingCommunitySelectionRequiredError) return errorResponse(409, "A verified booking community must be selected.", "community_selection_required");
  return errorResponse(503, "Booking service is unavailable.", "service_unavailable");
}

export function createBookingCreationApi(dependencies) {
  return Object.freeze({
    async create(request) {
      let context;
      try {
        context = await dependencies.resolveAuthenticatedContext(request);
      } catch (error) { return contextError(error); }
      try {
        const limit = await dependencies.consumeMutationRateLimit(context.gameProfile, `${context.session.tokenHash}:${context.community.id}`);
        if (!limit.allowed) return errorResponse(429, "Too many requests.", "rate_limited", {}, { "Retry-After": String(limit.retryAfterSeconds) });
      } catch { return errorResponse(503, "Booking service is unavailable.", "service_unavailable"); }
      if (!dependencies.verifyCsrf(request, context)) return errorResponse(403, "The request could not be verified.", "csrf_invalid");
      try {
        if (dependencies.refreshAuthenticatedMembership) {
          context = await dependencies.refreshAuthenticatedMembership(context);
        }
        assertFutureBookingMutationMembershipFresh(context);
      } catch (error) { return contextError(error); }

      let choice;
      let idempotencyKey;
      try {
        idempotencyKey = validateIdempotencyKey(request.headers.get("idempotency-key"));
        const body = await request.json();
        choice = validateBookingChoice(body);
      } catch (error) {
        if (error instanceof InvalidIdempotencyKeyError) return errorResponse(400, error.message, "idempotency_key_invalid");
        if (error instanceof InvalidBookingRequestError) return errorResponse(400, error.message, error.code, { fields: error.fields });
        return errorResponse(400, "Booking details are invalid.", "invalid_slot");
      }
      try {
        const repository = dependencies.createRepository(context.gameProfile);
        if (!repository) return errorResponse(503, "Booking service is unavailable.", "service_unavailable");
        const result = await dependencies.createService(context, repository).create(choice, idempotencyKey);
        return Response.json(result.body, { status: result.status, headers: { ...NO_STORE, ...(result.replayed ? { "Idempotency-Replayed": "true" } : {}) } });
      } catch (error) {
        if (error instanceof InvalidBookingRequestError) return errorResponse(400, error.message, error.code, { fields: error.fields });
        if (error instanceof BookingIdempotencyConflictError) return errorResponse(409, error.message, "idempotency_conflict");
        if (error instanceof BookingCreationError) {
          const status = ["booking_already_exists", "slot_unavailable"].includes(error.code) ? 409 : error.code === "registration_required" ? 409 : error.code === "invalid_service" || error.code === "invalid_slot" ? 400 : 409;
          return errorResponse(status, error.message, error.code);
        }
        return errorResponse(503, "Booking service is unavailable.", "service_unavailable");
      }
    },
  });
}
