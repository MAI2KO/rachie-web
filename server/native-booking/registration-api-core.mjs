import {
  assertFutureBookingMutationMembershipFresh,
  AuthenticatedBookingHostNotFoundError,
  BookingAuthenticationRequiredError,
  BookingCommunitySelectionRequiredError,
  BookingMembershipRefreshRequiredError,
} from "../auth/authenticated-booking-context-core.mjs";
import {
  RegistrationIdempotencyConflictError,
  RegistrationOwnershipAmbiguousError,
} from "./registration-service-core.mjs";
import {
  InvalidIdempotencyKeyError,
  InvalidRegistrationError,
  validateIdempotencyKey,
  validateRegistrationInput,
} from "./registration-validation.mjs";

const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "no-store" });

function errorResponse(status, error, code, extra = {}, headers = {}) {
  return Response.json(
    { ok: false, error, code, ...extra },
    { status, headers: { ...NO_STORE_HEADERS, ...headers } },
  );
}

function contextError(error) {
  if (error instanceof AuthenticatedBookingHostNotFoundError) {
    return errorResponse(404, "Native booking context not found.", "not_found");
  }
  if (error instanceof BookingAuthenticationRequiredError) {
    return errorResponse(401, "Authentication is required.", "authentication_required");
  }
  if (error instanceof BookingMembershipRefreshRequiredError) {
    return errorResponse(
      401,
      "Discord membership must be refreshed by signing in again.",
      "membership_refresh_required",
    );
  }
  if (error instanceof BookingCommunitySelectionRequiredError) {
    return errorResponse(
      409,
      "A verified booking community must be selected.",
      "community_selection_required",
    );
  }
  return errorResponse(503, "Native booking data is unavailable.", "unavailable");
}

async function readJsonObject(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;
  } catch {
    return null;
  }
}

export function createRegistrationApi(dependencies) {
  return Object.freeze({
    async upsert(request) {
      let context;
      try {
        context = await dependencies.resolveAuthenticatedContext(request);
        assertFutureBookingMutationMembershipFresh(context);
      } catch (error) {
        return contextError(error);
      }

      try {
        const limit = await dependencies.consumeMutationRateLimit(
          context.gameProfile,
          `${context.session.tokenHash}:${context.community.id}`,
        );
        if (!limit.allowed) {
          return errorResponse(
            429,
            "Too many requests.",
            "rate_limited",
            {},
            { "Retry-After": String(limit.retryAfterSeconds) },
          );
        }
      } catch {
        return errorResponse(503, "Native booking data is unavailable.", "unavailable");
      }

      if (!dependencies.verifyCsrf(request, context)) {
        return errorResponse(403, "The request could not be verified.", "csrf_invalid");
      }

      let idempotencyKey;
      let registration;
      try {
        idempotencyKey = validateIdempotencyKey(
          request.headers.get("idempotency-key"),
        );
        const body = await readJsonObject(request);
        registration = validateRegistrationInput(body);
      } catch (error) {
        if (error instanceof InvalidIdempotencyKeyError) {
          return errorResponse(
            400,
            error.message,
            "idempotency_key_invalid",
          );
        }
        if (error instanceof InvalidRegistrationError) {
          return errorResponse(
            400,
            error.message,
            "invalid_registration",
            { fields: error.fields },
          );
        }
        return errorResponse(
          400,
          "Registration details are invalid.",
          "invalid_registration",
        );
      }

      try {
        const repository = dependencies.createRepository(context.gameProfile);
        if (!repository) {
          return errorResponse(503, "Native booking data is unavailable.", "unavailable");
        }
        const service = dependencies.createService(context, repository);
        const result = await service.upsert(registration, idempotencyKey);
        return Response.json(result.body, {
          status: result.status,
          headers: {
            ...NO_STORE_HEADERS,
            ...(result.replayed ? { "Idempotency-Replayed": "true" } : {}),
          },
        });
      } catch (error) {
        if (error instanceof RegistrationIdempotencyConflictError) {
          return errorResponse(409, error.message, "idempotency_conflict");
        }
        if (error instanceof RegistrationOwnershipAmbiguousError) {
          return errorResponse(
            409,
            "Participant registration could not be resolved safely.",
            "participant_ambiguous",
          );
        }
        return errorResponse(503, "Native booking data is unavailable.", "unavailable");
      }
    },
  });
}
