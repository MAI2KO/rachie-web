import "server-only";

import { createHash } from "node:crypto";

import { createNativeBookingRepository } from "@/server/native-booking/repository";
import {
  createRegistrationService,
  deactivateAuthoritativeParticipantMirrors,
  RegistrationOwnershipAmbiguousError,
  RegistrationOwnershipMismatchError,
  synchronizeAuthoritativePrimary,
  synchronizeOutOfScopePrimaryProjection,
} from "@/server/native-booking/registration-service-core.mjs";
import {
  InvalidRegistrationError,
  validateRegistrationInput,
} from "@/server/native-booking/registration-validation.mjs";

import { createDiscordCommunitySetupService } from "./community-setup-service-core.mjs";
import {
  canonicalRegistrationScope,
  canonicalRegistrationIdempotencyKey,
  CanonicalRegistrationContractError,
  resolveCanonicalRegistrationCommunity,
} from "./canonical-registration-core.mjs";

import {
  authenticateDiscordIntegrationRequest,
  discordIntegrationError,
} from "./route-handler";

const SNOWFLAKE = /^\d{1,20}$/;
const COMMUNITY = /^\d{1,10}$/;
const ALLIANCE = /^[A-Z0-9]{3}$/;
const responseHeaders = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: responseHeaders });

function text(value: unknown, maximum: number) {
  const normalized = typeof value === "string" ? value.trim().normalize("NFC") : "";
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized : null;
}

export async function handleDiscordCommunitySetup(request: Request) {
  try {
    const scope = await authenticateDiscordIntegrationRequest(request);
    const body = scope.body as Record<string, unknown>;
    const guildId = String(body.guildId ?? "");
    const discordUserId = String(body.discordUserId ?? "");
    const communityCode = String(body.communityCode ?? "");
    const guildName = text(body.guildName, 100);
    const guildKind = body.guildKind === "state" || body.guildKind === "alliance"
      ? body.guildKind : null;
    const alliance = String(body.allianceAbbreviation ?? "").trim().toUpperCase();
    if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(discordUserId)
        || !COMMUNITY.test(communityCode) || !guildName || !guildKind
        || (guildKind === "alliance" ? !ALLIANCE.test(alliance) : alliance !== "")
        || typeof body.dryRun !== "boolean") throw new TypeError("invalid_setup");
    const repository = createNativeBookingRepository(scope.profile);
    if (!repository) throw new Error("booking_database_unavailable");
    const result = await createDiscordCommunitySetupService({
      gameProfile: scope.profile,
      repository,
    }).reconcile({
      communityCode,
      guildId,
      guildName,
      guildKind, alliance: guildKind === "alliance" ? alliance : null,
      actorId: discordUserId,
      dryRun: body.dryRun,
    });
    if ("error" in result) {
      if (result.error === "kingshot_defaults_unavailable") {
        return json({ ok: false, code: result.error,
          error: "Automatic Kingshot booking-cycle defaults are not configured yet." }, 409);
      }
      const message = result.error === "state_guild_already_configured"
        ? `This community already has a shared ${scope.profile === "wos" ? "State" : "Kingdom"} Discord. Platform approval is required to replace it.`
        : result.error === "community_claim_conflict"
        ? "That community is already linked. Platform approval is required before adding another Discord server."
        : result.error === "community_inactive" ? "Native booking community is inactive."
          : result.error === "guild_kind_conflict" || result.error === "guild_request_kind_conflict"
            ? "Discord server is already linked or pending with a different topology type."
            : "Discord server is linked to another community.";
      return json({ ok: false, code: result.error, error: message }, 409);
    }
    return json({ ok: true, ...result });
  } catch (error) {
    return discordIntegrationError(error, "community_setup");
  }
}

