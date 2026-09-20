import assert from "node:assert/strict";
import test from "node:test";

import { reconcileAuthoritativePlayerMirrors } from "../server/native-booking/player-mirror-reconciliation-core.mjs";

function account(playerId, overrides = {}) {
  return { discordUserId: "1234567", playerId, inGameName: `Player ${playerId}`,
    allianceAbbreviation: "TAG", communityCode: "1001", isPrimary: false, ...overrides };
}

function repositoryFixture({ participants = [], communities = null, gameProfile = "wos" } = {}) {
  const state = { participants: structuredClone(participants), keys: [], writes: 0,
    points: [], communityPoints: [], bookings: [], events: [], notifications: [], topology: [] };
  const locations = communities ?? new Map([
    ["1001", { id: "community-one", location_code: "1001", status: "active" }],
    ["1002", { id: "community-two", location_code: "1002", status: "active" }],
  ]);
  let nextId = 0;
  function rowsForPlayers(playerIds) {
    return state.participants.filter((row) => playerIds.includes(row.player_id))
      .map((row) => ({ ...row, location_code: row.location_code
        ?? [...locations.values()].find((community) => community.id === row.community_id)?.location_code }));
  }
  return { gameProfile, state, locations, nextId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    async withTransaction(work) {
      return work({
        async lockAuthoritativePrimaryOwner() {},
        async lockParticipantRegistrationOwner() {},
        async findCommunityByLocationCode(code) { return locations.get(code) ?? null; },
        async lockRegisteredPlayerIdentity() {},
        async listActiveParticipantMirrorsForPlayerIds(ids) { return rowsForPlayers(ids); },
        async lockActiveParticipantMirrorsForPlayerIds(ids) { return rowsForPlayers(ids); },
        async listActiveParticipantMirrorsForOwner(owner) {
          return state.participants.filter((row) => row.discord_user_id === owner);
        },
        async lockActiveParticipantMirrorsForOwner(owner) {
          return state.participants.filter((row) => row.discord_user_id === owner);
        },
        async listParticipantOwnershipForPlayerIds(ids) {
          return state.participants.filter((row) => ids.includes(row.player_id));
        },
        async lockParticipantOwnershipForPlayerIds(ids) {
          return state.participants.filter((row) => ids.includes(row.player_id));
        },
        async insertPlayerMirrorReconciliationKey(value) {
          state.keys.push(value); state.writes += 1;
        },
        async insertReconciledParticipant(value) {
          state.participants.push({ id: value.id, community_id: value.communityId,
            discord_user_id: value.discordUserId, player_id: value.playerId,
            in_game_name: value.inGameName, alliance: value.alliance,
            is_primary: false, location_code: "1001" });
          state.writes += 1;
        },
        async updateReconciledParticipant(value) {
          const row = state.participants.find((item) => item.id === value.id);
          if (!row || (row.in_game_name === value.inGameName && row.alliance === value.alliance)) return 0;
          row.in_game_name = value.inGameName; row.alliance = value.alliance;
          state.writes += 1; return 1;
        },
        async synchronizeReconciledOwnerPrimary(owner, primaryPlayerId) {
          let count = 0;
          for (const row of state.participants.filter((item) => item.discord_user_id === owner)) {
            const expected = row.player_id === primaryPlayerId;
            if (row.is_primary !== expected) { row.is_primary = expected; count += 1; state.writes += 1; }
          }
          return count;
        },
      });
    } };
}

test("dry-run reports missing and primary changes without any mutation", async () => {
  const repository = repositoryFixture({ participants: [
    { id: "main-one", community_id: "community-one", discord_user_id: "1234567",
      player_id: "111111", in_game_name: "Old", alliance: "OLD", is_primary: false },
    { id: "main-two", community_id: "community-two", discord_user_id: "1234567",
      player_id: "111111", in_game_name: "Old", alliance: "OLD", is_primary: false },
    { id: "alt", community_id: "community-one", discord_user_id: "1234567",
      player_id: "222222", in_game_name: "Player 222222", alliance: "TAG", is_primary: true },
  ] });
  const before = structuredClone(repository.state);
  const result = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: true,
    repository, accounts: [account("111111", { isPrimary: true }), account("222222"),
      account("333333")], createId: repository.nextId });
  assert.equal(result.mutations, 0);
  assert.equal(result.plannedCreates, 1);
  assert.ok(result.plannedUpdates >= 3);
  assert.deepEqual(repository.state, before);
  assert.deepEqual(result.results.map((row) => row.websiteMirrorStatus),
    ["primary mismatch", "primary mismatch", "missing"]);
});

