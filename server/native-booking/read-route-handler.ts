import "server-only";

import { resolveAuthenticatedBookingRequestContext } from "@/server/auth/authenticated-booking-context";
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
  return nativeBookingReadApi.context(request);
}

export async function handleNativeBookingAvailabilityRead(
  request: Request,
): Promise<Response> {
  return nativeBookingReadApi.availability(request);
}

export async function handleNativeBookingMeRead(
  request: Request,
): Promise<Response> {
  return nativeBookingReadApi.me(request);
}