export async function handleDiscordCanonicalRegistration(request: Request) {
  let diagnosticBody: Record<string, unknown> = {};
  let diagnosticProfile = "unknown";
  try {
    const scope = await authenticateDiscordIntegrationRequest(request);
    diagnosticProfile = scope.profile;
    const body = scope.body as Record<string, unknown>;
    diagnosticBody = body;
    const discordUserId = String(body.discordUserId ?? "");
    const repository = createNativeBookingRepository(scope.profile);
    if (!repository) throw new Error("booking_database_unavailable");
    if (body.deactivateSyncOnly === true && body.primarySyncOnly === true) {
      throw new CanonicalRegistrationContractError(
        "invalid_request", 400, "malformed_integration_payload",
      );
    }
    if (body.deactivateSyncOnly === true) {
      if (!SNOWFLAKE.test(discordUserId)) {
        throw new CanonicalRegistrationContractError(
          "invalid_request", 400, "malformed_integration_payload",
        );
      }
      const deactivation = await deactivateAuthoritativeParticipantMirrors({
        gameProfile: scope.profile, discordUserId, playerId: body.playerId, repository,
      });
      return json({ ok: true, outcome: "participant_mirrors_deactivated", deactivation });
    }
    if (body.primarySyncOnly === true) {
      if (!SNOWFLAKE.test(discordUserId) || typeof body.isPrimary !== "boolean"
          || body.isPrimary !== true) {
        throw new CanonicalRegistrationContractError(
          "invalid_request", 400, "malformed_integration_payload",
        );
      }
      let outsideBookingScope = false;
      if (body.communityCode !== undefined) {
        const primaryScope = canonicalRegistrationScope({ ...body, guildId: null });
        const resolution = await repository.withTransaction((session) =>
          resolveCanonicalRegistrationCommunity({ session, scope: primaryScope }));
        outsideBookingScope = resolution.community === null;
      }
      const primary = outsideBookingScope
        ? await synchronizeOutOfScopePrimaryProjection({ gameProfile: scope.profile,
          discordUserId, playerId: body.playerId, isPrimary: true, repository })
        : await synchronizeAuthoritativePrimary({
          gameProfile: scope.profile, discordUserId, playerId: body.playerId, repository,
        });
      if (outsideBookingScope) {
        return json({ ok: true, outcome: "outside_booking_scope", primary });
      }
      return json({ ok: true, outcome: "primary_synchronized", primary });
    }
    const registrationScope = canonicalRegistrationScope(body);
    const registration = validateRegistrationInput({
      playerId: body.playerId,
      inGameName: body.inGameName,
      alliance: body.allianceAbbreviation,
    });
    const resolution = await repository.withTransaction((session) =>
      resolveCanonicalRegistrationCommunity({ session, scope: registrationScope }));
    const community = resolution.community;
    if (!community) {
      const primary = await synchronizeOutOfScopePrimaryProjection({
        gameProfile: scope.profile, discordUserId, playerId: registration.playerId,
        isPrimary: body.isPrimary, repository,
      });
      return json({ ok: true, outcome: "outside_booking_scope", primary,
        sync: { sourceGuildRelation: resolution.sourceGuildRelation } });
    }
    const idempotencyKey = canonicalRegistrationIdempotencyKey({
      profile: scope.profile, discordUserId,
      communityCode: registrationScope.communityCode, registration,
      isPrimary: body.isPrimary,
    });
    const result = await createRegistrationService({
      context: {
        gameProfile: scope.profile,
        community: { id: community.id, discordGuildId: resolution.sourceGuildId },
        discordUser: { id: discordUserId },
      },
      repository,
    }).upsert(registration, idempotencyKey, {
      isPrimary: typeof body.isPrimary === "boolean" ? body.isPrimary : undefined,
    });
    return json({ ok: true, ...result.body,
      sync: { sourceGuildRelation: resolution.sourceGuildRelation } }, result.status);
  } catch (error) {
    const controlled = error instanceof CanonicalRegistrationContractError
      ? error
      : error instanceof InvalidRegistrationError
        ? new CanonicalRegistrationContractError(
          "invalid_identity_metadata", 409, "invalid_identity_metadata",
        )
        : error instanceof RegistrationOwnershipMismatchError
          ? new CanonicalRegistrationContractError(
            "ownership_mismatch", 409, "ownership_mismatch",
          )
          : error instanceof RegistrationOwnershipAmbiguousError
            ? new CanonicalRegistrationContractError(
              "stale_mirror_relationship", 409, "stale_mirror_relationship",
            ) : null;
    if (controlled) {
      const ownerRef = createHash("sha256").update(
        `${diagnosticProfile}\0owner\0${String(diagnosticBody.discordUserId ?? "missing")}`,
      ).digest("hex").slice(0, 16);
      const accountRef = createHash("sha256").update(
        `${diagnosticProfile}\0account\0${String(diagnosticBody.discordUserId ?? "missing")}\0${String(diagnosticBody.playerId ?? "missing")}`,
      ).digest("hex").slice(0, 16);
      console.warn("canonical_registration_sync_refused", {
        profile: diagnosticProfile, category: controlled.category, ownerRef, accountRef,
      });
      return json({ ok: false, code: controlled.code,
        error: "Canonical registration could not be synchronized.",
        diagnostic: { category: controlled.category, ownerRef, accountRef } }, controlled.status);
    }
    return discordIntegrationError(error, "canonical_registration");
  }
}
