import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  resolveAuthSessionSecret,
  resolveDiscordOAuthConfig,
} from "../server/auth/auth-config.mjs";
import {
  AUTH_SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  parseCookie,
  serializeCookie,
} from "../server/auth/cookies.mjs";
import {
  createCsrfToken,
  hashOpaqueToken,
} from "../server/auth/crypto.mjs";
import {
  createDiscordOAuthClient,
  DISCORD_OAUTH_SCOPES,
} from "../server/auth/discord-oauth-client.mjs";
import {
  AuthenticationRejectedError,
  CommunitySelectionRejectedError,
  createAuthService,
  InvalidCsrfError,
} from "../server/auth/service-core.mjs";
import { resolveAuthRequestContextCore } from "../server/auth/request-context-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createFakeRepository(communityFixtures = []) {
  const states = new Map();
  const sessions = new Map();
  return {
    states,
    sessions,
    async createOAuthState(hash, expiresAt) {
      states.set(hash, expiresAt);
    },
    async consumeOAuthState(hash) {
      if (!states.has(hash)) return false;
      states.delete(hash);
      return true;
    },
    async createSession({ tokenHash, expiresAt, user, guildIds }) {
      const communities = communityFixtures
        .filter((community) => guildIds.includes(community.discordGuildId))
        .map((community) => ({ ...community, selected: false }));
      if (communities.length === 1) communities[0].selected = true;
      sessions.set(tokenHash, { user, expiresAt, communities, revoked: false });
    },
    async findSession(tokenHash) {
      const session = sessions.get(tokenHash);
      return session && !session.revoked ? session : null;
    },
    async selectCommunity(tokenHash, locationCode) {
      const session = sessions.get(tokenHash);
      const selected = session?.communities.find(
        (community) => community.locationCode === locationCode,
      );
      if (!session || !selected) return false;
      for (const community of session.communities) community.selected = false;
      selected.selected = true;
      return true;
    },
    async revokeSession(tokenHash) {
      const session = sessions.get(tokenHash);
      if (!session) return false;
      session.revoked = true;
      return true;
    },
  };
}

function createFixtureService(communities = [], gameProfile = "wos") {
  const repository = createFakeRepository(communities);
  const discordClient = {
    authorizationUrl: (state) => `https://discord.test/authorize?state=${state}`,
    async exchangeCode() {
      return "sensitive-access-token";
    },
    async fetchIdentityAndGuilds(accessToken) {
      assert.equal(accessToken, "sensitive-access-token");
      return {
        user: {
          id: "discord-user",
          username: "player",
          globalName: "Player",
          avatarHash: "avatar",
        },
        guildIds: ["guild-one", "guild-two"],
      };
    },
  };
  const sessionSecret = "a".repeat(32);
  const service = createAuthService({
    gameProfile,
    repository,
    discordClient,
    sessionSecret,
    now: () => new Date("2026-08-19T12:00:00.000Z"),
  });
  return { repository, service, sessionSecret };
}

async function login(service) {
  const started = await service.beginLogin();
  return service.completeLogin({
    code: "one-use-code",
    state: started.state,
    cookieState: started.state,
  });
}

test("OAuth configuration and secrets are profile-scoped and fail closed", () => {
  const environment = {
    RACHIE_DISCORD_OAUTH_CLIENT_ID: "rachie-id",
    RACHIE_DISCORD_OAUTH_CLIENT_SECRET: "rachie-secret",
    RACHIE_DISCORD_OAUTH_REDIRECT_URI: "http://localhost/callback",
    PEGGIE_DISCORD_OAUTH_CLIENT_ID: "peggie-id",
    PEGGIE_DISCORD_OAUTH_CLIENT_SECRET: "peggie-secret",
    PEGGIE_DISCORD_OAUTH_REDIRECT_URI: "http://peggie.localhost/callback",
    AUTH_SESSION_SECRET: "x".repeat(32),
  };
  assert.equal(resolveDiscordOAuthConfig("wos", environment).clientId, "rachie-id");
  assert.equal(
    resolveDiscordOAuthConfig("kingshot", environment).clientId,
    "peggie-id",
  );
  assert.equal(resolveDiscordOAuthConfig("invalid", environment), null);
  assert.equal(resolveDiscordOAuthConfig("wos", {}), null);
  assert.equal(resolveAuthSessionSecret({ AUTH_SESSION_SECRET: "short" }), null);
  assert.equal(resolveAuthSessionSecret(environment), "x".repeat(32));
});

