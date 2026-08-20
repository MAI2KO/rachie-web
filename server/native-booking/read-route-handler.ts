import "server-only";

import { resolveAuthenticatedBookingRequestContext } from "@/server/auth/authenticated-booking-context";
import { withDevelopmentTiming } from "@/server/development-timing.mjs";
import { createServerRateLimiter } from "@/server/rate-limit/limiter";
import { RATE_LIMIT_POLICIES } from "@/server/rate-limit/policies.mjs";

import { createNativeBookingReadApi } from "./read-api-core.mjs";
import { createNativeBookingReadService } from "./read-service";
import { createNativeBookingRepository } from "./repository";

const nativeBookingReadApi = createNativeBookingReadApi({
  resolveAuthenticatedContext: resolveAuthenticatedBookingRequestContext,
  createRepository: createNativeBookingRepository,
  createReadService: createNativeBookingReadService,
  consumeReadRateLimit(gameProfile: "wos" | "kingshot", subject: string) {
    const limiter = createServerRateLimiter(gameProfile);
    if (!limiter) throw new Error("Rate limiting is unavailable.");
    return limiter.consume(RATE_LIMIT_POLICIES.bookingRead, subject);
  },
});

export async function handleNativeBookingContextRead(
  request: Request,
): Promise<Response> {
  return withDevelopmentTiming("route GET /api/v1/booking/context", () => nativeBookingReadApi.context(request));
}

export async function handleNativeBookingAvailabilityRead(
  request: Request,
): Promise<Response> {
  return withDevelopmentTiming("route GET /api/v1/booking/availability", () => nativeBookingReadApi.availability(request));
}

export async function handleNativeBookingMeRead(
  request: Request,
): Promise<Response> {
  return withDevelopmentTiming("route GET /api/v1/booking/me", () => nativeBookingReadApi.me(request));
}
