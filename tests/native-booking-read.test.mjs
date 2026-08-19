import assert from "node:assert/strict";
import test from "node:test";

import {
  BookingAuthenticationRequiredError,
  BookingCommunitySelectionRequiredError,
  BookingMembershipRefreshRequiredError,
  assertFutureBookingMutationMembershipFresh,
  isMembershipFresh,
  resolveAuthenticatedBookingContextCore,
} from "../server/auth/authenticated-booking-context-core.mjs";
import { hashOpaqueToken } from "../server/auth/crypto.mjs";
import { resolveNativeBookingCommunityCode } from "../server/native-booking/community-config.mjs";
import { createNativeBookingReadApi } from "../server/native-booking/read-api-core.mjs";
import {
  createNativeBookingReadService,
  NativeBookingCommunityNotFoundError,
  NativeBookingParticipantAmbiguousError,
} from "../server/native-booking/read-service-core.mjs";
import { createRateLimiter } from "../server/rate-limit/limiter-core.mjs";
import { RATE_LIMIT_POLICIES } from "../server/rate-limit/policies.mjs";

const now = new Date("2026-08-19T12:00:00.000Z");

const brands = {
  wos: {
    displayName: "R.A.C.H.I.E",
    shortName: "RACHIE",
    description: "WOS",
    game: { name: "Whiteout Survival", profile: "wos" },
    theme: { id: "whiteout", colors: { accent: "#2563eb" } },
  },
  kingshot: {
    displayName: "P.E.G.G.I.E",
    shortName: "PEGGIE",
    description: "Kingshot",
    game: { name: "Kingshot", profile: "kingshot" },
    theme: { id: "kingshot", colors: { accent: "#b45309" } },
  },
};

function authSession(profile, overrides = {}) {
  return {
    user: {
      id: `${profile}-discord-user`,
      username: `${profile}-user`,
      globalName: null,
      avatarHash: null,
    },
    expiresAt: new Date("2026-08-19T18:00:00.000Z"),
    communities: [
      {
        id: `${profile}-community-id`,
        locationCode: profile === "wos" ? "1001" : "2002",
        displayName: profile === "wos" ? "State 1001" : "Kingdom 2002",
        discordGuildId: `${profile}-guild-id`,
        verifiedAt: new Date("2026-08-19T11:45:00.000Z"),
        selected: true,
      },
    ],
    ...overrides,
  };
}

async function resolveTrusted(request, sessions = {}) {
  return resolveAuthenticatedBookingContextCore(request, {
    resolveHostContext(currentRequest) {
      const hostname = currentRequest.headers.get("host")?.split(":", 1)[0];
      const gameProfile = hostname === "peggie.localhost" ? "kingshot" : "wos";
      return { hostname, gameProfile, brand: brands[gameProfile] };
    },
    readSessionToken: (currentRequest) =>
      currentRequest.headers.get("x-test-session"),
    hashSessionToken: hashOpaqueToken,
    createAuthRepository(profile) {
      return {
        async findSession() {
          return sessions[profile] ?? null;
        },
      };
    },
    now: () => now,
  });
}

function fakeRepository(overrides = {}, gameProfile = "wos") {
  const session = {
    async findCommunityById(communityId) {
      return {
        id: communityId,
        location_code: gameProfile === "wos" ? "1001" : "2002",
        display_name: gameProfile === "wos" ? "State 1001" : "Kingdom 2002",
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
      return [{ service_code: "construction", booking_date: "2026-08-20" }];
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
        { id: "slot-two", display_time_label: "00:30", ordinal: 2 },
        { id: "slot-one", display_time_label: "00:00", ordinal: 1 },
      ];
    },
    async listActiveParticipantsByDiscordUser() {
      return [];
    },
    async listConfirmedBookingsForParticipant() {
      return [];
    },
    ...overrides,
  };
  return {
    gameProfile,
    async withTransaction(work) {
      return work(session);
    },
  };
}

function readService(repository = fakeRepository(), contextOverrides = {}) {
  return createNativeBookingReadService({
    gameProfile: repository.gameProfile,
    communityId: `${repository.gameProfile}-community-id`,
    repository,
    ...contextOverrides,
  });
}

function trustedApiContext(profile = "wos") {
  return {
    brand: brands[profile],
    hostname: profile === "wos" ? "localhost" : "peggie.localhost",
    gameProfile: profile,
    session: { tokenHash: `${profile}-session-hash` },
    discordUser: { id: `${profile}-discord-user` },
    community: {
      id: `${profile}-community-id`,
      locationCode: profile === "wos" ? "1001" : "2002",
      displayName: profile === "wos" ? "State 1001" : "Kingdom 2002",
    },
  };
}

