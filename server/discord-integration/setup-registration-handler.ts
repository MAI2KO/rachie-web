import "server-only";

import { createHash } from "node:crypto";

import { createNativeBookingRepository } from "@/server/native-booking/repository";
import { createRegistrationService } from "@/server/native-booking/registration-service-core.mjs";

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
    const alliance = String(body.allianceAbbreviation ?? "").trim().toUpperCase();
    if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(discordUserId)
        || !COMMUNITY.test(communityCode) || !guildName || !ALLIANCE.test(alliance)
        || typeof body.dryRun !== "boolean") throw new TypeError("invalid_setup");
    const repository = createNativeBookingRepository(scope.profile);
    if (!repository) throw new Error("booking_database_unavailable");
    const result = await repository.withTransaction(async (session) => {
      const community = await session.findCommunityByLocationCode(communityCode);
      if (!community || community.status !== "active") return { error: "community_not_found" };
      const linked = await session.findCommunityForDiscordGuild(guildId);
      if (linked && linked.id !== community.id) return { error: "guild_conflict" };
      if (!body.dryRun) {
        const link = await session.linkDiscordGuild({
          discordGuildId: guildId, communityId: community.id,
          discordGuildName: guildName, actorId: discordUserId,
        });
        if (link.status === "conflict") return { error: "guild_conflict" };
      }
      return {
        community: { code: community.location_code, displayName: community.display_name },
        status: body.dryRun
          ? linked ? "already linked" : "ready to link"
          : linked ? "linked and reconciled" : "linked",
        bookingsOpen: Boolean(community.bookings_open),
      };
    });
    if ("error" in result) {
      return result.error === "community_not_found"
        ? json({ ok: false, code: result.error, error: "Native booking community was not found." }, 404)
        : json({ ok: false, code: result.error, error: "Discord server is linked to another community." }, 409);
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
        community: { id: community.id },
        discordUser: { id: discordUserId },
      },
      repository,
    }).upsert(registration, idempotencyKey);
    return json({ ok: true, ...result.body }, result.status);
  } catch (error) {
    return discordIntegrationError(error, "canonical_registration");
  }
}
