import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  bookingAdminModel,
  BookingAdminGuildLinkDecisionDeniedError,
  BookingAdminTopologyDeniedError,
  BookingAdminValidationError,
  validateCycleScheduleTiming,
  validateBookingAdminChange,
} from "../server/booking-admin/domain-core.mjs";
import { createBookingAdminService } from "../server/booking-admin/service-core.mjs";
import {
  createCommunityManagerAuthorizer,
  ManagerAccessDeniedError,
} from "../server/booking-board/manager-authorization-core.mjs";

const communityId = "10000000-0000-4000-8000-000000000001";
const manager = {
  gameProfile: "wos",
  authorizedCommunityId: communityId,
  discordUserId: "111111111111111111",
  displayName: "Manager",
};

function snapshot() {
  return {
    community: { id: communityId, location_code: "9999", display_name: "State 9999",
      status: "active", bookings_open: true },
    services: [
      { service_code: "construction", display_label: "Construction", enabled: true },
      { service_code: "research", display_label: "Research", enabled: true },
      { service_code: "troop", display_label: "Troop", enabled: false },
    ],
    settings: {
      construction_fc_required: true, construction_rfc_required: false,
      construction_speedups_required: true, research_shards_required: true,
      research_speedups_required: false, troop_speedups_required: true,
    },
    windows: [{ id: "window", status: "open", opens_at: null, closes_at: null }],
    dates: [{ service_code: "construction", display_label: "Construction",
      booking_date: "2026-08-30", window_status: "open" }],
    guestLink: null,
    guilds: [],
    scheduleOverrides: [],
    activity: [],
  };
}

function fakeRepository() {
  const state = snapshot();
  const audits = [];
  const notifications = [];
  const session = {
    async lockCommunity(id) { return id === communityId ? state.community : null; },
    async readSnapshot(id) { return id === communityId ? state : null; },
    async setBookingEnabled(_id, enabled) { state.community.bookings_open = enabled; },
    async setServiceEnabled(_id, code, enabled) {
      state.services.find((service) => service.service_code === code).enabled = enabled;
    },
    async setRequirementEnabled(_id, service, requirement, enabled) {
      state.settings[`${service}_${requirement}_required`] = enabled;
    },
    async insertAudit(input) { audits.push(input); },
    async lockGuestLinks() {
      return state.guestLink && !state.guestLink.revoked_at ? state.guestLink : null;
    },
    async revokeGuestLink(_id, actorId) {
      state.guestLink.revoked_at = "2026-08-26T12:00:00.000Z";
      state.guestLink.revoked_by_actor_id = actorId;
    },
    async supersedeManualGuestLinkNotification(linkId) {
      for (const notification of notifications) {
        if (notification.guestLinkId === linkId) notification.status = "superseded";
      }
    },
    async insertGuestLink(input) {
      state.guestLink = {
        id: input.id, token_hash: input.tokenHash, token_hint: input.tokenHint,
        created_at: "2026-08-26T12:00:00.000Z", expires_at: null, revoked_at: null,
      };
    },
    async insertManualGuestLinkNotification(input) {
      notifications.push({ ...input, status: "pending" });
    },
    async insertGuestLinkAudit(input) { audits.push(input); },
  };
  return {
    gameProfile: "wos", state, audits, notifications,
    async withTransaction(work) { return work(session); },
  };
}