test("execution safely creates, updates every mirror, and is idempotent", async () => {
  const repository = repositoryFixture({ participants: [
    { id: "main-one", community_id: "community-one", discord_user_id: "1234567",
      player_id: "111111", in_game_name: "Old", alliance: "OLD", is_primary: false },
    { id: "main-two", community_id: "community-two", discord_user_id: "1234567",
      player_id: "111111", in_game_name: "Old", alliance: "OLD", is_primary: false },
    { id: "alt", community_id: "community-one", discord_user_id: "1234567",
      player_id: "222222", in_game_name: "Player 222222", alliance: "TAG", is_primary: true },
  ] });
  const accounts = [account("111111", { isPrimary: true }), account("222222"), account("333333")];
  const first = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: false,
    repository, accounts, createId: repository.nextId });
  assert.ok(first.mutations > 0);
  assert.equal(first.created, 1);
  assert.deepEqual(repository.state.participants.filter((row) => row.is_primary)
    .map((row) => row.player_id), ["111111", "111111"]);
  assert.deepEqual(repository.state.participants.filter((row) => row.player_id === "111111")
    .map((row) => [row.in_game_name, row.alliance]),
  [["Player 111111", "TAG"], ["Player 111111", "TAG"]]);
  assert.equal(repository.state.keys.length, 1);
  for (const field of ["points", "communityPoints", "bookings", "events", "notifications", "topology"]) {
    assert.deepEqual(repository.state[field], []);
  }
  const writes = repository.state.writes;
  const second = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: false,
    repository, accounts, createId: repository.nextId });
  assert.equal(second.mutations, 0);
  assert.equal(repository.state.writes, writes);
  const verification = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: true,
    repository, accounts, createId: repository.nextId });
  assert.equal(verification.plannedCreates, 0);
  assert.equal(verification.plannedUpdates, 0);
  assert.ok(verification.results.every((row) => row.websiteMirrorStatus === "matching"));
});

test("invalid legacy metadata returns a structured preview conflict without creating a mirror", async () => {
  const repository = repositoryFixture();
  const before = structuredClone(repository.state);
  const result = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: true,
    repository, accounts: [account("111111", { inGameName: "", allianceAbbreviation: "" })],
    createId: repository.nextId });
  assert.equal(result.conflict, "invalid_account_metadata");
  assert.equal(result.mutations, 0);
  assert.equal(result.results[0].websiteMirrorStatus, "ambiguous/conflict");
  assert.match(result.results[0].plannedAction, /^skip: .*invalid account metadata$/);
  assert.deepEqual(repository.state, before);
});

test("invalid metadata preserves an existing mirror and atomically skips its owner group", async () => {
  const repository = repositoryFixture({ participants: [
    { id: "existing", community_id: "community-one", discord_user_id: "1234567",
      player_id: "111111", in_game_name: "Valid Website Name", alliance: "WEB",
      is_primary: false },
  ] });
  const before = structuredClone(repository.state);
  const result = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: false,
    repository, accounts: [account("111111", { inGameName: "", allianceAbbreviation: "",
      isPrimary: true }), account("222222")], createId: repository.nextId });
  assert.equal(result.conflict, "invalid_account_metadata");
  assert.equal(result.mutations, 0);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((row) => row.plannedAction.startsWith("skip:")));
  assert.deepEqual(repository.state, before);
});

test("ownership, ambiguity, invalid bot primaries, and unresolved communities skip safely", async () => {
  for (const fixture of [
    { participants: [{ id: "foreign", community_id: "community-one",
      discord_user_id: "7654321", player_id: "111111", in_game_name: "Foreign",
      alliance: "TAG", is_primary: false }], accounts: [account("111111")],
      conflict: "ownership_mismatch" },
    { participants: ["a", "b"].map((id) => ({ id, community_id: "community-one",
      discord_user_id: "1234567", player_id: "111111", in_game_name: "Duplicate",
      alliance: "TAG", is_primary: false })), accounts: [account("111111")],
      conflict: "ambiguous_website_identity" },
    { participants: [], accounts: [account("111111", { isPrimary: true }),
      account("222222", { isPrimary: true })], conflict: "multiple_authoritative_primaries" },
    { participants: [], communities: new Map([
      ["1001", { id: "community-one", location_code: "1001", status: "archived" }],
    ]), accounts: [account("111111")],
      conflict: "community_unresolved" },
  ]) {
    const repository = repositoryFixture(fixture);
    const result = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: false,
      repository, accounts: fixture.accounts, createId: repository.nextId });
    assert.equal(result.conflict, fixture.conflict);
    assert.equal(result.mutations, 0);
    assert.equal(repository.state.writes, 0);
    if (fixture.conflict === "community_unresolved") {
      assert.equal(result.results[0].websiteMirrorStatus, "unresolved community");
    }
  }
});