test("hostname alone selects the auth profile and request hints cannot override it", () => {
  const brands = {
    localhost: { game: { profile: "wos" } },
    "peggie.localhost": { game: { profile: "kingshot" } },
  };
  const dependencies = {
    normalizeHostname: (host) => String(host).split(":", 1)[0].toLowerCase(),
    resolveKnownBrand: (hostname) => brands[hostname] ?? null,
  };
  const wos = resolveAuthRequestContextCore(
    new Request(
      "http://localhost/api/v1/auth/session?game_profile=kingshot&community_id=bad",
      { headers: { host: "localhost:3000" } },
    ),
    dependencies,
  );
  const kingshot = resolveAuthRequestContextCore(
    new Request("http://peggie.localhost/api/v1/auth/session?game_profile=wos", {
      headers: { host: "peggie.localhost:3000" },
    }),
    dependencies,
  );
  assert.equal(wos.gameProfile, "wos");
  assert.equal(kingshot.gameProfile, "kingshot");
});

test("Discord OAuth uses only identify and guilds and keeps tokens internal", async () => {
  const calls = [];
  const fetchImplementation = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/oauth2/token")) {
      return Response.json({ access_token: "discord-access-token" });
    }
    if (String(url).endsWith("/users/@me")) {
      return Response.json({ id: "user", username: "name" });
    }
    return Response.json([{ id: "guild" }]);
  };
  const client = createDiscordOAuthClient(
    {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost/api/v1/auth/callback",
    },
    { fetchImplementation },
  );
  const authorize = new URL(client.authorizationUrl("oauth-state"));
  assert.deepEqual(DISCORD_OAUTH_SCOPES, ["identify", "guilds"]);
  assert.equal(authorize.searchParams.get("scope"), "identify guilds");
  assert.equal(authorize.searchParams.get("state"), "oauth-state");

  const accessToken = await client.exchangeCode("authorization-code");
  const identity = await client.fetchIdentityAndGuilds(accessToken);
  assert.deepEqual(identity.guildIds, ["guild"]);
  assert.doesNotMatch(JSON.stringify(identity), /discord-access-token|client-secret/);
  assert.match(calls[0].options.headers.Authorization, /^Basic /);
  assert.equal(calls[1].options.headers.Authorization, "Bearer discord-access-token");
});

test("OAuth state is one-use and mismatches fail before code exchange", async () => {
  const { repository, service } = createFixtureService();
  const started = await service.beginLogin();
  assert.equal(repository.states.has(hashOpaqueToken(started.state)), true);
  await assert.rejects(
    service.completeLogin({
      code: "code",
      state: started.state,
      cookieState: "different",
    }),
    AuthenticationRejectedError,
  );
  await service.completeLogin({
    code: "code",
    state: started.state,
    cookieState: started.state,
  });
  await assert.rejects(
    service.completeLogin({
      code: "code",
      state: started.state,
      cookieState: started.state,
    }),
    AuthenticationRejectedError,
  );
  await assert.rejects(
    service.completeLogin({ code: null, state: null, cookieState: null }),
    AuthenticationRejectedError,
  );
});

