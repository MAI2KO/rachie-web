import "server-only";

import { createServerRateLimiter } from "@/server/rate-limit/limiter";
import { requestNetworkSubject } from "@/server/rate-limit/request-subject.mjs";
import { resolveNativeBookingRequestContext } from "@/server/native-booking/request-context";
import { logNativeBookingFailure } from "@/server/native-booking/operation-diagnostics.mjs";
import { createGuestBookingApi } from "./api-core.mjs";
import { createBookingApprovalRepository } from "./repository";
import { createGuestBookingPageService, createGuestBookingRequestService } from "./service-core.mjs";

function configured(request: Request) {
  const context = resolveNativeBookingRequestContext(request);
  if (!context) return null;
  const repository = createBookingApprovalRepository(context.gameProfile);
  const limiter = createServerRateLimiter(context.gameProfile);
  if (!repository || !limiter) return null;
  const api = createGuestBookingApi({
    createPageService: () => createGuestBookingPageService({ gameProfile: context.gameProfile, repository }),
    createService: () => createGuestBookingRequestService({ gameProfile: context.gameProfile, repository }),
    resolveRateLimitSubject: requestNetworkSubject,
    consumeRateLimit: (policy: { code: string; limit: number; windowSeconds: number }, subject: string) => limiter.consume(policy, subject),
    verifyOrigin(currentRequest: Request) {
      const origin = currentRequest.headers.get("origin");
      if (!origin) return true;
      try { return new URL(origin).hostname.toLowerCase() === context.hostname; } catch { return false; }
    },
    logUnexpectedError: logNativeBookingFailure,
  });
  return api;
}

const unavailable = () => Response.json({ ok: false, error: "Guest booking is unavailable.", code: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });

export function handleGuestBookingRead(request: Request, token: string) {
  return configured(request)?.read(request, token) ?? unavailable();
}

export function handleGuestBookingSubmit(request: Request, token: string) {
  return configured(request)?.submit(request, token) ?? unavailable();
}