test("an owner with only unconfigured locations is outside booking scope and causes no writes", async () => {
  const repository = repositoryFixture({ communities: new Map() });
  const accounts = [account("111111", { communityCode: "3076", isPrimary: true }),
    account("222222", { communityCode: "872", inGameName: "", allianceAbbreviation: "" })];
  for (const dryRun of [true, false]) {
    const result = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun,
      repository, accounts, createId: repository.nextId });
    assert.equal(result.conflict, null);
    assert.equal(result.mutations, 0);
    assert.equal(result.plannedCreates, 0);
    assert.ok(result.results.every((row) =>
      row.websiteMirrorStatus === "outside booking scope"
      && row.plannedAction === "not applicable: no booking community configured"));
  }
  assert.equal(repository.state.writes, 0);
});

test("a configured character reconciles when its sibling is outside booking scope", async () => {
  const repository = repositoryFixture();
  const result = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: false,
    repository, accounts: [account("111111", { isPrimary: true }),
      account("222222", { communityCode: "3076" })], createId: repository.nextId });
  assert.equal(result.conflict, null);
  assert.equal(result.created, 1);
  assert.deepEqual(result.results.map((row) => row.websiteMirrorStatus),
    ["missing", "outside booking scope"]);
  assert.deepEqual(repository.state.participants.filter((row) => row.is_primary)
    .map((row) => row.player_id), ["111111"]);
});

test("an out-of-scope authoritative MAIN leaves configured website mirrors without a MAIN", async () => {
  const repository = repositoryFixture({ participants: [
    { id: "configured-alt", community_id: "community-one", discord_user_id: "1234567",
      player_id: "111111", in_game_name: "Player 111111", alliance: "TAG",
      is_primary: true },
  ] });
  const result = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: false,
    repository, accounts: [account("111111"),
      account("222222", { communityCode: "3076", isPrimary: true })],
    createId: repository.nextId });
  assert.equal(result.conflict, null);
  assert.equal(repository.state.participants[0].is_primary, false);
  assert.equal(result.results[0].websiteMirrorStatus, "primary mismatch");
  assert.equal(result.results[1].websiteMirrorStatus, "outside booking scope");
});

test("later booking-community creation makes an outside character naturally reconcilable", async () => {
  const repository = repositoryFixture({ communities: new Map() });
  const accounts = [account("111111", { communityCode: "3076", isPrimary: true })];
  const outside = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: true,
    repository, accounts, createId: repository.nextId });
  assert.equal(outside.results[0].websiteMirrorStatus, "outside booking scope");
  repository.locations.set("3076",
    { id: "community-3076", location_code: "3076", status: "active" });
  const available = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: false,
    repository, accounts, createId: repository.nextId });
  assert.equal(available.created, 1);
  assert.equal(available.results[0].websiteMirrorStatus, "missing");
  assert.equal(repository.state.participants[0].community_id, "community-3076");
  assert.equal(repository.state.participants[0].is_primary, true);
});

test("an active stale mirror for an unconfigured location remains owner-atomically blocking", async () => {
  const repository = repositoryFixture({ participants: [
    { id: "stale", community_id: "community-one", discord_user_id: "1234567",
      player_id: "222222", in_game_name: "Player 222222", alliance: "TAG",
      is_primary: false },
  ] });
  const before = structuredClone(repository.state);
  const result = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: false,
    repository, accounts: [account("111111"),
      account("222222", { communityCode: "3076" })], createId: repository.nextId });
  assert.equal(result.conflict, "stale_mirror_relationship");
  assert.equal(result.results[1].websiteMirrorStatus, "stale mirror relationship");
  assert.ok(result.results.every((row) => row.plannedAction.startsWith("skip:")));
  assert.deepEqual(repository.state, before);
});

test("outside-scope classification remains isolated between WOS and Kingshot", async () => {
  const wos = repositoryFixture({ communities: new Map(), gameProfile: "wos" });
  const kingshot = repositoryFixture({ communities: new Map([
    ["3076", { id: "kingdom-3076", location_code: "3076", status: "active" }],
  ]), gameProfile: "kingshot" });
  const input = [account("111111", { communityCode: "3076" })];
  const wosResult = await reconcileAuthoritativePlayerMirrors({ gameProfile: "wos", dryRun: true,
    repository: wos, accounts: input, createId: wos.nextId });
  const kingshotResult = await reconcileAuthoritativePlayerMirrors({ gameProfile: "kingshot",
    dryRun: true, repository: kingshot, accounts: input, createId: kingshot.nextId });
  assert.equal(wosResult.results[0].websiteMirrorStatus, "outside booking scope");
  assert.equal(kingshotResult.results[0].websiteMirrorStatus, "missing");
});

test("profile crossover and malformed owner groups fail closed", async () => {
  const repository = repositoryFixture();
  await assert.rejects(reconcileAuthoritativePlayerMirrors({ gameProfile: "kingshot",
    dryRun: true, repository, accounts: [account("111111")] }), /scope mismatch/);
  await assert.rejects(reconcileAuthoritativePlayerMirrors({ gameProfile: "wos",
    dryRun: true, repository, accounts: [account("111111"),
      account("222222", { discordUserId: "7654321" })] }), /owner_group/);
});
