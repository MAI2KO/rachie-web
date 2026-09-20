import assert from "node:assert/strict";
import test from "node:test";

import { inspectOrDeactivateLegacyPlayerAccounts } from "../server/native-booking/player-account-cleanup-core.mjs";

function repositoryFixture(rows = [], { gameProfile = "wos", communities = new Map() } = {}) {
  const state = structuredClone(rows);
  return { gameProfile, state, async withTransaction(work) { return work({
    async findCommunityByLocationCode(code) { return communities.get(code) ?? null; },
    async listLegacyPlayerCleanupFootprints() { return structuredClone(state); },
    async lockLegacyPlayerCleanupFootprints() { return structuredClone(state); },
    async deactivateLegacyPlayerParticipants(owner, playerId) {
      let count = 0;
      for (const row of state) if (row.discord_user_id === owner && row.player_id === playerId
          && row.status === "active") { row.status = "inactive"; count += 1; }
      return count;
    },
  }); } };
}

const candidate = { accountRef: "0123456789abcdef", playerId: "12345",
  ownerRef: "fedcba9876543210", discordUserId: "67890", stateOrKingdomNumber: "1001",
  botIsPrimary: true, reasons: ["invalid_in_game_name", "invalid_alliance"] };

test("cleanup preview reports website footprint without mutation or private identity", async () => {
  const repository = repositoryFixture([{ id: "participant", player_id: "12345",
    discord_user_id: "67890", status: "active", booking_count: 2, approval_count: 1,
    points_count: 3 }], { communities: new Map([["1001",
      { id: "community-one", location_code: "1001", status: "active" }]]) });
  const before = structuredClone(repository.state);
  const result = await inspectOrDeactivateLegacyPlayerAccounts({ gameProfile: "wos",
    candidates: [candidate], dryRun: true, repository });
  assert.deepEqual(result.results[0], { accountRef: candidate.accountRef,
    ownerRef: candidate.ownerRef, stateOrKingdomNumber: "1001", botIsPrimary: true,
    reasons: ["invalid_alliance", "invalid_in_game_name"],
    bookingScope: "configured_active",
    participantMirrors: 1, activeParticipantMirrors: 1,
    inactiveParticipantMirrors: 0, bookingReferences: 2, historyReferences: 6,
    cleanupStatus: "safe_noop", mutations: 0 });
  assert.equal("playerId" in result.results[0], false);
  assert.equal("discordUserId" in result.results[0], false);
  assert.deepEqual(repository.state, before);
});

test("preview distinguishes outside, inactive, stale, and unknown booking scope", async () => {
  const candidates = [
    { ...candidate, accountRef: "0000000000000001", playerId: "1",
      stateOrKingdomNumber: "2001" },
    { ...candidate, accountRef: "0000000000000002", playerId: "2",
      stateOrKingdomNumber: "2002" },
    { ...candidate, accountRef: "0000000000000003", playerId: "3",
      stateOrKingdomNumber: "2003" },
    { ...candidate, accountRef: "0000000000000004", playerId: "4",
      stateOrKingdomNumber: null, reasons: ["invalid_location"] },
  ];
  const repository = repositoryFixture([
    { id: "stale", player_id: "3", discord_user_id: "67890", status: "active",
      booking_count: 0, approval_count: 0, points_count: 0 },
  ], { communities: new Map([["2002",
    { id: "inactive", location_code: "2002", status: "archived" }]]) });
  const result = await inspectOrDeactivateLegacyPlayerAccounts({ gameProfile: "wos",
    candidates, dryRun: true, repository });
  assert.deepEqual(result.results.map((item) => item.bookingScope), [
    "outside_booking_scope", "inactive_community", "stale_mirror_relationship",
    "unknown/other",
  ]);
  assert.equal(result.mutations, 0);
});

test("booking-scope lookup remains isolated to the injected game profile", async () => {
  const wos = repositoryFixture([], { gameProfile: "wos", communities: new Map() });
  const kingshot = repositoryFixture([], { gameProfile: "kingshot", communities: new Map([
    ["1001", { id: "kingdom", location_code: "1001", status: "active" }],
  ]) });
  const wosResult = await inspectOrDeactivateLegacyPlayerAccounts({ gameProfile: "wos",
    candidates: [candidate], dryRun: true, repository: wos });
  const kingshotResult = await inspectOrDeactivateLegacyPlayerAccounts({
    gameProfile: "kingshot", candidates: [candidate], dryRun: true,
    repository: kingshot,
  });
  assert.equal(wosResult.results[0].bookingScope, "outside_booking_scope");
  assert.equal(kingshotResult.results[0].bookingScope, "configured_active");
});

test("cleanup deactivates matching mirrors but preserves footprint and rejects ownership ambiguity", async () => {
  const rows = [{ id: "participant", player_id: "12345", discord_user_id: "67890",
    status: "active", booking_count: 2, approval_count: 1, points_count: 3 }];
  const repository = repositoryFixture(rows);
  const result = await inspectOrDeactivateLegacyPlayerAccounts({ gameProfile: "wos",
    candidates: [candidate], dryRun: false, repository });
  assert.equal(result.mutations, 1);
  assert.equal(result.results[0].cleanupStatus, "deactivated");
  assert.equal(repository.state[0].status, "inactive");
  assert.equal(repository.state[0].booking_count, 2);

  const conflictRepository = repositoryFixture([{ ...rows[0], discord_user_id: "99999" }]);
  const conflict = await inspectOrDeactivateLegacyPlayerAccounts({ gameProfile: "wos",
    candidates: [candidate], dryRun: false, repository: conflictRepository });
  assert.equal(conflict.results[0].cleanupStatus, "ownership_conflict");
  assert.equal(conflict.mutations, 0);
  assert.equal(conflictRepository.state[0].status, "active");
});

test("ownerless cleanup is a no-op without an active website identity and conflicts otherwise", async () => {
  const ownerless = { ...candidate, discordUserId: null, reasons: ["invalid_owner"] };
  const empty = repositoryFixture();
  const safe = await inspectOrDeactivateLegacyPlayerAccounts({ gameProfile: "wos",
    candidates: [ownerless], dryRun: false, repository: empty });
  assert.equal(safe.results[0].cleanupStatus, "safe_noop");
  const active = repositoryFixture([{ id: "participant", player_id: "12345",
    discord_user_id: "67890", status: "active", booking_count: 0, approval_count: 0,
    points_count: 0 }]);
  const conflict = await inspectOrDeactivateLegacyPlayerAccounts({ gameProfile: "wos",
    candidates: [ownerless], dryRun: false, repository: active });
  assert.equal(conflict.results[0].cleanupStatus, "ownership_conflict");
  assert.equal(active.state[0].status, "active");
});

test("repeated cleanup reports already completed and never touches an unrelated participant", async () => {
  const repository = repositoryFixture([
    { id: "target", player_id: "12345", discord_user_id: "67890", status: "inactive",
      booking_count: 2, approval_count: 1, points_count: 3 },
    { id: "unrelated", player_id: "99999", discord_user_id: "67890", status: "active",
      booking_count: 0, approval_count: 0, points_count: 0 },
  ]);
  const before = structuredClone(repository.state);
  const repeated = await inspectOrDeactivateLegacyPlayerAccounts({ gameProfile: "wos",
    candidates: [candidate], dryRun: false, repository });
  assert.equal(repeated.results[0].cleanupStatus, "already_completed");
  assert.equal(repeated.mutations, 0);
  assert.deepEqual(repository.state, before);
});
