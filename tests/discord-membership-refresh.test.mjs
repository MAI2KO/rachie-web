import assert from "node:assert/strict";
import test from "node:test";

import { resolveDiscordBotToken } from "../server/auth/auth-config.mjs";
import {
  BookingCommunityMembershipLostError,
  BookingMembershipVerificationUnavailableError,
} from "../server/auth/authenticated-booking-context-core.mjs";
import { createBookingMembershipRefresher } from "../server/auth/booking-membership-refresh-core.mjs";
import { createDiscordGuildMembershipVerifier } from "../server/auth/discord-guild-membership-verifier-core.mjs";

const oldDate = new Date("2026-08-20T10:00:00.000Z");
const currentDate = new Date("2026-08-20T10:10:00.000Z");

function context(overrides = {}) {
  return {
    gameProfile: "wos",
    session: { tokenHash: "session-hash", expiresAt: new Date("2026-08-20T20:00:00Z") },
    discordUser: { id: "123456789012345678" },
    community: {
      id: "00000000-0000-4000-8000-000000000001",
      discordGuildId: "987654321098765432",
      membershipVerifiedAt: oldDate,
    },
    ...overrides,
  };
}

test("bot-token configuration is strictly profile scoped", () => {
  const environment = {
    RACHIE_DISCORD_BOT_TOKEN: "rachie-bot-token",
    PEGGIE_DISCORD_BOT_TOKEN: "peggie-bot-token",
  };
  assert.equal(resolveDiscordBotToken("wos", environment), "rachie-bot-token");
  assert.equal(resolveDiscordBotToken("kingshot", environment), "peggie-bot-token");
  assert.equal(resolveDiscordBotToken("unknown", environment), null);
});

test("Discord verifier uses the profile credential and trusted guild/member path", async () => {
  const calls = [];
  const verifier = createDiscordGuildMembershipVerifier({
    resolveBotToken(profile) {
      return profile === "wos" ? "rachie-token" : "peggie-token";
    },
    async fetchImplementation(url, options) {
      calls.push({ url, authorization: options.headers.Authorization });
      return Response.json({ user: { id: String(url).split("/").at(-1) } });
    },
  });
  assert.deepEqual(await verifier({
    gameProfile: "wos",
    discordUserId: "123456789012345678",
    guildId: "987654321098765432",
  }), { status: "member" });
  assert.deepEqual(await verifier({
    gameProfile: "kingshot",
    discordUserId: "222222222222222222",
    guildId: "333333333333333333",
  }), { status: "member" });
  assert.deepEqual(calls, [
    {
      url: "https://discord.com/api/v10/guilds/987654321098765432/members/123456789012345678",
      authorization: "Bot rachie-token",
    },
    {
      url: "https://discord.com/api/v10/guilds/333333333333333333/members/222222222222222222",
      authorization: "Bot peggie-token",
    },
  ]);
});

test("Discord verifier bounds absence, auth, rate-limit, and malformed responses", async () => {
  for (const [response, expected] of [
    [Response.json({ code: 10007 }, { status: 404 }), { status: "not_member" }],
    [Response.json({ code: 10004 }, { status: 404 }), { status: "unavailable", reason: "missing_guild_access", retryAfterSeconds: null }],
    [Response.json({}, { status: 401 }), { status: "unavailable", reason: "authentication", retryAfterSeconds: null }],
    [Response.json({}, { status: 403 }), { status: "unavailable", reason: "forbidden", retryAfterSeconds: null }],
    [Response.json({}, { status: 429, headers: { "retry-after": "2.2" } }), { status: "unavailable", reason: "rate_limited", retryAfterSeconds: 3 }],
    [Response.json({ retry_after: 4.1 }, { status: 429 }), { status: "unavailable", reason: "rate_limited", retryAfterSeconds: 5 }],
    [Response.json({ unexpected: true }), { status: "unavailable", reason: "malformed_response", retryAfterSeconds: null }],
  ]) {
    const verifier = createDiscordGuildMembershipVerifier({
      resolveBotToken: () => "token",
      fetchImplementation: async () => response,
    });
    assert.deepEqual(await verifier({ gameProfile: "wos", discordUserId: "123", guildId: "456" }), expected);
  }
});

