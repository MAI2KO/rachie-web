import { createHash, randomUUID } from "node:crypto";

import { validateRegistrationInput } from "./registration-validation.mjs";

const PROFILES = new Set(["wos", "kingshot"]);
const DISCORD_USER_ID = /^\d{1,20}$/;
const COMMUNITY_CODE = /^\d{1,10}$/;
const MAX_OWNER_ACCOUNTS = 100;

function normalizedAccounts(gameProfile, input) {
  if (!PROFILES.has(gameProfile) || !Array.isArray(input) || input.length < 1
      || input.length > MAX_OWNER_ACCOUNTS) throw new TypeError("invalid_reconciliation_accounts");
  const accounts = input.map((value) => {
    const discordUserId = String(value?.discordUserId ?? "");
    const communityCode = String(value?.communityCode ?? "");
    if (!DISCORD_USER_ID.test(discordUserId) || !COMMUNITY_CODE.test(communityCode)
        || typeof value?.isPrimary !== "boolean") {
      throw new TypeError("invalid_reconciliation_account");
    }
    const registration = validateRegistrationInput({
      playerId: value.playerId,
      inGameName: value.inGameName,
      alliance: value.allianceAbbreviation,
    });
    return Object.freeze({
      gameProfile, discordUserId, communityCode,
      playerId: registration.playerId,
      inGameName: registration.inGameName,
      alliance: registration.alliance,
      isPrimary: value.isPrimary,
    });
  });
  if (new Set(accounts.map((account) => account.discordUserId)).size !== 1
      || new Set(accounts.map((account) => account.playerId)).size !== accounts.length) {
    throw new TypeError("invalid_reconciliation_owner_group");
  }
  return accounts;
}

function stableKey(gameProfile, discordUserId, playerId) {
  return `player_mirror_reconcile:${createHash("sha256")
    .update(`${gameProfile}\0${discordUserId}\0${playerId}`, "utf8").digest("hex")}`;
}

function accountReport(account, status, communities, plannedAction) {
  return Object.freeze({
    profile: account.gameProfile,
    discordUserId: account.discordUserId,
    playerId: account.playerId,
    botIsPrimary: account.isPrimary,
    websiteMirrorStatus: status,
    communities: Object.freeze([...new Set(communities)].sort()),
    plannedAction,
  });
}

function conflictedReports(accounts, mirrors, status, reason) {
  return accounts.map((account) => accountReport(
    account,
    status(account),
    (mirrors.get(account.playerId) ?? []).map((row) => row.location_code),
    `skip: ${reason}`,
  ));
}

