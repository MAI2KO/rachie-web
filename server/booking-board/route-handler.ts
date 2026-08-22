import "server-only";

import { BookingApprovalTransitionError } from "@/server/booking-approval/domain-core.mjs";
import { createBookingApprovalRepository } from "@/server/booking-approval/repository";
import {
  createBookingApprovalService,
  createBookingBoardReadService,
} from "@/server/booking-approval/service-core.mjs";
import { resolveAuthenticatedDiscordSession } from "@/server/auth/authenticated-discord-session";
import { BookingAuthenticationRequiredError } from "@/server/auth/authenticated-booking-context-core.mjs";
import { verifyDiscordGuildManager } from "@/server/auth/discord-guild-membership-verifier";
import { verifyAuthenticatedMutationCsrf } from "@/server/auth/mutation-csrf";
import { createServerRateLimiter } from "@/server/rate-limit/limiter";
import { RATE_LIMIT_POLICIES } from "@/server/rate-limit/policies.mjs";
import { resolveNativeBookingRequestContext } from "@/server/native-booking/request-context";
import { createNativeBookingRepository } from "@/server/native-booking/repository";
import {
  BookingMutationError,
  BookingMutationIdempotencyConflictError,
} from "@/server/native-booking/booking-mutation-service-core.mjs";
import { InvalidIdempotencyKeyError } from "@/server/native-booking/registration-validation.mjs";
import {
  createCommunityManagerAuthorizer,
  ManagerAccessDeniedError,
  ManagerVerificationUnavailableError,
  validateCommunityCode,
} from "./manager-authorization-core.mjs";
import { createManagerBookingMutationService } from "./manager-booking-mutation-core.mjs";

const headers = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200, extraHeaders: HeadersInit = {}) =>
  Response.json(body, { status, headers: { ...headers, ...extraHeaders } });

async function publicScope(request: Request, rawCommunityCode: string) {
  const context = resolveNativeBookingRequestContext(request);
  if (!context) return null;
  const communityCode = validateCommunityCode(rawCommunityCode);
  const repository = createBookingApprovalRepository(context.gameProfile);
  if (!repository) throw new Error("Appointment board database is unavailable.");
  const community = await repository.withTransaction((session: {
    findActiveCommunityByLocationCode(code: string): Promise<{ id: string } | null>;
  }) => session.findActiveCommunityByLocationCode(communityCode));
  return community ? { context, repository, community } : null;
}

async function managerScope(request: Request, rawCommunityCode: string) {
  const discordSession = await resolveAuthenticatedDiscordSession(request);
  const repository = createBookingApprovalRepository(discordSession.gameProfile);
  if (!repository) throw new Error("Appointment board database is unavailable.");
  const managerContext = await createCommunityManagerAuthorizer({
    gameProfile: discordSession.gameProfile,
    repository,
    verifyDiscordGuildManager,
  }).authorize(discordSession, rawCommunityCode);
  return { discordSession, repository, managerContext };
}

function managerError(error: unknown) {
  if (error instanceof BookingAuthenticationRequiredError) {
    return json({ ok: false, error: "Authentication is required.", code: "authentication_required" }, 401);
  }
  if (error instanceof ManagerAccessDeniedError) {
    return json({ ok: false, error: error.message, code: error.code },
      error.code === "community_not_found" ? 404 : 403);
  }
  if (error instanceof ManagerVerificationUnavailableError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      503,
      error.retryAfterSeconds === null ? {} : { "Retry-After": String(error.retryAfterSeconds) },
    );
  }
  if (error instanceof BookingApprovalTransitionError) {
    const status = error.code === "request_not_found" ? 404
      : ["invalid_transition", "slot_unavailable"].includes(error.code) ? 409 : 403;
    return json({ ok: false, error: error.message, code: error.code }, status);
  }
  if (error instanceof InvalidIdempotencyKeyError) {
    return json({ ok: false, error: error.message, code: "idempotency_key_invalid" }, 400);
  }
  if (error instanceof BookingMutationIdempotencyConflictError) {
    return json({ ok: false, error: error.message, code: error.code }, 409);
  }
  if (error instanceof BookingMutationError) {
    const status = error.code === "booking_not_found" ? 404
      : error.code === "invalid_slot" ? 400 : 409;
    return json({ ok: false, error: error.message, code: error.code }, status);
  }
  return json({ ok: false, error: "Appointment management is unavailable.", code: "unavailable" }, 503);
}

