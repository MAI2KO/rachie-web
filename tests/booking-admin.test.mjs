import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  bookingAdminModel,
  BookingAdminValidationError,
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
  };
}

function fakeRepository() {
  const state = snapshot();
  const audits = [];
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
  };
  return {
    gameProfile: "wos", state, audits,
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
  assert.match(handler, /authorizeBookingAdminRequest/);
  assert.match(handler, /verifyAuthenticatedMutationCsrf/);
  assert.match(handler, /bookingAdminMutation/);
  assert.match(ui, /role="switch"/); assert.match(ui, /Read-only in Booking Admin v1/);
  assert.doesNotMatch(ui, /create date|delete date|generate slot/i);
});

test("public admin model contains configuration only", () => {
  const model = bookingAdminModel("wos", snapshot());
  assert.doesNotMatch(JSON.stringify(model), /discord|actor|guild|audit|password|token/i);
});
