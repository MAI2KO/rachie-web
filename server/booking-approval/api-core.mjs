import { InvalidBookingRequestError } from "../native-booking/booking-creation-validation.mjs";
import { InvalidIdempotencyKeyError } from "../native-booking/registration-validation.mjs";
import { RATE_LIMIT_POLICIES } from "../rate-limit/policies.mjs";
import { GuestBookingIdempotencyConflictError } from "./service-core.mjs";
import { GuestBookingRequestError, hashGuestShareToken } from "./domain-core.mjs";

const NO_STORE = Object.freeze({ "Cache-Control": "no-store" });
const response = (status, body, headers = {}) => Response.json(body, {
  status,
  headers: { ...NO_STORE, ...headers },
});

export function createGuestBookingApi(dependencies) {
  return Object.freeze({
    async read(request, rawToken) {
      try {
        const tokenHash = hashGuestShareToken(rawToken);
        const limit = await dependencies.consumeRateLimit(
          RATE_LIMIT_POLICIES.guestBookingRead,
          `${tokenHash}:${dependencies.resolveRateLimitSubject(request)}`,
        );
        if (!limit.allowed) {
          return response(429, { ok: false, error: "Too many guest booking requests.", code: "rate_limited" }, {
            "Retry-After": String(limit.retryAfterSeconds),
          });
        }
        return response(200, { ok: true, page: await dependencies.createPageService().read(rawToken) });
      } catch (error) {
        if (error instanceof GuestBookingRequestError && error.code === "invalid_share_link") {
          return response(404, { ok: false, error: "Guest booking link is invalid or unavailable.", code: "invalid_share_link" });
        }
        dependencies.logUnexpectedError?.({ operation: "guest_booking_read", error, request });
        return response(503, { ok: false, error: "Guest booking is unavailable.", code: "unavailable" });
      }
    },
    async submit(request, rawToken) {
      let tokenHash;
      try {
        tokenHash = hashGuestShareToken(rawToken);
      } catch (error) {
        if (error instanceof GuestBookingRequestError) {
          return response(404, { ok: false, error: error.message, code: error.code });
        }
        return response(503, { ok: false, error: "Guest booking is unavailable.", code: "unavailable" });
      }

      try {
        if (dependencies.verifyOrigin?.(request) === false) {
          return response(403, { ok: false, error: "The request could not be verified.", code: "csrf_invalid" });
        }
        const subject = dependencies.resolveRateLimitSubject(request);
        const limit = await dependencies.consumeRateLimit(
          RATE_LIMIT_POLICIES.guestBookingSubmission,
          `${tokenHash}:${subject}`,
        );
        if (!limit.allowed) {
          return response(429, { ok: false, error: "Too many guest booking requests.", code: "rate_limited" }, {
            "Retry-After": String(limit.retryAfterSeconds),
          });
        }
      } catch {
        return response(503, { ok: false, error: "Guest booking is unavailable.", code: "unavailable" });
      }

      try {
        const result = await dependencies.createService().create(
          rawToken,
          await request.json(),
          request.headers.get("idempotency-key"),
        );
        const safeRequest = {
          service: result.body.request.service,
          date: result.body.request.date,
          time: result.body.request.time,
          status: result.body.request.status,
          holdExpiresAt: result.body.request.holdExpiresAt,
        };
        return response(result.status, { request: safeRequest }, result.replayed ? { "Idempotency-Replayed": "true" } : {});
      } catch (error) {
        if (error instanceof InvalidIdempotencyKeyError) {
          return response(400, { ok: false, error: error.message, code: "idempotency_key_invalid" });
        }
        if (error instanceof InvalidBookingRequestError) {
          return response(400, { ok: false, error: error.message, code: error.code, fields: error.fields });
        }
        if (error instanceof GuestBookingIdempotencyConflictError) {
          return response(409, { ok: false, error: error.message, code: error.code });
        }
        if (error instanceof GuestBookingRequestError) {
          const status = error.code === "invalid_share_link" ? 404
            : ["slot_unavailable", "pending_request_exists", "bookings_closed", "booking_window_unavailable"].includes(error.code) ? 409
              : 400;
          return response(status, { ok: false, error: error.message, code: error.code, fields: error.fields });
        }
        dependencies.logUnexpectedError?.({ operation: "guest_booking_submit", error, request });
        return response(503, { ok: false, error: "Guest booking is unavailable.", code: "unavailable" });
      }
    },
  });
}
