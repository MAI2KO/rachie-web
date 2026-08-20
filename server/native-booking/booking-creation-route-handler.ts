import "server-only";

import { resolveAuthenticatedBookingMutationRequestContext } from "@/server/auth/authenticated-booking-context";
import { refreshAuthenticatedBookingMembership } from "@/server/auth/booking-membership-refresh";
import { verifyAuthenticatedMutationCsrf } from "@/server/auth/mutation-csrf";
import { createServerRateLimiter } from "@/server/rate-limit/limiter";
import { RATE_LIMIT_POLICIES } from "@/server/rate-limit/policies.mjs";
import { createBookingCreationApi } from "./booking-creation-api-core.mjs";
import { createNativeBookingRepository } from "./repository";
import { createNativeBookingCreationService } from "./booking-creation-service";

const api = createBookingCreationApi({
  resolveAuthenticatedContext: resolveAuthenticatedBookingMutationRequestContext,
  refreshAuthenticatedMembership: refreshAuthenticatedBookingMembership,
  verifyCsrf: verifyAuthenticatedMutationCsrf,
  createRepository: createNativeBookingRepository,
  createService: createNativeBookingCreationService,
  consumeMutationRateLimit(gameProfile: "wos" | "kingshot", subject: string) {
    const limiter = createServerRateLimiter(gameProfile);
    if (!limiter) throw new Error("Rate limiting is unavailable.");
    return limiter.consume(RATE_LIMIT_POLICIES.futureBookingMutation, subject);
  },
});

export async function handleBookingCreate(request: Request): Promise<Response> { return api.create(request); }
