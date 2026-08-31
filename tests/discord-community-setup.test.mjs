import assert from "node:assert/strict";
import test from "node:test";

import { createDiscordCommunitySetupService } from "../server/discord-integration/community-setup-service-core.mjs";

function fixture(gameProfile = "wos") {
  const state = { communities: new Map(), links: new Map(), requests: [], creates: 0, audits: [] };
  const session = {
    async lockCommunitySetup() {},
    async findCommunityByLocationCode(code) { return state.communities.get(code) ?? null; },
    async findCommunityForDiscordGuild(guildId) {
      const code = state.links.get(guildId);
      return code ? state.communities.get(code) ?? null : null;
    },
    async countActiveCommunityGuilds(communityId) {
      return [...state.links.values()].filter((code) =>
        state.communities.get(code)?.id === communityId).length;
    },
    async findPendingCommunityGuildLinkRequest(communityId, guildId) {
      return state.requests.find((request) => request.communityId === communityId
        && request.discordGuildId === guildId && request.status === "pending") ?? null;
    },
    async insertCommunityGuildLinkRequest(input) {
      state.requests.push({ ...input, status: "pending" });
    },
    async insertCommunityGuildLinkRequestAudit(input) { state.audits.push(input); },
    async createWosCommunityDefaults({ id, locationCode, displayName }) {
      state.creates += 1;
      const community = {
        game_profile: gameProfile,
        id,
        location_code: locationCode,
        display_name: displayName,
        status: "active",
        bookings_open: false,
      };
      state.communities.set(locationCode, community);
      return community;
    },
    async insertCommunitySetupAudit(input) { state.audits.push(input); },
    async linkDiscordGuild({ discordGuildId, communityId }) {
      const existingCode = state.links.get(discordGuildId);
      const community = [...state.communities.values()].find((row) => row.id === communityId);
      if (existingCode && existingCode !== community?.location_code) return { status: "conflict" };
      state.links.set(discordGuildId, community.location_code);
      return { status: existingCode ? "updated" : "created" };
    },
  };
  return {
    state,
    repository: {
      gameProfile,
      async withTransaction(work) { return work(session); },
    },
  };
}

const input = Object.freeze({
  communityCode: "9999",
  guildId: "700000000000000001",
  guildName: "HoboswithCandy",
  alliance: "HWC",
  actorId: "700000000000000002",
});

test("WOS setup preview is read-only and apply is creation-idempotent", async () => {
  const { state, repository } = fixture();
  let id = 0;
  const service = createDiscordCommunitySetupService({
    gameProfile: "wos", repository, createId: () => `id-${++id}`,
  });
  const preview = await service.reconcile({ ...input, dryRun: true });
  assert.deepEqual(preview, {
    community: { code: "9999", displayName: "HoboswithCandy" },
    status: "ready to create native community",
    bookingsOpen: false,
    created: true,
  });
  assert.equal(state.creates, 0);
  assert.equal(state.links.size, 0);
  assert.equal(state.audits.length, 0);

  const created = await service.reconcile({ ...input, dryRun: false });
  assert.equal(created.status, "native community created and linked");
  assert.equal(created.created, true);
  const replay = await service.reconcile({ ...input, dryRun: false });
  assert.equal(replay.status, "linked and reconciled");
  assert.equal(replay.created, false);
  assert.equal(state.creates, 1);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].actorId, input.actorId);
});

test("setup rejects cross-community conflicts and requests approval for an additional alliance", async () => {
  const { state, repository } = fixture();
  const service = createDiscordCommunitySetupService({ gameProfile: "wos", repository });
  state.communities.set("1111", {
    id: "community-one", location_code: "1111", display_name: "One",
    status: "active", bookings_open: false,
  });
  state.links.set(input.guildId, "1111");
  assert.deepEqual(await service.reconcile({ ...input, dryRun: false }), {
    error: "guild_conflict",
  });
  assert.equal(state.communities.has("9999"), false);
  assert.equal(state.creates, 0);

  state.links.clear();
  state.communities.set("9999", {
    id: "community-nine", location_code: "9999", display_name: "Nine",
    status: "active", bookings_open: false,
  });
  state.links.set("700000000000000099", "9999");
  const preview = await service.reconcile({ ...input, dryRun: true });
  assert.equal(preview.status, "ready to request alliance link");
  assert.equal(preview.linkStatus, "requestable");
  assert.equal(state.requests.length, 0);
  const requested = await service.reconcile({ ...input, dryRun: false });
  assert.equal(requested.status, "alliance link approval requested");
  assert.equal(requested.linkStatus, "pending");
  const replay = await service.reconcile({ ...input, dryRun: false });
  assert.equal(replay.status, "alliance link approval pending");
  assert.equal(state.requests.length, 1);
  state.requests[0].status = "rejected";
  const retry = await service.reconcile({ ...input, dryRun: false });
  assert.equal(retry.status, "alliance link approval requested");
  assert.equal(state.requests.length, 2, "rejected history is retained while a new request is allowed");
  assert.equal(state.links.has(input.guildId), false);
});

test("Kingshot reports the missing default cycle instead of inventing one", async () => {
  const { state, repository } = fixture("kingshot");
  const service = createDiscordCommunitySetupService({ gameProfile: "kingshot", repository });
  assert.deepEqual(await service.reconcile({ ...input, dryRun: false }), {
    error: "kingshot_defaults_unavailable",
  });
  assert.equal(state.creates, 0);
  assert.equal(state.links.size, 0);
});