export async function reconcileAuthoritativePlayerMirrors({
  gameProfile, accounts: input, dryRun, repository, createId = randomUUID,
}) {
  if (repository.gameProfile !== gameProfile || typeof dryRun !== "boolean") {
    throw new TypeError("player mirror reconciliation scope mismatch");
  }
  const accounts = normalizedAccounts(gameProfile, input);
  const discordUserId = accounts[0].discordUserId;
  const authoritativePrimaries = accounts.filter((account) => account.isPrimary);

  return repository.withTransaction(async (session) => {
    if (!dryRun) await session.lockAuthoritativePrimaryOwner(discordUserId);
    const communities = new Map();
    for (const account of accounts) {
      communities.set(account.playerId,
        await session.findCommunityByLocationCode(account.communityCode));
    }
    if (!dryRun) {
      const activeCommunities = [...new Set(accounts.map((account) =>
        communities.get(account.playerId)).filter((community) => community?.status === "active")
        .map((community) => community.id))].sort();
      for (const communityId of activeCommunities) {
        await session.lockParticipantRegistrationOwner(communityId, discordUserId);
      }
      for (const account of [...accounts].sort((left, right) => {
        const communityOrder = communities.get(left.playerId)?.id
          .localeCompare(communities.get(right.playerId)?.id ?? "") ?? 0;
        return communityOrder || left.playerId.localeCompare(right.playerId);
      })) {
        const community = communities.get(account.playerId);
        if (community?.status === "active") {
          await session.lockRegisteredPlayerIdentity(community.id, account.playerId);
        }
      }
    }
    const playerIds = accounts.map((account) => account.playerId);
    const mirrorRows = dryRun
      ? await session.listActiveParticipantMirrorsForPlayerIds(playerIds)
      : await session.lockActiveParticipantMirrorsForPlayerIds(playerIds);
    const ownerRows = dryRun
      ? await session.listActiveParticipantMirrorsForOwner(discordUserId)
      : await session.lockActiveParticipantMirrorsForOwner(discordUserId);
    const ownershipRows = dryRun
      ? await session.listParticipantOwnershipForPlayerIds(playerIds)
      : await session.lockParticipantOwnershipForPlayerIds(playerIds);
    const mirrors = new Map(playerIds.map((playerId) => [playerId,
      mirrorRows.filter((row) => row.player_id === playerId)]));

    if (authoritativePrimaries.length > 1) {
      return Object.freeze({ conflict: "multiple_authoritative_primaries", mutations: 0,
        results: conflictedReports(accounts, mirrors, () => "ambiguous/conflict",
          "multiple authoritative bot primaries") });
    }
    const unresolved = accounts.filter((account) => {
      const community = communities.get(account.playerId);
      return !community || community.status !== "active";
    });
    if (unresolved.length) {
      const unresolvedIds = new Set(unresolved.map((account) => account.playerId));
      return Object.freeze({ conflict: "community_unresolved", mutations: 0,
        results: conflictedReports(accounts, mirrors,
          (account) => unresolvedIds.has(account.playerId) ? "missing" : "ambiguous/conflict",
          "owner group contains an unresolved community") });
    }
    const ownership = accounts.filter((account) =>
      ownershipRows.filter((row) => row.player_id === account.playerId).some(
        (row) => row.discord_user_id !== discordUserId));
    if (ownership.length) {
      const ids = new Set(ownership.map((account) => account.playerId));
      return Object.freeze({ conflict: "ownership_mismatch", mutations: 0,
        results: conflictedReports(accounts, mirrors,
          (account) => ids.has(account.playerId) ? "ownership mismatch" : "ambiguous/conflict",
          "website ownership mismatch") });
    }
    const ambiguous = accounts.filter((account) => {
      const counts = new Map();
      for (const row of mirrors.get(account.playerId) ?? []) {
        counts.set(row.community_id, (counts.get(row.community_id) ?? 0) + 1);
      }
      return [...counts.values()].some((count) => count > 1);
    });
    if (ambiguous.length) {
      return Object.freeze({ conflict: "ambiguous_website_identity", mutations: 0,
        results: conflictedReports(accounts, mirrors, () => "ambiguous/conflict",
          "ambiguous website identity") });
    }

    const primaryPlayerId = authoritativePrimaries[0]?.playerId ?? null;
    const plans = accounts.map((account) => {
      const rows = mirrors.get(account.playerId) ?? [];
      const community = communities.get(account.playerId);
      const missing = !rows.some((row) => row.community_id === community.id);
      const metadataRows = rows.filter((row) => row.in_game_name !== account.inGameName
        || row.alliance !== account.alliance);
      const primaryMismatch = rows.some((row) => row.is_primary !== account.isPrimary)
        || (missing && account.isPrimary)
        || ownerRows.some((row) => row.player_id === account.playerId
          && row.is_primary !== account.isPrimary);
      const actions = [];
      if (missing) actions.push(`create mirror for ${account.communityCode}`);
      if (metadataRows.length) actions.push(`update ${metadataRows.length} mirror(s)`);
      if (primaryMismatch) actions.push("synchronize primary");
      const status = missing ? "missing" : primaryMismatch ? "primary mismatch"
        : "matching";
      return { account, rows, community, missing, metadataRows, primaryMismatch,
        report: accountReport(account, status, rows.map((row) => row.location_code),
          actions.length ? actions.join("; ") : "none") };
    });
    const plannedCreates = plans.filter((plan) => plan.missing).length;
    const plannedUpdates = new Set(plans.flatMap((plan) => [
      ...plan.metadataRows.map((row) => row.id),
      ...ownerRows.filter((row) => row.is_primary !== (row.player_id === primaryPlayerId))
        .map((row) => row.id),
    ])).size;

    if (dryRun) {
      return Object.freeze({ conflict: null, mutations: 0,
        plannedCreates, plannedUpdates,
        results: plans.map((plan) => plan.report) });
    }

    let created = 0;
    let metadataUpdated = 0;
    for (const plan of plans) {
      if (plan.missing) {
        const idempotencyKey = stableKey(gameProfile, discordUserId, plan.account.playerId);
        const requestHash = createHash("sha256").update(JSON.stringify(plan.account)).digest("hex");
        await session.insertPlayerMirrorReconciliationKey({
          communityId: plan.community.id, idempotencyKey, requestHash,
          correlationId: `player-mirror:${createId()}`,
        });
        await session.insertReconciledParticipant({
          id: createId(), communityId: plan.community.id, discordUserId,
          playerId: plan.account.playerId, inGameName: plan.account.inGameName,
          alliance: plan.account.alliance, idempotencyKey,
          correlationId: `player-mirror:${createId()}`,
        });
        created += 1;
      }
      for (const row of plan.metadataRows) {
        metadataUpdated += await session.updateReconciledParticipant({
          id: row.id, discordUserId, inGameName: plan.account.inGameName,
          alliance: plan.account.alliance,
        });
      }
    }
    const primaryUpdated = await session.synchronizeReconciledOwnerPrimary(
      discordUserId, primaryPlayerId,
    );
    return Object.freeze({ conflict: null, mutations: created + metadataUpdated + primaryUpdated,
      plannedCreates, plannedUpdates,
      created, updated: metadataUpdated + primaryUpdated,
      results: plans.map((plan) => plan.report) });
  });
}
