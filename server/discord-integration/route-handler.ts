import "server-only";

import type { GameProfile } from "@/brands/types";
import { verifyDiscordGuildManager } from "@/server/auth/discord-guild-membership-verifier";
import { BookingApprovalTransitionError } from "@/server/booking-approval/domain-core.mjs";
import { createBookingApprovalRepository } from "@/server/booking-approval/repository";
import { createBookingApprovalService } from "@/server/booking-approval/service-core.mjs";
import { createCommunityManagerAuthorizer } from "@/server/booking-board/manager-authorization-core.mjs";
import { resolveNativeBookingRequestContext } from "@/server/native-booking/request-context";

import {
  DiscordIntegrationAuthenticationError,
  verifyDiscordIntegrationRequest,
} from "./auth-core.mjs";
import { getBookingIntegrationSecret } from "./config";
import { getDiscordIntegrationRepository } from "./repository";

const responseHeaders = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: responseHeaders });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^\d{1,20}$/;
const observedClaimProfiles = new Set<GameProfile>();
const observedAuthenticationFailures = new Set<string>();

interface IntegrationSession {
  consumeNonce(nonce: string, expiresAt: Date): Promise<boolean>;
  claim(limit: unknown, deliveryContext?: object): Promise<unknown[]>;
  registerRecipients(workId: string, claimToken: unknown, recipients: unknown[]): Promise<boolean>;
  finish(workId: string, claimToken: unknown, outcome: object): Promise<boolean>;
}
interface IntegrationRepository {
  withTransaction<T>(work: (session: IntegrationSession) => Promise<T> | T): Promise<T>;
}
interface ApprovalSession {
  findRequest(requestId: string): Promise<{
    status: string; decided_by_display_name: string | null; community_id: string;
  } | null>;
  findActiveCommunityById(communityId: string): Promise<{ location_code: string } | null>;
}
interface ApprovalRepository {
  gameProfile: GameProfile;
  withTransaction<T>(work: (session: ApprovalSession) => Promise<T> | T): Promise<T>;
}

export async function authenticateDiscordIntegrationRequest(request: Request) {
  const context = resolveNativeBookingRequestContext(request);
  const profileHeader = request.headers.get("x-booking-profile");
  if (!context || profileHeader !== context.gameProfile) {
    throw new DiscordIntegrationAuthenticationError("profile_mismatch");
  }
  const profile = context.gameProfile;
  const secret = getBookingIntegrationSecret(profile);
  const bodyText = await request.text();
  const verified = verifyDiscordIntegrationRequest({
    profile, secret: secret ?? "", method: request.method,
    path: new URL(request.url).pathname,
    timestamp: request.headers.get("x-booking-timestamp") ?? "",
    nonce: request.headers.get("x-booking-nonce") ?? "",
    signature: request.headers.get("x-booking-signature") ?? "",
    body: bodyText,
  });
  const repository = getDiscordIntegrationRepository(profile) as IntegrationRepository | null;
  if (!repository) throw new Error("integration_database_unavailable");
  const fresh = await repository.withTransaction((session) =>
    session.consumeNonce(verified.nonce, verified.expiresAt));
  if (!fresh) throw new DiscordIntegrationAuthenticationError("replayed_request");
  let body: unknown = {};
  try { body = bodyText === "" ? {} : JSON.parse(bodyText); } catch { throw new TypeError("invalid_json"); }
  return { profile, body, repository };
}

export function discordIntegrationError(error: unknown, operation: string) {
  if (error instanceof DiscordIntegrationAuthenticationError) {
    const key = `${operation}:${error.code}`;
    if (!observedAuthenticationFailures.has(key)) {
      observedAuthenticationFailures.add(key);
      console.warn("discord_booking_integration_authentication_failed", {
        operation,
        category: String(error.code).slice(0, 40),
      });
    }
    return json({ ok: false, error: "Integration authentication failed.", code: error.code }, 401);
  }
  if (error instanceof TypeError) return json({ ok: false, error: "The request is invalid.", code: "invalid_request" }, 400);
  console.error("discord_booking_integration_failed", {
    operation, category: "internal_api",
    code: typeof error === "object" && error && "code" in error ? String(error.code).slice(0, 40) : null,
  });
  return json({ ok: false, error: "Discord integration is unavailable.", code: "unavailable" }, 503);
}

export async function handleDiscordWorkClaim(request: Request) {
  try {
    const scope = await authenticateDiscordIntegrationRequest(request);
    if (!observedClaimProfiles.has(scope.profile)) {
      observedClaimProfiles.add(scope.profile);
      console.info("discord_booking_integration_claim_authenticated", {
        profile: scope.profile,
      });
    }
    const body = scope.body as { limit?: unknown };
    const secret = getBookingIntegrationSecret(scope.profile);
    const work = await scope.repository.withTransaction((session) => session.claim(body.limit, {
      guestTokenSecret: secret,
    }));
    if (work.length > 0) {
      console.info("discord_booking_integration_work_claimed", {
        profile: scope.profile,
        workCount: work.length,
      });
    }
    return json({ ok: true, profile: scope.profile, work });
  } catch (error) { return discordIntegrationError(error, "claim"); }
}