export async function handlePublicAppointmentBoard(request: Request, communityCode: string) {
  try {
    const scope = await publicScope(request, communityCode);
    if (!scope) return json({ ok: false, error: "Community was not found.", code: "community_not_found" }, 404);
    const board = await createBookingBoardReadService({
      gameProfile: scope.context.gameProfile,
      communityId: scope.community.id,
      repository: scope.repository,
    }).publicBoard();
    return json({ ok: true, board });
  } catch (error) {
    if (error instanceof ManagerAccessDeniedError) {
      return json({ ok: false, error: "Community was not found.", code: "community_not_found" }, 404);
    }
    return json({ ok: false, error: "Appointment board is unavailable.", code: "unavailable" }, 503);
  }
}

export async function handleManagerAppointmentBoard(request: Request, communityCode: string) {
  try {
    const scope = await managerScope(request, communityCode);
    const board = await createBookingBoardReadService({
      gameProfile: scope.discordSession.gameProfile,
      communityId: scope.managerContext.authorizedCommunityId,
      managerContext: scope.managerContext,
      repository: scope.repository,
    }).managerBoard();
    return json({ ok: true, board, authorization: { via: scope.managerContext.authorization.via } });
  } catch (error) {
    return managerError(error);
  }
}

export async function handleManagerApprovalMutation(
  request: Request,
  communityCode: string,
  requestId: string,
) {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return json({ ok: false, error: "Booking request was not found.", code: "request_not_found" }, 404);
    }
    const scope = await managerScope(request, communityCode);
    if (!verifyAuthenticatedMutationCsrf(request, scope.discordSession)) {
      return json({ ok: false, error: "The request could not be verified.", code: "csrf_invalid" }, 403);
    }
    const limiter = createServerRateLimiter(scope.discordSession.gameProfile);
    if (!limiter) throw new Error("Rate limiting is unavailable.");
    const limited = await limiter.consume(
      RATE_LIMIT_POLICIES.managerBookingMutation,
      `${scope.discordSession.session.tokenHash}:${scope.managerContext.authorizedCommunityId}`,
    );
    if (!limited.allowed) {
      return json(
        { ok: false, error: "Too many manager actions.", code: "rate_limited" },
        429,
        { "Retry-After": String(limited.retryAfterSeconds) },
      );
    }
    let body: unknown;
    try { body = await request.json(); } catch { body = null; }
    const action = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { action?: unknown }).action : null;
    if (action !== "approve" && action !== "deny") {
      return json({ ok: false, error: "Action must be approve or deny.", code: "invalid_action" }, 400);
    }
    const service = createBookingApprovalService({
      gameProfile: scope.discordSession.gameProfile,
      communityId: scope.managerContext.authorizedCommunityId,
      managerContext: scope.managerContext,
      repository: scope.repository,
    });
    const result = action === "approve" ? await service.approve(requestId) : await service.deny(requestId);
    return json({ ok: true, result });
  } catch (error) {
    return managerError(error);
  }
}

export async function handleManagerBookingMutation(
  request: Request,
  communityCode: string,
  bookingId: string,
  action: "reschedule" | "cancel",
) {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bookingId)) {
      return json({ ok: false, error: "Booking was not found.", code: "booking_not_found" }, 404);
    }
    const scope = await managerScope(request, communityCode);
    if (!verifyAuthenticatedMutationCsrf(request, scope.discordSession)) {
      return json({ ok: false, error: "The request could not be verified.", code: "csrf_invalid" }, 403);
    }
    const limiter = createServerRateLimiter(scope.discordSession.gameProfile);
    if (!limiter) throw new Error("Rate limiting is unavailable.");
    const limited = await limiter.consume(
      RATE_LIMIT_POLICIES.managerBookingMutation,
      `${scope.discordSession.session.tokenHash}:${scope.managerContext.authorizedCommunityId}`,
    );
    if (!limited.allowed) {
      return json(
        { ok: false, error: "Too many manager actions.", code: "rate_limited" },
        429,
        { "Retry-After": String(limited.retryAfterSeconds) },
      );
    }
    const idempotencyKey = request.headers.get("idempotency-key");
    const repository = createNativeBookingRepository(scope.discordSession.gameProfile);
    if (!repository) throw new Error("Appointment management database is unavailable.");
    const service = createManagerBookingMutationService({
      gameProfile: scope.discordSession.gameProfile,
      communityId: scope.managerContext.authorizedCommunityId,
      managerContext: scope.managerContext,
      repository,
    });
    const result = action === "cancel"
      ? await service.cancel(bookingId, idempotencyKey)
      : await service.reschedule(bookingId, await managerRescheduleSlot(request), idempotencyKey);
    return json(result.body, result.status, result.replayed ? { "Idempotency-Replayed": "true" } : {});
  } catch (error) {
    return managerError(error);
  }
}

async function managerRescheduleSlot(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => key !== "slotId")) {
    throw new BookingMutationError("invalid_slot", "Invalid appointment slot.");
  }
  return (body as { slotId?: unknown }).slotId;
}
