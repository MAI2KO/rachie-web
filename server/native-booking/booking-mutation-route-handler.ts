import "server-only";

import { resolveAuthenticatedBookingRequestContext } from "@/server/auth/authenticated-booking-context";
import { verifyAuthenticatedMutationCsrf } from "@/server/auth/mutation-csrf";
import { createServerRateLimiter } from "@/server/rate-limit/limiter";
import { RATE_LIMIT_POLICIES } from "@/server/rate-limit/policies.mjs";
import { createBookingMutationApi } from "./booking-mutation-api-core.mjs";
import { createNativeBookingMutationService } from "./booking-mutation-service";
import { createNativeBookingRepository } from "./repository";

const api = createBookingMutationApi({
  resolveAuthenticatedContext: resolveAuthenticatedBookingRequestContext,
  verifyCsrf: verifyAuthenticatedMutationCsrf,
  createRepository: createNativeBookingRepository,
  createService: createNativeBookingMutationService,
  consumeMutationRateLimit(gameProfile: "wos" | "kingshot", subject: string) {
    const limiter = createServerRateLimiter(gameProfile);
    if (!limiter) throw new Error("Rate limiting is unavailable.");
    return limiter.consume(RATE_LIMIT_POLICIES.futureBookingMutation, subject);
  },
});

export const handleBookingReschedule = (request: Request, bookingId: string) => api.reschedule(request, bookingId);
export const handleBookingCancellation = (request: Request, bookingId: string) => api.cancel(request, bookingId);