export async function handleDiscordWorkRecipients(request: Request, workId: string) {
  try {
    if (!UUID.test(workId)) throw new TypeError("invalid_work_id");
    const scope = await authenticateDiscordIntegrationRequest(request);
    const body = scope.body as { claimToken?: unknown; recipients?: unknown };
    if (!UUID.test(String(body.claimToken ?? "")) || !Array.isArray(body.recipients)) throw new TypeError("invalid_recipients");
    const recipients = body.recipients as unknown[];
    const accepted = await scope.repository.withTransaction((session) =>
      session.registerRecipients(workId, body.claimToken, recipients));
    return accepted ? json({ ok: true }) : json({ ok: false, error: "Work claim is no longer active.", code: "stale_claim" }, 409);
  } catch (error) { return discordIntegrationError(error, "register_recipients"); }
}

export async function handleDiscordWorkOutcome(request: Request, workId: string) {
  try {
    if (!UUID.test(workId)) throw new TypeError("invalid_work_id");
    const scope = await authenticateDiscordIntegrationRequest(request);
    const body = scope.body as { claimToken?: unknown; status?: unknown; discordChannelId?: unknown; discordMessageId?: unknown };
    if (!UUID.test(String(body.claimToken ?? ""))
        || !["sent", "retry", "permanent_failure"].includes(String(body.status))) throw new TypeError("invalid_outcome");
    if (body.status === "sent" && ((body.discordChannelId != null && !SNOWFLAKE.test(String(body.discordChannelId)))
        || (body.discordMessageId != null && !SNOWFLAKE.test(String(body.discordMessageId))))) throw new TypeError("invalid_message_id");
    const accepted = await scope.repository.withTransaction((session) => session.finish(workId, body.claimToken, body));
    return accepted ? json({ ok: true }) : json({ ok: false, error: "Work claim is no longer active.", code: "stale_claim" }, 409);
  } catch (error) { return discordIntegrationError(error, "delivery_outcome"); }
}

async function authoritativeApprovalState(repository: ApprovalRepository, requestId: string) {
  return repository.withTransaction(async (session) => {
    const current = await session.findRequest(requestId);
    if (!current) return null;
    return {
      status: current.status,
      decidedByDisplayName: current.decided_by_display_name ?? null,
      communityId: current.community_id,
    };
  });
}

export async function handleDiscordApprovalAction(request: Request, requestId: string, action: string) {
  try {
    if (!UUID.test(requestId) || !["approve", "deny"].includes(action)) throw new TypeError("invalid_action");
    const scope = await authenticateDiscordIntegrationRequest(request);
    const body = scope.body as { discordUserId?: unknown; displayName?: unknown };
    const discordUserId = String(body.discordUserId ?? "");
    const displayName = String(body.displayName ?? "").trim().slice(0, 100);
    if (!SNOWFLAKE.test(discordUserId) || !displayName) throw new TypeError("invalid_actor");
    const approvalRepository = createBookingApprovalRepository(scope.profile) as ApprovalRepository | null;
    if (!approvalRepository) throw new Error("approval_database_unavailable");
    const current = await authoritativeApprovalState(approvalRepository, requestId);
    if (!current) return json({ ok: false, error: "Booking request was not found.", code: "request_not_found" }, 404);
    if (current.status !== "pending_approval") {
      return json({ ok: true, result: { outcome: `already_${current.status}`, ...current } });
    }
    const community = await approvalRepository.withTransaction((session) =>
      session.findActiveCommunityById(current.communityId));
    if (!community) return json({ ok: false, error: "Community was not found.", code: "community_not_found" }, 404);
    const managerContext = await createCommunityManagerAuthorizer({
      gameProfile: scope.profile,
      repository: approvalRepository,
      verifyDiscordGuildManager,
    }).authorize({
      gameProfile: scope.profile,
      discordUser: { id: discordUserId, globalName: displayName, username: displayName },
    }, community.location_code);
    const service = createBookingApprovalService({
      gameProfile: scope.profile,
      communityId: current.communityId,
      managerContext,
      repository: approvalRepository,
    });
    try {
      const result = action === "approve" ? await service.approve(requestId) : await service.deny(requestId);
      return json({ ok: true, result });
    } catch (error) {
      if (error instanceof BookingApprovalTransitionError && error.code === "invalid_transition") {
        const latest = await authoritativeApprovalState(approvalRepository, requestId);
        return json({ ok: true, result: { outcome: `already_${latest?.status ?? "decided"}`, ...latest } });
      }
      throw error;
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error
        && ["manager_forbidden", "manager_verification_unavailable"].includes(String(error.code))) {
      const status = String(error.code) === "manager_forbidden" ? 403 : 503;
      return json({ ok: false, error: "Manager authorization failed.", code: String(error.code) }, status);
    }
    return discordIntegrationError(error, "approval_action");
  }
}