test("existing community manager authorization gates Booking Admin access", async () => {
  const authorizationRepository = {
    gameProfile: "wos",
    async withTransaction(work) {
      return work({
        findActiveCommunityByLocationCode: async (code) => code === "9999"
          ? { id: communityId, location_code: "9999" } : null,
        listLinkedManagerGuilds: async () => [{
          discord_guild_id: "222222222222222222", bot_manager_role_id: "333333333333333333",
        }],
      });
    },
  };
  const discordSession = {
    gameProfile: "wos",
    discordUser: { id: "111111111111111111", username: "manager", globalName: "Manager" },
  };
  const authorized = createCommunityManagerAuthorizer({
    gameProfile: "wos", repository: authorizationRepository,
    verifyDiscordGuildManager: async () => ({
      status: "authorized", via: "bot_manager_role", guildId: "222222222222222222",
    }),
  });
  const context = await authorized.authorize(discordSession, "9999");
  assert.equal((await createBookingAdminService({
    gameProfile: "wos", communityId, managerContext: context, repository: fakeRepository(),
  }).read()).community.code, "9999");

  const denied = createCommunityManagerAuthorizer({
    gameProfile: "wos", repository: authorizationRepository,
    verifyDiscordGuildManager: async () => ({ status: "denied", reason: "insufficient_permissions" }),
  });
  await assert.rejects(denied.authorize(discordSession, "9999"), ManagerAccessDeniedError);
});

test("authorised exact-community manager reads booking, services, requirements, windows, and dates", async () => {
  const repository = fakeRepository();
  const configuration = await createBookingAdminService({
    gameProfile: "wos", communityId, managerContext: manager, repository,
  }).read();
  assert.equal(configuration.community.bookingsEnabled, true);
  assert.deepEqual(configuration.services.map(({ code, enabled }) => ({ code, enabled })), [
    { code: "construction", enabled: true },
    { code: "research", enabled: true },
    { code: "troop", enabled: false },
  ]);
  assert.deepEqual(configuration.services[0].requirements.map(({ code, enabled }) => ({ code, enabled })), [
    { code: "fc", enabled: true }, { code: "rfc", enabled: false },
    { code: "speedups", enabled: true },
  ]);
  assert.deepEqual(configuration.dates[0], {
    serviceCode: "construction", serviceName: "Construction", date: "2026-08-30", windowStatus: "open",
  });
  assert.ok(configuration.automaticCycle);
  const automatic = bookingAdminModel("wos", snapshot(), new Date("2026-08-26T12:00:00Z"));
  assert.equal(automatic.automaticCycle.opensAt, "2026-09-02T00:00:00.000Z");
  assert.equal(automatic.automaticCycle.closesAt, "2026-09-06T12:00:00.000Z");
  assert.deepEqual(automatic.automaticCycle.appointments.map(({ serviceCode, date }) => ({
    serviceCode, date,
  })), [
    { serviceCode: "construction", date: "2026-09-07" },
    { serviceCode: "research", date: "2026-09-08" },
    { serviceCode: "troop", date: "2026-09-10" },
  ]);
});

