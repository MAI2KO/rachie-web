import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveNativeBookingCommunityCode,
} from "../server/native-booking/community-config.mjs";
import {
  createNativeBookingReadApi,
} from "../server/native-booking/read-api-core.mjs";
import {
  createNativeBookingReadService,
  NativeBookingCommunityNotFoundError,
  NativeBookingServiceNotFoundError,
} from "../server/native-booking/read-service-core.mjs";
import {
  resolveNativeBookingRequestContextCore,
} from "../server/native-booking/request-context-core.mjs";

const brands = {
  localhost: {
    displayName: "R.A.C.H.I.E",
    shortName: "RACHIE",
    description: "WOS",
    game: { name: "Whiteout Survival", profile: "wos" },
    theme: { id: "whiteout", colors: { accent: "#2563eb" } },
  },
  "peggie.localhost": {
    displayName: "P.E.G.G.I.E",
    shortName: "PEGGIE",
    description: "Kingshot",
    game: { name: "Kingshot", profile: "kingshot" },
    theme: { id: "kingshot", colors: { accent: "#b45309" } },
  },
};

function normalizeHostname(host) {
  return String(host ?? "").split(":", 1)[0].toLowerCase();
}

function trustedContext(request, communityCodes = { wos: "1001", kingshot: "2002" }) {
  return resolveNativeBookingRequestContextCore(request, {
    normalizeHostname,
    resolveKnownBrand: (hostname) => brands[hostname] ?? null,
    resolveCommunityCode: (profile) => communityCodes[profile] ?? null,
  });
}

function fakeRepository(overrides = {}) {
  const session = {
    async findCommunityByLocationCode(locationCode) {
      return {
        id: "community-id",
        location_code: locationCode,
        display_name: "Community 1001",
        status: "active",
        bookings_open: true,
      };
    },
    async findCurrentBookingWindow() {
      return { id: "window-id", status: "open" };
    },
    async listActiveMinisterServices() {
      return [
        {
          service_code: "construction",
          display_label: "Construction",
          appointment_label: "Minister booking",
        },
      ];
    },
    async listServiceDates() {
      return [
        { service_code: "construction", booking_date: "2026-08-20" },
      ];
    },
    async findBookingSettings() {
      return {
        construction_fc_required: true,
        construction_rfc_required: false,
        construction_speedups_required: true,
        research_shards_required: false,
        research_speedups_required: true,
        troop_speedups_required: false,
      };
    },
    async listAvailableAppointmentSlots() {
      return [
        {
          id: "slot-later",
          display_time_label: "00:30",
          ordinal: 2,
          occupied_by: "must-not-leak",
        },
        {
          id: "slot-earlier",
          display_time_label: "00:00",
          ordinal: 1,
          discord_user_id: "must-not-leak",
        },
      ];
    },
    async findActiveParticipantByDiscordUser() {
      return null;
    },
    async listConfirmedBookingsForParticipant() {
      return [];
    },
    ...overrides,
  };

  return {
    gameProfile: "wos",
    async withTransaction(work) {
      return work(session);
    },
  };
}

test("community configuration is strictly profile-scoped", () => {
  const environment = {
    WOS_NATIVE_BOOKING_COMMUNITY_CODE: " 1001 ",
    KINGSHOT_NATIVE_BOOKING_COMMUNITY_CODE: "2002",
  };

  assert.equal(resolveNativeBookingCommunityCode("wos", environment), "1001");
  assert.equal(
    resolveNativeBookingCommunityCode("kingshot", environment),
    "2002",
  );
  assert.equal(resolveNativeBookingCommunityCode("unknown", environment), null);
});

test("hostname context selects WOS and Kingshot without request profile authority", () => {
  const wos = trustedContext(
    new Request("http://localhost/api/v1/booking/context?game_profile=kingshot", {
      headers: { host: "localhost:3000" },
    }),
  );
  const kingshot = trustedContext(
    new Request("http://peggie.localhost/api/v1/booking/context?game_profile=wos", {
      headers: { host: "peggie.localhost:3000" },
    }),
  );

  assert.equal(wos.gameProfile, "wos");
  assert.equal(wos.communityLocationCode, "1001");
  assert.equal(kingshot.gameProfile, "kingshot");
  assert.equal(kingshot.communityLocationCode, "2002");
});

test("read service maps context and availability without raw rows", async () => {
  const service = createNativeBookingReadService({
    gameProfile: "wos",
    communityLocationCode: "1001",
    repository: fakeRepository(),
  });
  const context = await service.getContext();
  const availability = await service.getAvailability("construction");

  assert.equal(context.bookingsOpen, true);
  assert.equal(context.windowState, "open");
  assert.equal(context.services[0].date, "2026-08-20");
  assert.deepEqual(availability.slots, [
    { slotId: "slot-earlier", displayTime: "00:00", ordinal: 1 },
    { slotId: "slot-later", displayTime: "00:30", ordinal: 2 },
  ]);
  assert.equal(JSON.stringify(availability).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(availability).includes("discord_user_id"), false);
});