test("Discord verifier converts network failure and timeout into unavailable", async () => {
  const networkVerifier = createDiscordGuildMembershipVerifier({
    resolveBotToken: () => "token",
    fetchImplementation: async () => { throw new Error("network details"); },
  });
  assert.equal((await networkVerifier({ gameProfile: "wos", discordUserId: "123", guildId: "456" })).reason, "network");

  const timeoutVerifier = createDiscordGuildMembershipVerifier({
    resolveBotToken: () => "token",
    timeoutMs: 5,
    fetchImplementation: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  assert.equal((await timeoutVerifier({ gameProfile: "wos", discordUserId: "123", guildId: "456" })).reason, "timeout");
});

test("fresh proof skips Discord and stale member proof refreshes only the trusted relationship", async () => {
  let verifications = 0;
  const updates = [];
  const refresher = createBookingMembershipRefresher({
    now: () => currentDate,
    inFlightRefreshes: new Map(),
    verifyDiscordGuildMembership: async (input) => { verifications += 1; assert.equal(input.guildId, "987654321098765432"); return { status: "member" }; },
    createAuthRepository: (profile) => ({
      async refreshSessionCommunityMembership(...args) {
        updates.push([profile, ...args]);
        return currentDate;
      },
    }),
  });
  const fresh = context({ community: { ...context().community, membershipVerifiedAt: currentDate } });
  assert.equal(await refresher(fresh), fresh);
  assert.equal(verifications, 0);

  const refreshed = await refresher(context());
  assert.equal(verifications, 1);
  assert.equal(refreshed.community.membershipVerifiedAt, currentDate);
  assert.deepEqual(updates, [["wos", "session-hash", "00000000-0000-4000-8000-000000000001", "987654321098765432"]]);
  assert.equal(refreshed.session.expiresAt.getTime(), context().session.expiresAt.getTime());
});

test("confirmed membership loss removes only the trusted relationship and blocks mutation", async () => {
  const removals = [];
  const refresher = createBookingMembershipRefresher({
    now: () => currentDate,
    inFlightRefreshes: new Map(),
    verifyDiscordGuildMembership: async () => ({ status: "not_member" }),
    createAuthRepository: () => ({
      async revokeSessionCommunityMembership(...args) { removals.push(args); return true; },
    }),
  });
  await assert.rejects(refresher(context()), BookingCommunityMembershipLostError);
  assert.deepEqual(removals, [["session-hash", "00000000-0000-4000-8000-000000000001", "987654321098765432"]]);
});

test("unavailable verification fails closed and concurrent stale requests coalesce", async () => {
  let calls = 0;
  let release;
  const verification = new Promise((resolve) => { release = resolve; });
  const refresher = createBookingMembershipRefresher({
    now: () => currentDate,
    inFlightRefreshes: new Map(),
    verifyDiscordGuildMembership: async () => { calls += 1; return verification; },
    createAuthRepository: () => ({ async refreshSessionCommunityMembership() { return currentDate; } }),
  });
  const first = refresher(context());
  const second = refresher(context());
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ status: "member" });
  await Promise.all([first, second]);

  const unavailableRefresher = createBookingMembershipRefresher({
    now: () => currentDate,
    inFlightRefreshes: new Map(),
    verifyDiscordGuildMembership: async () => ({ status: "unavailable", retryAfterSeconds: 8 }),
    createAuthRepository: () => { throw new Error("must not be called"); },
  });
  await assert.rejects(
    unavailableRefresher(context()),
    (error) => error instanceof BookingMembershipVerificationUnavailableError && error.retryAfterSeconds === 8,
  );
});