test("booking, service, resource, and speed-ups toggles persist and are audited", async () => {
  const repository = fakeRepository();
  let id = 0;
  const service = createBookingAdminService({
    gameProfile: "wos", communityId, managerContext: manager, repository,
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
  assert.equal((await service.update({ section: "booking", enabled: false })).community.bookingsEnabled, false);
  assert.equal((await service.update({ section: "service", serviceCode: "construction", enabled: false }))
    .services[0].enabled, false);
  let updated = await service.update({
    section: "requirement", serviceCode: "construction", requirementCode: "fc", enabled: false,
  });
  assert.equal(updated.services[0].requirements.find(({ code }) => code === "fc").enabled, false);
  updated = await service.update({
    section: "requirement", serviceCode: "research", requirementCode: "speedups", enabled: true,
  });
  assert.equal(updated.services[1].requirements.find(({ code }) => code === "speedups").enabled, true);
  assert.equal(repository.audits.length, 4);
  assert.equal(repository.audits.every((audit) => audit.communityId === communityId
    && audit.actorId === manager.discordUserId), true);
});

test("manager guest-link lifecycle returns plaintext only for generation and rotation", async () => {
  const repository = fakeRepository();
  let id = 0;
  const tokens = ["a".repeat(43), "b".repeat(43), "c".repeat(43)];
  const service = createBookingAdminService({
    gameProfile: "wos", communityId, managerContext: manager, repository,
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    createGuestToken: () => tokens.shift(),
    now: () => new Date("2026-08-26T12:00:00.000Z"),
  });

  const generated = await service.updateGuestLink({ section: "guestLink", action: "generate" });
  assert.equal(generated.configuration.guestLink.status, "active");
  assert.equal(generated.guestLinkPath, `/book/${"a".repeat(43)}`);
  assert.equal(repository.notifications.length, 1);
  assert.equal(repository.notifications[0].status, "pending");
  assert.doesNotMatch(JSON.stringify(generated.configuration), /token|hash/i);
  await assert.rejects(
    service.updateGuestLink({ section: "guestLink", action: "generate" }),
    (error) => error.code === "active_link_exists",
  );

  const rotated = await service.updateGuestLink({ section: "guestLink", action: "rotate" });
  assert.equal(rotated.guestLinkPath, `/book/${"b".repeat(43)}`);
  assert.equal(repository.notifications.length, 2);
  assert.equal(repository.notifications[0].status, "superseded");
  assert.equal(repository.notifications[1].status, "pending");
  assert.equal(repository.state.guestLink.token_hash.length, 64);
  const revoked = await service.updateGuestLink({ section: "guestLink", action: "revoke" });
  assert.equal(revoked.guestLinkPath, null);
  assert.equal(revoked.configuration.guestLink.status, "revoked");
  assert.equal(repository.notifications.length, 2);
  assert.equal(repository.notifications[1].status, "superseded");
  const regenerated = await service.updateGuestLink({ section: "guestLink", action: "generate" });
  assert.equal(regenerated.guestLinkPath, `/book/${"c".repeat(43)}`);
  assert.equal(repository.notifications.length, 3);
  assert.equal(repository.notifications[2].status, "pending");
  assert.equal(repository.audits.slice(-3).every((audit) => audit.actorId === manager.discordUserId), true);
});

test("unauthorised, cross-profile, and other-community manager contexts fail closed", () => {
  const repository = fakeRepository();
  for (const managerContext of [null, { ...manager, gameProfile: "kingshot" },
    { ...manager, authorizedCommunityId: "20000000-0000-4000-8000-000000000002" }]) {
    assert.throws(() => createBookingAdminService({
      gameProfile: "wos", communityId, managerContext, repository,
    }), (error) => error.code === "manager_forbidden");
  }
});

test("admin mutations accept only known, strictly scoped boolean changes", () => {
  assert.deepEqual(validateBookingAdminChange({ section: "booking", enabled: false }),
    { section: "booking", enabled: false });
  assert.throws(() => validateBookingAdminChange({ section: "service", serviceCode: "unknown", enabled: true }),
    BookingAdminValidationError);
  assert.throws(() => validateBookingAdminChange({ section: "booking", enabled: true, communityId: "other" }),
    BookingAdminValidationError);
  assert.throws(() => validateBookingAdminChange({
    section: "requirement", serviceCode: "troop", requirementCode: "fc", enabled: true,
  }), BookingAdminValidationError);
  assert.deepEqual(validateBookingAdminChange({ section: "guestLink", action: "rotate" }),
    { section: "guestLink", action: "rotate" });
  assert.throws(() => validateBookingAdminChange({ section: "guestLink", action: "copy" }),
    BookingAdminValidationError);
  assert.throws(() => validateBookingAdminChange({
    section: "discordAccess", action: "unlink", guildId: "222222222222222222", confirmed: false,
  }), BookingAdminValidationError);
});

function unlinkRepository(guilds) {
  const state = snapshot();
  state.guilds = structuredClone(guilds);
  const audits = [];
  const session = {
    async readSnapshot(id) { return id === communityId ? state : null; },
    async lockDiscordTopology() { return state.guilds; },
    async revokeAllianceGuildAccess({ guildId }) {
      const guild = state.guilds.find((candidate) => candidate.discord_guild_id === guildId);
      if (!guild || guild.link_status !== "active" || guild.guild_kind !== "alliance") {
        return { changed: false, affectedGrantCount: 0 };
      }
      guild.link_status = "revoked";
      return { changed: true, affectedGrantCount: 3 };
    },
    async insertGuildUnlinkAudit(input) { audits.push(input); },
  };
  return { gameProfile: "wos", state, audits,
    async withTransaction(work) { return work(session); } };
}

const stateGuild = { discord_guild_id: "999999999999999999", discord_guild_name: "Shared State",
  guild_kind: "state", link_status: "active" };
const allianceOne = { discord_guild_id: "222222222222222222", discord_guild_name: "Alliance One",
  guild_kind: "alliance", link_status: "active" };
const allianceTwo = { discord_guild_id: "333333333333333333", discord_guild_name: "Alliance Two",
  guild_kind: "alliance", link_status: "active" };
const unclassifiedGuild = { discord_guild_id: "444444444444444444", discord_guild_name: "Legacy Guild",
  guild_kind: "unclassified", link_status: "active" };

function ownerVerifier(ownerGuildIds) {
  return async ({ guildId }) => ({ status: ownerGuildIds.includes(guildId) ? "owner" : "not_owner" });
}

test("guild unlink requires exact alliance or shared-State ownership, never manager role alone", async () => {
  for (const allowedGuilds of [[allianceOne.discord_guild_id], [stateGuild.discord_guild_id]]) {
    const repository = unlinkRepository([stateGuild, allianceOne, allianceTwo]);
    const result = await createBookingAdminService({
      gameProfile: "wos", communityId, managerContext: manager, repository,
      verifyGuildOwner: ownerVerifier(allowedGuilds),
    }).unlinkAllianceGuild({ section: "discordAccess", action: "unlink",
      guildId: allianceOne.discord_guild_id, confirmed: true });
    assert.equal(result.unlink.changed, true);
    assert.equal(result.unlink.affectedGrantCount, 3);
    assert.equal(repository.audits.length, 1);
  }

  for (const ownedGuilds of [[], [allianceTwo.discord_guild_id],
    [unclassifiedGuild.discord_guild_id]]) {
    await assert.rejects(createBookingAdminService({
      gameProfile: "wos", communityId, managerContext: {
        ...manager, authorization: { via: "bot_manager_role" },
      }, repository: unlinkRepository([stateGuild, allianceOne, allianceTwo,
        unclassifiedGuild]),
      verifyGuildOwner: ownerVerifier(ownedGuilds),
    }).unlinkAllianceGuild({ section: "discordAccess", action: "unlink",
      guildId: allianceOne.discord_guild_id, confirmed: true }), BookingAdminTopologyDeniedError);
  }
});

test("alliance owner can self-unlink without a State Discord; topology scope fails closed", async () => {
  const self = await createBookingAdminService({
    gameProfile: "wos", communityId, managerContext: manager,
    repository: unlinkRepository([allianceOne]),
    verifyGuildOwner: ownerVerifier([allianceOne.discord_guild_id]),
  }).unlinkAllianceGuild({ section: "discordAccess", action: "unlink",
    guildId: allianceOne.discord_guild_id, confirmed: true });
  assert.equal(self.unlink.changed, true);

  for (const target of [stateGuild.discord_guild_id, unclassifiedGuild.discord_guild_id,
    "555555555555555555"]) {
    await assert.rejects(createBookingAdminService({
      gameProfile: "wos", communityId, managerContext: manager,
      repository: unlinkRepository([stateGuild, allianceOne, unclassifiedGuild]),
      verifyGuildOwner: ownerVerifier([stateGuild.discord_guild_id,
        unclassifiedGuild.discord_guild_id]),
    }).unlinkAllianceGuild({ section: "discordAccess", action: "unlink",
      guildId: target, confirmed: true }), BookingAdminTopologyDeniedError);
  }
});

const linkRequestId = "50000000-0000-4000-8000-000000000005";

function guildLinkDecisionRepository(guilds) {
  const state = snapshot();
  state.guilds = structuredClone(guilds);
  state.guildLinkRequests = [{
    id: linkRequestId, community_id: communityId,
    requesting_discord_guild_id: "555555555555555555",
    requesting_discord_guild_name: "Alliance Five", alliance_abbreviation: "FIV",
    requested_by_discord_user_id: "888888888888888888", status: "pending",
    requested_at: "2026-08-29T12:00:00.000Z",
  }];
  const audits = [];
  const decisions = [];
  const session = {
    async readSnapshot(id) { return id === communityId ? state : null; },
    async lockCommunity(id) { return id === communityId ? state.community : null; },
    async lockDiscordTopology() { return state.guilds; },
    async lockGuildLinkRequest(_communityId, requestId) {
      return state.guildLinkRequests.find((request) => request.id === requestId) ?? null;
    },
    async activateAllianceGuildLink({ request, actorId }) {
      state.guilds.push({ discord_guild_id: request.requesting_discord_guild_id,
        discord_guild_name: request.requesting_discord_guild_name, guild_kind: "alliance",
        link_status: "active", linked_by_actor_id: actorId });
      return { status: "created" };
    },
    async decideGuildLinkRequest({ requestId, decision, actorId }) {
      const request = state.guildLinkRequests.find((item) => item.id === requestId);
      request.status = decision;
      decisions.push({ requestId, decision, actorId });
      state.guildLinkRequests = state.guildLinkRequests.filter((item) => item.status === "pending");
    },
    async insertGuildLinkDecisionAudit(input) { audits.push(input); },
  };
  return { gameProfile: "wos", state, audits, decisions,
    async withTransaction(work) { return work(session); } };
}

test("State ownership exclusively decides pending alliance links when State is configured", async () => {
  const repository = guildLinkDecisionRepository([stateGuild, allianceOne]);
  const result = await createBookingAdminService({
    gameProfile: "wos", communityId, managerContext: manager, repository,
    verifyGuildOwner: ownerVerifier([stateGuild.discord_guild_id]),
  }).decideGuildLinkRequest({ section: "guildLinkRequest", action: "approve",
    requestId: linkRequestId, confirmed: true });
  assert.deepEqual(result.guildLinkRequest, { requestId: linkRequestId, status: "approved" });
  assert.equal(repository.state.guilds.filter((guild) => guild.guild_kind === "alliance"
    && guild.link_status === "active").length, 2);
  assert.equal(repository.state.guilds.at(-1).discord_guild_id, "555555555555555555");
  assert.equal(repository.audits[0].decision, "approved");

  for (const owned of [[], [allianceOne.discord_guild_id], ["555555555555555555"]]) {
    await assert.rejects(createBookingAdminService({
      gameProfile: "wos", communityId,
      managerContext: { ...manager, authorization: { via: "bot_manager_role" } },
      repository: guildLinkDecisionRepository([stateGuild, allianceOne]),
      verifyGuildOwner: ownerVerifier(owned),
    }).decideGuildLinkRequest({ section: "guildLinkRequest", action: "approve",
      requestId: linkRequestId, confirmed: true }), BookingAdminGuildLinkDecisionDeniedError);
  }
});

test("without State, an existing active alliance owner may approve or reject another alliance", async () => {
  const approvedRepository = guildLinkDecisionRepository([allianceOne]);
  await createBookingAdminService({
    gameProfile: "wos", communityId, managerContext: manager, repository: approvedRepository,
    verifyGuildOwner: ownerVerifier([allianceOne.discord_guild_id]),
  }).decideGuildLinkRequest({ section: "guildLinkRequest", action: "approve",
    requestId: linkRequestId, confirmed: true });
  assert.equal(approvedRepository.decisions[0].decision, "approved");

  const rejectedRepository = guildLinkDecisionRepository([allianceOne]);
  await createBookingAdminService({
    gameProfile: "wos", communityId, managerContext: manager, repository: rejectedRepository,
    verifyGuildOwner: ownerVerifier([allianceOne.discord_guild_id]),
  }).decideGuildLinkRequest({ section: "guildLinkRequest", action: "reject",
    requestId: linkRequestId, confirmed: true });
  assert.equal(rejectedRepository.state.guilds.length, 1, "rejection does not activate the requester");
  assert.equal(rejectedRepository.decisions[0].decision, "rejected");
  assert.equal(rejectedRepository.audits[0].decision, "rejected");
});

test("cycle override validation is cycle-scoped, bounded, historical-safe, and explicit when open", () => {
  const draftNow = new Date("2026-09-01T12:00:00.000Z");
  const valid = validateCycleScheduleTiming({ section: "cycleSchedule", action: "override",
    cycleIndex: 1, opensAt: "2026-09-01T18:00:00.000Z", closesAt: "2026-09-06T18:00:00.000Z",
    confirmedOpenChange: false }, draftNow);
  assert.equal(valid.opensAt, "2026-09-01T18:00:00.000Z");
  assert.throws(() => validateCycleScheduleTiming({ section: "cycleSchedule", action: "override",
    cycleIndex: 2, opensAt: valid.opensAt, closesAt: valid.closesAt, confirmedOpenChange: false }, draftNow),
  (error) => error.code === "cycle_not_current");
  assert.throws(() => validateCycleScheduleTiming({ section: "cycleSchedule", action: "override",
    cycleIndex: 1, opensAt: valid.closesAt, closesAt: valid.opensAt, confirmedOpenChange: false }, draftNow),
  (error) => error.code === "invalid_schedule");
  const openNow = new Date("2026-09-03T12:00:00.000Z");
  assert.throws(() => validateCycleScheduleTiming({ section: "cycleSchedule", action: "override",
    cycleIndex: 1, opensAt: "2026-09-02T00:00:00.000Z", closesAt: "2026-09-06T12:00:00.000Z",
    confirmedOpenChange: false }, openNow), (error) => error.code === "confirmation_required");
  assert.throws(() => validateCycleScheduleTiming({ section: "cycleSchedule", action: "restore",
    cycleIndex: 1, confirmedOpenChange: true }, new Date("2026-09-07T01:00:00.000Z"), {
    cycle_index: 1, opens_at: "2026-09-02T00:00:00.000Z", closes_at: "2026-09-06T18:00:00.000Z",
  }), (error) => error.code === "historical_cycle");
});

test("admin routes and UI reuse manager authorization and expose no destructive date controls", () => {
  const stateRoute = fs.readFileSync(new URL("../app/state/[communityCode]/admin/page.tsx", import.meta.url), "utf8");
  const kingdomRoute = fs.readFileSync(new URL("../app/kingdom/[communityCode]/admin/page.tsx", import.meta.url), "utf8");
  const apiRoute = fs.readFileSync(new URL("../app/api/v1/booking-admin/[communityCode]/route.ts", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../server/booking-admin/page.tsx", import.meta.url), "utf8");
  const access = fs.readFileSync(new URL("../server/booking-admin/access.ts", import.meta.url), "utf8");
  const handler = fs.readFileSync(new URL("../server/booking-admin/route-handler.ts", import.meta.url), "utf8");
  const ui = fs.readFileSync(new URL("../components/booking-admin/booking-admin.tsx", import.meta.url), "utf8");
  assert.match(stateRoute, /requiredProfile="wos"/);
  assert.match(kingdomRoute, /requiredProfile="kingshot"/);
  assert.match(apiRoute, /GET/); assert.match(apiRoute, /PATCH/);
  assert.match(page, /authorizeBookingAdminRequest/); assert.match(page, /notFound/);
  assert.match(access, /createCommunityManagerAuthorizer/);
  assert.match(access, /verifyDiscordGuildManager/);
  assert.match(handler, /authorizeBookingAdminRequest/);
  assert.equal(handler.match(/await scope\(request, communityCode\)/g)?.length, 2,
    "GET and PATCH share the same scoped authorization helper");
  assert.match(handler, /verifyAuthenticatedMutationCsrf/);
  assert.match(handler, /bookingAdminMutation/);
  assert.match(ui, /role="switch"/); assert.match(ui, /Member bookings/);
  assert.match(ui, /Booking enabled/); assert.match(ui, /Booking window/);
  assert.match(ui, /Save times/); assert.match(ui, /Use default times/);
  assert.match(ui, /Discord access/); assert.match(ui, /Unlink alliance/);
  assert.match(ui, /members may lose website access/);
  assert.match(ui, /Guest booking link/); assert.match(ui, /Generate new link/);
  assert.match(ui, /Replace link/); assert.match(ui, /Disable link/); assert.match(ui, /Copy/);
  assert.match(ui, /current link cannot be shown again/);
  assert.match(ui, /Appointment types/); assert.match(ui, /Troop Training/);
  assert.match(ui, /Upcoming appointment dates/);
  assert.match(ui, /<h2 id="booking-admin-activity">Recent activity<\/h2>/);
  assert.match(ui, /No recent booking activity yet\./);
  assert.match(ui, /Booked appointment/);
  assert.match(ui, /Added booking manually/);
  assert.match(ui, /Approved guest booking/); assert.match(ui, /Denied guest booking/);
  assert.match(ui, /Rescheduled booking/); assert.match(ui, /Cancelled booking/);
  assert.match(ui, /Discord ID:/); assert.match(ui, /Player ID:/);
  assert.match(ui, /<option value="configuration">Settings<\/option>/);
  assert.doesNotMatch(ui, /Booking Admin v1|only a hash is stored|Resource requirement/);
  assert.doesNotMatch(ui, /create date|delete date|generate slot/i);
});

test("public admin model contains only display-safe configuration and linked guild choices", () => {
  const model = bookingAdminModel("wos", snapshot());
  assert.doesNotMatch(JSON.stringify(model), /audit|password|token|revoked_by|source_guild/i);
  assert.deepEqual(model.activity, []);
  assert.equal(bookingAdminModel("kingshot", snapshot()).automaticCycle, null);
});

test("Booking Admin activity preserves bounded event identity and display details", () => {
  const source = snapshot();
  source.activity = [{
    action: "manager_manual_booking", category: "bookings", player_name: "Player One",
    player_id: "987654", actor_discord_user_id: "111111111111111111",
    actor_display_name: "Manager One", service_code: "construction",
    previous_state: null, resulting_state: "manager_manual_booking", previous_time: null,
    new_time: "19:30", booking_date: "2026-09-01", setting_section: null,
    requirement_code: null, enabled: null, guild_name: null, cycle_index: null,
    created_at: new Date("2026-09-01T12:00:00.000Z"),
  }, {
    action: "approved", category: "approvals", player_name: "Guest Player",
    player_id: "123456", actor_discord_user_id: "222222222222222222",
    actor_display_name: "Approver", service_code: "research", previous_state: "pending_approval",
    resulting_state: "confirmed", previous_time: null, new_time: "18:30",
    booking_date: "2026-09-02", setting_section: null, requirement_code: null,
    enabled: null, guild_name: null, cycle_index: null,
    created_at: new Date("2026-09-01T11:00:00.000Z"),
  }];
  const activity = bookingAdminModel("wos", source).activity;
  assert.equal(activity[0].action, "manager_manual_booking");
  assert.equal(activity[0].actorDiscordUserId, "111111111111111111");
  assert.equal(activity[0].actorDisplayName, "Manager One");
  assert.equal(activity[0].newTime, "19:30");
  assert.equal(activity[1].action, "approved");
  assert.equal(activity[1].playerId, "123456");
});

test("Booking Admin activity query is newest-first and hard-bounded to 100 rows", () => {
  const repository = fs.readFileSync(
    new URL("../server/booking-admin/repository-core.mjs", import.meta.url), "utf8",
  );
  assert.match(repository, /listRecentActivity\(communityId, 100\)/);
  assert.match(repository, /ORDER BY activity\.created_at DESC,activity\.id DESC[\s\S]*LIMIT \$3/);
  assert.match(repository, /booking_approval_events/);
  assert.match(repository, /booking_change_events/);
  assert.match(repository, /website_discord_identities/);
});
