import "server-only";

import { BookingApprovalTransitionError } from "@/server/booking-approval/domain-core.mjs";
import { BookingAuthenticationRequiredError } from "@/server/auth/authenticated-booking-context-core.mjs";
import { verifyAuthenticatedMutationCsrf } from "@/server/auth/mutation-csrf";
import { verifyDiscordGuildOwner } from "@/server/auth/discord-guild-membership-verifier";
import {
  ManagerAccessDeniedError,
  ManagerVerificationUnavailableError,
} from "@/server/booking-board/manager-authorization-core.mjs";
import { createServerRateLimiter } from "@/server/rate-limit/limiter";
import { RATE_LIMIT_POLICIES } from "@/server/rate-limit/policies.mjs";

import { authorizeBookingAdminRequest } from "./access";
import {
  BookingAdminTopologyDeniedError,
  BookingAdminTopologyUnavailableError,
  BookingAdminValidationError,
} from "./domain-core.mjs";
import { createBookingAdminRepository } from "./repository";
import { createBookingAdminService, BookingAdminUnavailableError } from "./service-core.mjs";

const responseHeaders = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200, extraHeaders: HeadersInit = {}) =>
  Response.json(body, { status, headers: { ...responseHeaders, ...extraHeaders } });

function bookingAdminError(error: unknown) {
  if (error instanceof BookingAuthenticationRequiredError) {
    return json({ ok: false, code: "authentication_required", error: "Authentication is required." }, 401);
  }
  if (error instanceof ManagerAccessDeniedError || error instanceof BookingApprovalTransitionError) {
    const code = String((error as { code?: unknown }).code ?? "manager_forbidden");
    return json({ ok: false, code, error: error.message }, code === "community_not_found" ? 404 : 403);
  }
  if (error instanceof ManagerVerificationUnavailableError) {
    return json({ ok: false, code: error.code, error: error.message }, 503,
      error.retryAfterSeconds === null ? {} : { "Retry-After": String(error.retryAfterSeconds) });
  }
  if (error instanceof BookingAdminValidationError) {
    return json({ ok: false, code: error.code, error: error.message }, 400);
  }
  if (error instanceof BookingAdminTopologyDeniedError) {
    return json({ ok: false, code: error.code, error: error.message }, 403);
  }
  if (error instanceof BookingAdminTopologyUnavailableError) {
    return json({ ok: false, code: error.code, error: error.message }, 503);
  }
  if (error instanceof BookingAdminUnavailableError) {
    return json({ ok: false, code: error.code, error: error.message }, 503);
  }
  return json({ ok: false, code: "unavailable", error: "Booking administration is unavailable." }, 503);
}

async function scope(request: Request, communityCode: string) {
  const authorization = await authorizeBookingAdminRequest(request, communityCode);
  const repository = createBookingAdminRepository(authorization.discordSession.gameProfile);
  if (!repository) throw new BookingAdminUnavailableError();
  const service = createBookingAdminService({
    gameProfile: authorization.discordSession.gameProfile,
    communityId: authorization.managerContext.authorizedCommunityId,
    managerContext: authorization.managerContext,
    repository,
    verifyGuildOwner: verifyDiscordGuildOwner,
  });
  return { ...authorization, service };
}

export async function handleBookingAdminRead(request: Request, communityCode: string) {
  try {
    const authorized = await scope(request, communityCode);
    return json({ ok: true, configuration: await authorized.service.read(),
      authorization: { via: authorized.managerContext.authorization.via } });
  } catch (error) {
    return bookingAdminError(error);
  }
}

export async function handleBookingAdminMutation(request: Request, communityCode: string) {
  try {
    const authorized = await scope(request, communityCode);
    if (!verifyAuthenticatedMutationCsrf(request, authorized.discordSession)) {
      return json({ ok: false, code: "csrf_invalid", error: "The request could not be verified." }, 403);
    }
    const limiter = createServerRateLimiter(authorized.discordSession.gameProfile);
    if (!limiter) throw new BookingAdminUnavailableError();
    const limited = await limiter.consume(
      RATE_LIMIT_POLICIES.bookingAdminMutation,
      `${authorized.discordSession.session.tokenHash}:${authorized.managerContext.authorizedCommunityId}`,
    );
    if (!limited.allowed) {
      return json({ ok: false, code: "rate_limited", error: "Too many configuration changes." }, 429,
        { "Retry-After": String(limited.retryAfterSeconds) });
    }
    let body: unknown;
    try { body = await request.json(); } catch { body = null; }
    if (body && typeof body === "object" && !Array.isArray(body)
        && (body as { section?: unknown }).section === "guestLink") {
      return json({ ok: true, ...(await authorized.service.updateGuestLink(body)) });
    }
    if (body && typeof body === "object" && !Array.isArray(body)
        && (body as { section?: unknown }).section === "discordAccess") {
      return json({ ok: true, ...(await authorized.service.unlinkAllianceGuild(body)) });
    }
    if (body && typeof body === "object" && !Array.isArray(body)
        && (body as { section?: unknown }).section === "cycleSchedule") {
      return json({ ok: true, ...(await authorized.service.updateCycleSchedule(body)) });
    }
    return json({ ok: true, configuration: await authorized.service.update(body) });
  } catch (error) {
    return bookingAdminError(error);
  }
}