function apiWith(overrides = {}) {
  return createNativeBookingReadApi({
    async resolveAuthenticatedContext() {
      return trustedApiContext();
    },
    async consumeReadRateLimit() {
      return { allowed: true, retryAfterSeconds: 1 };
    },
    createRepository(profile) {
      return fakeRepository({}, profile);
    },
    createReadService(context, repository) {
      return readService(repository, { communityId: context.community.id });
    },
    ...overrides,
  });
}

test("environment community codes remain profile-scoped development helpers", () => {
  const environment = {
    WOS_NATIVE_BOOKING_COMMUNITY_CODE: " 1001 ",
    KINGSHOT_NATIVE_BOOKING_COMMUNITY_CODE: "2002",
  };
  assert.equal(resolveNativeBookingCommunityCode("wos", environment), "1001");
  assert.equal(resolveNativeBookingCommunityCode("kingshot", environment), "2002");
  assert.equal(resolveNativeBookingCommunityCode("unknown", environment), null);
});

test("trusted context binds hostname, session identity, Discord user, guild, and community", async () => {
  const wos = await resolveTrusted(
    new Request("http://localhost/api/v1/booking/context?game_profile=kingshot&community_id=hostile", {
      headers: { host: "localhost:3000", "x-test-session": "wos-token" },
    }),
    { wos: authSession("wos"), kingshot: authSession("kingshot") },
  );
  const kingshot = await resolveTrusted(
    new Request("http://peggie.localhost/api/v1/booking/context?game_profile=wos", {
      headers: { host: "peggie.localhost:3000", "x-test-session": "kingshot-token" },
    }),
    { wos: authSession("wos"), kingshot: authSession("kingshot") },
  );
  assert.equal(wos.gameProfile, "wos");
  assert.equal(wos.community.locationCode, "1001");
  assert.equal(wos.community.discordGuildId, "wos-guild-id");
  assert.equal(wos.discordUser.id, "wos-discord-user");
  assert.equal(wos.session.tokenHash, hashOpaqueToken("wos-token"));
  assert.equal(kingshot.gameProfile, "kingshot");
  assert.equal(kingshot.community.locationCode, "2002");
});

test("missing, revoked, unselected, and stale sessions fail closed", async () => {
  const request = new Request("http://localhost/api/v1/booking/context", {
    headers: { host: "localhost:3000", "x-test-session": "token" },
  });
  await assert.rejects(resolveTrusted(request, {}), BookingAuthenticationRequiredError);
  await assert.rejects(
    resolveTrusted(request, {
      wos: authSession("wos", { communities: [] }),
    }),
    BookingCommunitySelectionRequiredError,
  );
  await assert.rejects(
    resolveTrusted(request, {
      wos: authSession("wos", {
        communities: [
          {
            ...authSession("wos").communities[0],
            verifiedAt: new Date("2026-08-19T11:00:00.000Z"),
          },
        ],
      }),
    }),
    BookingMembershipRefreshRequiredError,
  );
  assert.equal(
    isMembershipFresh("2026-08-19T11:30:00.000Z", now, 30 * 60),
    true,
  );
  assert.equal(
    isMembershipFresh("2026-08-19T11:29:59.000Z", now, 30 * 60),
    false,
  );
  assert.throws(
    () =>
      assertFutureBookingMutationMembershipFresh(
        {
          community: {
            membershipVerifiedAt: "2026-08-19T11:54:59.000Z",
          },
        },
        now,
      ),
    BookingMembershipRefreshRequiredError,
  );
});

test("read service uses the trusted community ID and preserves date strings", async () => {
  let communityLookup;
  const service = readService(
    fakeRepository({
      async findCommunityById(id) {
        communityLookup = id;
        return {
          id,
          location_code: "1001",
          display_name: "State 1001",
          status: "active",
          bookings_open: true,
        };
      },
    }),
  );
  const context = await service.getContext();
  const availability = await service.getAvailability("construction");
  assert.equal(communityLookup, "wos-community-id");
  assert.equal(context.services[0].date, "2026-08-20");
  assert.equal(availability.date, "2026-08-20");
  assert.deepEqual(availability.slots, [
    { slotId: "slot-one", displayTime: "00:00", ordinal: 1 },
    { slotId: "slot-two", displayTime: "00:30", ordinal: 2 },
  ]);
});

