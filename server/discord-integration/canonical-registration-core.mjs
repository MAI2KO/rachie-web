import { createHash } from "node:crypto";

const SNOWFLAKE = /^\d{1,20}$/;
const COMMUNITY = /^\d{1,10}$/;

export class CanonicalRegistrationContractError extends Error {
  constructor(code, status, category) {
    super(code);
    this.name = "CanonicalRegistrationContractError";
    this.code = code;
    this.status = status;
    this.category = category;
  }
}

function contractError(code, status, category) {
  throw new CanonicalRegistrationContractError(code, status, category);
}

export function canonicalRegistrationScope(body) {
  const guildId = body?.guildId == null || body.guildId === ""
    ? null : String(body.guildId);
  const discordUserId = String(body?.discordUserId ?? "");
  const communityCode = String(body?.communityCode ?? "");
  const canonicalCommunityCode = String(
    body?.canonicalCommunityCode ?? communityCode,
  );
  if (!SNOWFLAKE.test(discordUserId) || !COMMUNITY.test(communityCode)
      || (guildId !== null && !SNOWFLAKE.test(guildId))) {
    contractError("invalid_request", 400, "malformed_integration_payload");
  }
  if (!COMMUNITY.test(canonicalCommunityCode)) {
    contractError("invalid_identity_metadata", 409, "invalid_identity_metadata");
  }
  if (canonicalCommunityCode !== communityCode) {
    contractError("community_mismatch", 409, "community_mismatch");
  }
  if (typeof body?.isPrimary !== "boolean") {
    contractError("invalid_request", 400, "malformed_integration_payload");
  }
  return Object.freeze({ guildId, discordUserId, communityCode });
}

export async function resolveCanonicalRegistrationCommunity({ session, scope }) {
  const community = await session.findCommunityByLocationCode(scope.communityCode);
  if (!community) {
    return Object.freeze({ community: null, sourceGuildId: null,
      sourceGuildRelation: "outside_booking_scope" });
  }
  if (community.status !== "active") {
    contractError("unresolved_community", 409, "unresolved_community");
  }
  let sourceGuildId = null;
  let sourceGuildRelation = scope.guildId ? "unlinked" : "not_supplied";
  if (scope.guildId) {
    const guildCommunity = await session.findCommunityForDiscordGuild(scope.guildId);
    if (guildCommunity?.status === "active" && guildCommunity.id === community.id) {
      sourceGuildId = scope.guildId;
      sourceGuildRelation = "matching";
    } else if (guildCommunity) {
      sourceGuildRelation = "stale_or_different_community";
    }
  }
  return Object.freeze({ community, sourceGuildId, sourceGuildRelation });
}

export function canonicalRegistrationIdempotencyKey({
  profile, discordUserId, communityCode, registration, isPrimary,
}) {
  return createHash("sha256").update(JSON.stringify({
    profile, discordUserId, communityCode, registration, isPrimary,
  })).digest("hex");
}
