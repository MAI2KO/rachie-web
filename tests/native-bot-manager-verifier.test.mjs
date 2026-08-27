import assert from "node:assert/strict";
import test from "node:test";

import { createNativeBotManagerVerifier } from "../server/auth/native-bot-manager-verifier-core.mjs";

const userId = "200000000000000002";
const guildId = "300000000000000003";
const otherGuildId = "400000000000000004";
const secret = "local-test-secret-with-at-least-32-characters";

function config(profile) {
  return { profile, baseUrl: `https://${profile}.bot.example`, secret };
}

function fallback(result = { status: "denied", reason: "insufficient_permissions" }) {
  const calls = [];
  return {
    calls,
    verify: async (input) => {
      calls.push(input);
      return result;
    },
  };
}

test("native bot decisions add and remove website role access without session caching", async () => {
  let canManage = false;
  const requests = [];
  const ownerAdmin = fallback();
  const verify = createNativeBotManagerVerifier({
    resolveIntegrationConfig: config,
    verifyDiscordOwnerOrAdministrator: ownerAdmin.verify,
    now: () => 1_800_000_000_000,
    createNonce: () => "abcdefghijklmnop",
    logger: { warn() {} },
    fetchImplementation: async (url, options) => {
      requests.push({ url, options });
      return Response.json(canManage
        ? { ok: true, canManage: true, via: "bot_manager_role" }
        : { ok: true, canManage: false });
    },
  });

  assert.equal((await verify({ gameProfile: "wos", discordUserId: userId, guildId })).status, "denied");
  canManage = true;
  assert.equal((await verify({ gameProfile: "wos", discordUserId: userId, guildId })).status, "authorized");
  canManage = false;
  assert.equal((await verify({ gameProfile: "wos", discordUserId: userId, guildId })).status, "denied");
  assert.equal(requests.length, 3);
  assert.equal(ownerAdmin.calls.length, 0);
  assert.equal(requests.every(({ options }) => options.cache === "no-store"), true);
});

test("WOS and Kingshot use their matching signed bot instance and exact guild", async () => {
  const requests = [];
  const verify = createNativeBotManagerVerifier({
    resolveIntegrationConfig: config,
    verifyDiscordOwnerOrAdministrator: fallback().verify,
    now: () => 1_800_000_000_000,
    createNonce: () => "abcdefghijklmnop",
    logger: { warn() {} },
    fetchImplementation: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ ok: true, canManage: false });
    },
  });
  await verify({ gameProfile: "wos", discordUserId: userId, guildId });
  await verify({ gameProfile: "kingshot", discordUserId: userId, guildId: otherGuildId });
  assert.equal(new URL(requests[0].url).host, "wos.bot.example");
  assert.equal(new URL(requests[1].url).host, "kingshot.bot.example");
  assert.match(new URL(requests[0].url).pathname, new RegExp(`/guild/${guildId}/user/${userId}$`));
  assert.match(new URL(requests[1].url).pathname, new RegExp(`/guild/${otherGuildId}/user/${userId}$`));
  assert.equal(requests[0].options.headers["x-alliance-events-profile"], "wos");
  assert.equal(requests[1].options.headers["x-alliance-events-profile"], "kingshot");
  assert.notEqual(requests[0].options.headers["x-alliance-events-signature"],
    requests[1].options.headers["x-alliance-events-signature"]);
});

test("bot lookup failures fail closed for role-only users but preserve owner and Administrator", async () => {
  for (const via of ["owner", "administrator"]) {
    const ownerAdmin = fallback({ status: "authorized", via: "administrator", guildId });
    const verify = createNativeBotManagerVerifier({
      resolveIntegrationConfig: config,
      verifyDiscordOwnerOrAdministrator: ownerAdmin.verify,
      logger: { warn() {} },
      fetchImplementation: async () => Response.json(
        { ok: false, code: "manager_verification_unavailable" }, { status: 503 }),
    });
    const result = await verify({ gameProfile: "wos", discordUserId: userId, guildId });
    assert.equal(result.status, "authorized", `${via} fallback remains authorized`);
    assert.equal(ownerAdmin.calls[0].managerRoleId, null);
  }

  const roleOnly = fallback();
  const verifyRoleOnly = createNativeBotManagerVerifier({
    resolveIntegrationConfig: () => null,
    verifyDiscordOwnerOrAdministrator: roleOnly.verify,
    logger: { warn() {} },
  });
  assert.equal((await verifyRoleOnly({ gameProfile: "wos",
    discordUserId: userId, guildId })).status, "unavailable");
});

test("unrelated, cross-guild, and malformed bot decisions never authorize", async () => {
  const verify = createNativeBotManagerVerifier({
    resolveIntegrationConfig: config,
    verifyDiscordOwnerOrAdministrator: fallback().verify,
    logger: { warn() {} },
    fetchImplementation: async (url) => Response.json({
      ok: true,
      canManage: new URL(url).pathname.includes(`/guild/${guildId}/`),
      via: "bot_manager_role",
    }),
  });
  assert.equal((await verify({ gameProfile: "wos", discordUserId: userId, guildId })).status,
    "authorized");
  assert.equal((await verify({ gameProfile: "wos", discordUserId: userId,
    guildId: otherGuildId })).status, "denied");
  assert.equal((await verify({ gameProfile: "other", discordUserId: userId, guildId })).status,
    "unavailable");
});