test("participant ownership uses Discord identity and handles no or duplicate registration", async () => {
  let lookedUpDiscordUser;
  const owned = readService(
    fakeRepository({
      async listActiveParticipantsByDiscordUser(communityId, discordUserId) {
        assert.equal(communityId, "wos-community-id");
        lookedUpDiscordUser = discordUserId;
        return [
          {
            id: "participant-owned",
            player_id: "player-owned",
            in_game_name: "Owned Player",
            alliance: "OWN",
          },
        ];
      },
      async listConfirmedBookingsForParticipant(communityId, participantId) {
        assert.equal(communityId, "wos-community-id");
        assert.equal(participantId, "participant-owned");
        return [
          {
            id: "booking-owned",
            service_code: "construction",
            booking_date: "2026-08-20",
            display_time_label_snapshot: "00:00",
            ordinal: 0,
          },
        ];
      },
    }),
  );
  const result = await owned.getParticipantBookingsForDiscordUser("trusted-discord");
  assert.equal(lookedUpDiscordUser, "trusted-discord");
  assert.equal(result.registration.playerId, "player-owned");
  assert.doesNotMatch(JSON.stringify(result), /other-user|other-player/);

  assert.deepEqual(
    await readService().getParticipantBookingsForDiscordUser("unregistered"),
    { registration: { status: "unregistered" }, bookings: [] },
  );

  const duplicate = readService(
    fakeRepository({
      async listActiveParticipantsByDiscordUser() {
        return [{ id: "one" }, { id: "two" }];
      },
    }),
  );
  await assert.rejects(
    duplicate.getParticipantBookingsForDiscordUser("duplicate"),
    NativeBookingParticipantAmbiguousError,
  );
});

test("authenticated read API returns controlled auth, selection, stale, and rate errors", async () => {
  const request = new Request("http://localhost/api/v1/booking/context");
  const unauthenticated = apiWith({
    async resolveAuthenticatedContext() {
      throw new BookingAuthenticationRequiredError();
    },
  });
  assert.equal((await unauthenticated.context(request)).status, 401);

  const unselected = apiWith({
    async resolveAuthenticatedContext() {
      throw new BookingCommunitySelectionRequiredError();
    },
  });
  assert.equal((await unselected.context(request)).status, 409);

  const stale = apiWith({
    async resolveAuthenticatedContext() {
      throw new BookingMembershipRefreshRequiredError();
    },
  });
  const staleResponse = await stale.context(request);
  assert.equal(staleResponse.status, 401);
  assert.equal((await staleResponse.json()).code, "membership_refresh_required");

  const limited = apiWith({
    async consumeReadRateLimit() {
      return { allowed: false, retryAfterSeconds: 17 };
    },
  });
  const limitedResponse = await limited.context(request);
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers.get("retry-after"), "17");
});

test("booking me returns only the trusted user's selected-community data", async () => {
  let requestedUser;
  const api = apiWith({
    createReadService() {
      return {
        async getParticipantBookingsForDiscordUser(discordUserId) {
          requestedUser = discordUserId;
          return {
            registration: { status: "unregistered" },
            bookings: [],
          };
        },
      };
    },
  });
  const response = await api.me(
    new Request("http://localhost/api/v1/booking/me?discord_user_id=other&player_id=other"),
  );
  assert.equal(response.status, 200);
  assert.equal(requestedUser, "wos-discord-user");
  assert.deepEqual(await response.json(), {
    community: { locationCode: "1001", displayName: "State 1001" },
    registration: { status: "unregistered" },
    bookings: [],
  });
});

test("missing selected database community fails safely", async () => {
  const service = readService(
    fakeRepository({
      async findCommunityById() {
        return null;
      },
    }),
  );
  await assert.rejects(service.getContext(), NativeBookingCommunityNotFoundError);
});

test("rate limiter uses predictable fixed windows and policy isolation", async () => {
  const calls = [];
  const counts = new Map();
  const repository = {
    async consume(input) {
      calls.push(input);
      const key = `${input.policyCode}:${input.subjectHash}:${input.windowStartedAt.toISOString()}`;
      const next = (counts.get(key) ?? 0) + 1;
      if (next > input.limit) return null;
      counts.set(key, next);
      return next;
    },
  };
  const limiter = createRateLimiter({
    gameProfile: "wos",
    repository,
    secret: "s".repeat(32),
    now: () => new Date("2026-08-19T12:00:30.000Z"),
  });
  const policy = { code: "test", limit: 2, windowSeconds: 60 };
  assert.deepEqual(await limiter.consume(policy, "subject"), {
    allowed: true,
    limit: 2,
    remaining: 1,
    retryAfterSeconds: 30,
  });
  assert.equal((await limiter.consume(policy, "subject")).allowed, true);
  assert.equal((await limiter.consume(policy, "subject")).allowed, false);
  assert.match(calls[0].subjectHash, /^[0-9a-f]{64}$/);
  assert.equal(RATE_LIMIT_POLICIES.futureBookingMutation.limit, 10);
});