test("zero, one, and multiple verified communities have explicit selection rules", async () => {
  const none = createFixtureService([]);
  const noneLogin = await login(none.service);
  const publicSession = await none.service.getSession(noneLogin.sessionToken);
  assert.deepEqual(publicSession, {
    authenticated: true,
    gameProfile: "wos",
    user: {
      id: "discord-user",
      username: "player",
      globalName: "Player",
      avatarHash: "avatar",
    },
    communities: [],
    selectedCommunity: null,
    expiresAt: "2026-08-20T00:00:00.000Z",
    csrfToken: createCsrfToken(noneLogin.sessionToken, "wos", none.sessionSecret),
  });
  assert.doesNotMatch(
    JSON.stringify(publicSession),
    /access_token|refresh_token|client-secret|sensitive-access-token/,
  );

  const one = createFixtureService([
    {
      id: "community-one",
      locationCode: "1001",
      displayName: "State 1001",
      discordGuildId: "guild-one",
    },
  ]);
  const oneLogin = await login(one.service);
  assert.equal(
    (await one.service.getSession(oneLogin.sessionToken)).selectedCommunity
      .locationCode,
    "1001",
  );

  const multiple = createFixtureService([
    {
      id: "community-one",
      locationCode: "1001",
      displayName: "State 1001",
      discordGuildId: "guild-one",
    },
    {
      id: "community-two",
      locationCode: "1002",
      displayName: "State 1002",
      discordGuildId: "guild-two",
    },
  ]);
  const multipleLogin = await login(multiple.service);
  const before = await multiple.service.getSession(multipleLogin.sessionToken);
  assert.equal(before.selectedCommunity, null);
  const selected = await multiple.service.selectCommunity({
    sessionToken: multipleLogin.sessionToken,
    csrfToken: before.csrfToken,
    locationCode: "1002",
  });
  assert.equal(selected.selectedCommunity.locationCode, "1002");
  await assert.rejects(
    multiple.service.selectCommunity({
      sessionToken: multipleLogin.sessionToken,
      csrfToken: before.csrfToken,
      locationCode: "unverified",
    }),
    CommunitySelectionRejectedError,
  );
});

test("unknown and invalid session tokens are safely unauthenticated", async () => {
  const { service } = createFixtureService();
  assert.deepEqual(await service.getSession(null), { authenticated: false });
  assert.deepEqual(await service.getSession("invalid-session"), {
    authenticated: false,
  });
});

test("CSRF is profile-bound and logout invalidates the server session", async () => {
  const { service } = createFixtureService();
  const result = await login(service);
  const session = await service.getSession(result.sessionToken);
  await assert.rejects(
    service.logout({
      sessionToken: result.sessionToken,
      csrfToken: createCsrfToken(result.sessionToken, "kingshot", "a".repeat(32)),
    }),
    InvalidCsrfError,
  );
  await service.logout({
    sessionToken: result.sessionToken,
    csrfToken: session.csrfToken,
  });
  assert.deepEqual(await service.getSession(result.sessionToken), {
    authenticated: false,
  });
});

test("cookies are host-only, HttpOnly, SameSite=Lax, and optionally Secure", () => {
  const serialized = serializeCookie(AUTH_SESSION_COOKIE, "session", {
    maxAge: 60,
    secure: true,
  });
  assert.match(serialized, /HttpOnly/);
  assert.match(serialized, /SameSite=Lax/);
  assert.match(serialized, /Secure/);
  assert.doesNotMatch(serialized, /Domain=/i);
  const request = new Request("http://localhost", {
    headers: {
      cookie: `${OAUTH_STATE_COOKIE}=state; ${AUTH_SESSION_COOKIE}=session`,
    },
  });
  assert.equal(parseCookie(request, AUTH_SESSION_COOKIE), "session");
});

test("browser-exposed source contains no OAuth credentials or database URL", () => {
  const exposedRoots = ["app", "brands", "components"];
  const files = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (fullPath.includes(`${path.sep}app${path.sep}api`)) continue;
        collect(fullPath);
      } else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  for (const directory of exposedRoots) collect(path.join(root, directory));
  const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(
    source,
    /DISCORD_OAUTH_CLIENT_SECRET|AUTH_SESSION_SECRET|DATABASE_URL/,
  );
});
