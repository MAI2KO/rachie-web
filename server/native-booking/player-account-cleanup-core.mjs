import {
  classifyPlayerBookingScope,
} from "./player-booking-scope.mjs";

const PROFILES = new Set(["wos", "kingshot"]);
const ACCOUNT_REF = /^[a-f0-9]{16}$/;
const OWNER_REF = /^[a-f0-9]{16}$/;
const PLAYER_ID = /^\d{1,32}$/;
const DISCORD_USER_ID = /^\d{1,32}$/;
const COMMUNITY_CODE = /^\d{1,10}$/;
const REASONS = new Set(["invalid_location", "invalid_in_game_name", "invalid_alliance",
  "invalid_owner"]);

function normalizeCandidates(gameProfile, input) {
  if (!PROFILES.has(gameProfile) || !Array.isArray(input) || input.length < 1
      || input.length > 100) throw new TypeError("invalid_cleanup_candidates");
  const candidates = input.map((value) => {
    const accountRef = String(value?.accountRef ?? "");
    const ownerRef = String(value?.ownerRef ?? "");
    const playerId = String(value?.playerId ?? "");
    const discordUserId = value?.discordUserId == null ? null : String(value.discordUserId);
    const rawCommunityCode = String(value?.stateOrKingdomNumber ?? "");
    const communityCode = COMMUNITY_CODE.test(rawCommunityCode) ? rawCommunityCode : null;
    const botIsPrimary = value?.botIsPrimary;
    const reasons = [...new Set(Array.isArray(value?.reasons) ? value.reasons : [])].sort();
    if (!ACCOUNT_REF.test(accountRef) || !OWNER_REF.test(ownerRef) || !PLAYER_ID.test(playerId)
        || (discordUserId !== null && !DISCORD_USER_ID.test(discordUserId))
        || typeof botIsPrimary !== "boolean"
        || reasons.length < 1 || reasons.some((reason) => !REASONS.has(reason))) {
      throw new TypeError("invalid_cleanup_candidate");
    }
    return Object.freeze({ accountRef, ownerRef, playerId, discordUserId,
      communityCode, botIsPrimary, reasons });
  });
  if (new Set(candidates.map((candidate) => candidate.accountRef)).size !== candidates.length) {
    throw new TypeError("duplicate_cleanup_candidate");
  }
  return candidates;
}

function report(candidate, rows, community, mutations = 0) {
  const active = rows.filter((row) => row.status === "active");
  const ownerConflict = candidate.discordUserId === null
    ? active.length > 0
    : active.some((row) => row.discord_user_id !== candidate.discordUserId);
  const bookingReferences = rows.reduce((total, row) => total + Number(row.booking_count), 0);
  const approvalReferences = rows.reduce((total, row) => total + Number(row.approval_count), 0);
  const pointsReferences = rows.reduce((total, row) => total + Number(row.points_count), 0);
  return Object.freeze({
    accountRef: candidate.accountRef,
    ownerRef: candidate.ownerRef,
    stateOrKingdomNumber: candidate.communityCode,
    botIsPrimary: candidate.botIsPrimary,
    reasons: Object.freeze(candidate.reasons),
    bookingScope: classifyPlayerBookingScope({
      communityCode: candidate.communityCode,
      community,
      activeMirrorCount: active.length,
    }),
    participantMirrors: rows.length,
    activeParticipantMirrors: active.length,
    inactiveParticipantMirrors: rows.length - active.length,
    bookingReferences,
    historyReferences: bookingReferences + approvalReferences + pointsReferences
      + rows.filter((row) => row.status === "inactive").length,
    cleanupStatus: ownerConflict ? "ownership_conflict"
      : mutations > 0 ? "deactivated"
        : rows.length > 0 && active.length === 0 ? "already_completed" : "safe_noop",
    mutations,
  });
}

export async function inspectOrDeactivateLegacyPlayerAccounts({
  gameProfile, candidates: input, dryRun, repository,
}) {
  if (repository.gameProfile !== gameProfile || typeof dryRun !== "boolean") {
    throw new TypeError("player cleanup scope mismatch");
  }
  const candidates = normalizeCandidates(gameProfile, input);
  if (!dryRun && candidates.length !== 1) throw new TypeError("cleanup_execute_requires_one");
  return repository.withTransaction(async (session) => {
    const playerIds = candidates.map((candidate) => candidate.playerId);
    const rows = dryRun
      ? await session.listLegacyPlayerCleanupFootprints(playerIds)
      : await session.lockLegacyPlayerCleanupFootprints(playerIds);
    const results = [];
    for (const candidate of candidates) {
      const footprint = rows.filter((row) => row.player_id === candidate.playerId);
      const community = candidate.communityCode === null ? null
        : await session.findCommunityByLocationCode(candidate.communityCode);
      const preview = report(candidate, footprint, community);
      if (dryRun || preview.cleanupStatus !== "safe_noop") {
        results.push(preview);
        continue;
      }
      const mutations = await session.deactivateLegacyPlayerParticipants(
        candidate.discordUserId, candidate.playerId,
      );
      results.push(report(candidate, footprint, community, mutations));
    }
    return Object.freeze({ mutations: results.reduce((sum, result) => sum + result.mutations, 0),
      results: Object.freeze(results) });
  });
}
