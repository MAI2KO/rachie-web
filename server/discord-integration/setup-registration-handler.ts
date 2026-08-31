import "server-only";

import { createHash } from "node:crypto";

import { createNativeBookingRepository } from "@/server/native-booking/repository";
import { createRegistrationService } from "@/server/native-booking/registration-service-core.mjs";

import { createDiscordCommunitySetupService } from "./community-setup-service-core.mjs";

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
  try {
    const scope = await authenticateDiscordIntegrationRequest(request);
    const body = scope.body as Record<string, unknown>;
    const guildId = String(body.guildId ?? "");
    const discordUserId = String(body.discordUserId ?? "");
    const communityCode = String(body.communityCode ?? "");
    if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(discordUserId)
        || !COMMUNITY.test(communityCode)) throw new TypeError("invalid_registration_scope");
    const repository = createNativeBookingRepository(scope.profile);
    if (!repository) throw new Error("booking_database_unavailable");
    const community = await repository.withTransaction((session) =>
      session.findCommunityForDiscordGuild(guildId));
    if (!community || community.location_code !== communityCode || community.status !== "active") {
      return json({ ok: false, code: "community_mismatch", error: "Registration does not match this Discord community." }, 409);
    }
    const registration = {
      playerId: body.playerId,
      inGameName: body.inGameName,
      alliance: body.allianceAbbreviation,
    };
    const idempotencyKey = createHash("sha256").update(JSON.stringify({
      profile: scope.profile, guildId, discordUserId, communityCode, registration,
    })).digest("hex");
    const result = await createRegistrationService({
      context: {
        gameProfile: scope.profile,
        community: { id: community.id, discordGuildId: guildId },
        discordUser: { id: discordUserId },
      },
      repository,
    }).upsert(registration, idempotencyKey);
    return json({ ok: true, ...result.body }, result.status);
  } catch (error) {
    return discordIntegrationError(error, "canonical_registration");
  }
}
