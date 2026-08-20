import "server-only";

import { resolveAuthenticatedBookingMutationRequestContext } from "@/server/auth/authenticated-booking-context";
import { refreshAuthenticatedBookingMembership } from "@/server/auth/booking-membership-refresh";
import { verifyAuthenticatedMutationCsrf } from "@/server/auth/mutation-csrf";
import { createServerRateLimiter } from "@/server/rate-limit/limiter";
import { RATE_LIMIT_POLICIES } from "@/server/rate-limit/policies.mjs";

import { createNativeBookingRepository } from "./repository";
import { createRegistrationApi } from "./registration-api-core.mjs";
import { createNativeRegistrationService } from "./registration-service";

const registrationApi = createRegistrationApi({
  resolveAuthenticatedContext: resolveAuthenticatedBookingMutationRequestContext,
  refreshAuthenticatedMembership: refreshAuthenticatedBookingMembership,
  verifyCsrf: verifyAuthenticatedMutationCsrf,
  createRepository: createNativeBookingRepository,
  createService: createNativeRegistrationService,
  consumeMutationRateLimit(
    gameProfile: "wos" | "kingshot",
    subject: string,
  ) {
    const limiter = createServerRateLimiter(gameProfile);
    if (!limiter) throw new Error("Rate limiting is unavailable.");
    return limiter.consume(RATE_LIMIT_POLICIES.futureBookingMutation, subject);
  },
});

export async function handleRegistrationUpsert(
  request: Request,
): Promise<Response> {
  return registrationApi.upsert(request);
}