test("closed windows are represented and do not query slots", async () => {
  let slotQueries = 0;
  const repository = fakeRepository({
    async findCurrentBookingWindow() {
      return { id: "window-id", status: "closed" };
    },
    async listAvailableAppointmentSlots() {
      slotQueries += 1;
      return [];
    },
  });
  const service = createNativeBookingReadService({
    gameProfile: "wos",
    communityLocationCode: "1001",
    repository,
  });

  assert.equal((await service.getContext()).bookingsOpen, false);
  assert.deepEqual((await service.getAvailability("construction")).slots, []);
  assert.equal(slotQueries, 0);
});

test("missing communities and inactive services fail cleanly", async () => {
  const missingCommunity = createNativeBookingReadService({
    gameProfile: "wos",
    communityLocationCode: "missing",
    repository: fakeRepository({
      async findCommunityByLocationCode() {
        return null;
      },
    }),
  });
  await assert.rejects(
    missingCommunity.getContext(),
    NativeBookingCommunityNotFoundError,
  );

  const inactiveService = createNativeBookingReadService({
    gameProfile: "wos",
    communityLocationCode: "1001",
    repository: fakeRepository({
      async listActiveMinisterServices() {
        return [];
      },
    }),
  });
  await assert.rejects(
    inactiveService.getAvailability("construction"),
    NativeBookingServiceNotFoundError,
  );
});

test("read API returns controlled missing, unavailable, and malformed responses", async () => {
  const unavailableApi = createNativeBookingReadApi({
    resolveRequestContext: (request) => trustedContext(request),
    createRepository: () => null,
    createReadService() {
      throw new Error("not reached");
    },
  });
  const unavailable = await unavailableApi.context(
    new Request("http://localhost/api/v1/booking/context", {
      headers: { host: "localhost:3000" },
    }),
  );
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /postgres|booking_communities/i);

  const failedConnectionApi = createNativeBookingReadApi({
    resolveRequestContext: (request) => trustedContext(request),
    createRepository() {
      throw new Error("postgresql://secret@private-host/internal_table");
    },
    createReadService() {
      throw new Error("not reached");
    },
  });
  const failedConnection = await failedConnectionApi.context(
    new Request("http://localhost/api/v1/booking/context", {
      headers: { host: "localhost:3000" },
    }),
  );
  assert.equal(failedConnection.status, 503);
  assert.doesNotMatch(
    await failedConnection.text(),
    /secret|private-host|internal_table/,
  );

  const missingApi = createNativeBookingReadApi({
    resolveRequestContext: (request) => trustedContext(request, {}),
    createRepository() {
      throw new Error("not reached");
    },
    createReadService() {
      throw new Error("not reached");
    },
  });
  assert.equal(
    (
      await missingApi.context(
        new Request("http://localhost/api/v1/booking/context", {
          headers: { host: "localhost:3000" },
        }),
      )
    ).status,
    404,
  );

  const malformed = await unavailableApi.availability(
    new Request("http://localhost/api/v1/booking/availability?service=invalid", {
      headers: { host: "localhost:3000" },
    }),
  );
  assert.equal(malformed.status, 400);
});

test("read API binds each hostname to its matching repository profile", async () => {
  const repositoryProfiles = [];
  const api = createNativeBookingReadApi({
    resolveRequestContext: (request) => trustedContext(request),
    createRepository(profile) {
      repositoryProfiles.push(profile);
      return { gameProfile: profile };
    },
    createReadService(profile, communityLocationCode) {
      return {
        async getContext() {
          return {
            community: {
              locationCode: communityLocationCode,
              displayName: `Community ${profile}`,
            },
            bookingsOpen: profile === "wos",
            windowState: profile === "wos" ? "open" : "closed",
            requirements: null,
            services: [],
          };
        },
      };
    },
  });

  const wosResponse = await api.context(
    new Request("http://localhost/api/v1/booking/context?game_profile=kingshot", {
      headers: { host: "localhost:3000" },
    }),
  );
  const kingshotResponse = await api.context(
    new Request("http://peggie.localhost/api/v1/booking/context?game_profile=wos", {
      headers: { host: "peggie.localhost:3000" },
    }),
  );

  assert.deepEqual(repositoryProfiles, ["wos", "kingshot"]);
  assert.equal((await wosResponse.json()).brand.gameProfile, "wos");
  assert.equal((await kingshotResponse.json()).brand.gameProfile, "kingshot");
});
