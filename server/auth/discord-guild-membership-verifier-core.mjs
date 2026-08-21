const DISCORD_API_BASE = "https://discord.com/api/v10";
const UNKNOWN_MEMBER_CODE = 10007;
const DEFAULT_TIMEOUT_MS = 5_000;
const DISCORD_ADMINISTRATOR_PERMISSION = 1n << 3n;

const unavailable = (reason, retryAfterSeconds = null) =>
  Object.freeze({ status: "unavailable", reason, retryAfterSeconds });

function boundedRetryAfter(response, body) {
  const header = response.headers.get("retry-after");
  const value = Number(header ?? body?.retry_after);
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.ceil(value), 3600) : null;
}

async function boundedJson(response) {
  try {
    const body = await response.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

export function createDiscordGuildMembershipVerifier({
  resolveBotToken,
  fetchImplementation = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return async function verifyDiscordGuildMembership({
    gameProfile,
    discordUserId,
    guildId,
  }) {
    const token = resolveBotToken(gameProfile);
    if (!token) return unavailable("configuration");
    if (!/^\d{1,20}$/.test(discordUserId) || !/^\d{1,20}$/.test(guildId)) {
      return unavailable("invalid_identifier");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(
        `${DISCORD_API_BASE}/guilds/${guildId}/members/${discordUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bot ${token}` },
          signal: controller.signal,
        },
      );
      if (response.status === 200) {
        const member = await boundedJson(response);
        return member?.user?.id === discordUserId
          ? Object.freeze({ status: "member" })
          : unavailable("malformed_response");
      }
      if (response.status === 404) {
        const body = await boundedJson(response);
        return body?.code === UNKNOWN_MEMBER_CODE
          ? Object.freeze({ status: "not_member" })
          : unavailable("missing_guild_access");
      }
      if (response.status === 429) {
        const body = await boundedJson(response);
        return unavailable("rate_limited", boundedRetryAfter(response, body));
      }
      if (response.status === 401) return unavailable("authentication");
      if (response.status === 403) return unavailable("forbidden");
      return unavailable("unexpected_response");
    } catch (error) {
      return unavailable(error?.name === "AbortError" ? "timeout" : "network");
    } finally {
      clearTimeout(timeout);
    }
  };
}

function hasAdministratorPermission(roles, memberRoleIds, guildId) {
  const applicable = new Set([guildId, ...memberRoleIds]);
  return roles.some((role) => {
    if (!applicable.has(role?.id) || typeof role?.permissions !== "string") return false;
    try {
      return (BigInt(role.permissions) & DISCORD_ADMINISTRATOR_PERMISSION) !== 0n;
    } catch {
      return false;
    }
  });
}

export function createDiscordGuildManagerVerifier({
  resolveBotToken,
  fetchImplementation = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return async function verifyDiscordGuildManager({
    gameProfile,
    discordUserId,
    guildId,
    managerRoleId,
  }) {
    const token = resolveBotToken(gameProfile);
    if (!token) return unavailable("configuration");
    if (!/^\d{1,20}$/.test(discordUserId) || !/^\d{1,20}$/.test(guildId)
        || (managerRoleId !== null && managerRoleId !== undefined && !/^\d{1,20}$/.test(managerRoleId))) {
      return unavailable("invalid_identifier");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const options = {
      method: "GET",
      headers: { Authorization: `Bot ${token}` },
      signal: controller.signal,
    };
    try {
      const memberResponse = await fetchImplementation(
        `${DISCORD_API_BASE}/guilds/${guildId}/members/${discordUserId}`,
        options,
      );
      if (memberResponse.status === 404) return Object.freeze({ status: "denied", reason: "not_member" });
      if (memberResponse.status === 429) {
        const body = await boundedJson(memberResponse);
        return unavailable("rate_limited", boundedRetryAfter(memberResponse, body));
      }
      if (!memberResponse.ok) return unavailable(
        memberResponse.status === 401 ? "authentication"
          : memberResponse.status === 403 ? "forbidden" : "unexpected_response",
      );
      const member = await boundedJson(memberResponse);
      if (member?.user?.id !== discordUserId || !Array.isArray(member.roles)
          || member.roles.some((roleId) => typeof roleId !== "string")) {
        return unavailable("malformed_response");
      }
      if (managerRoleId && member.roles.includes(managerRoleId)) {
        return Object.freeze({ status: "authorized", via: "bot_manager_role", guildId });
      }

      const [rolesResponse, guildResponse] = await Promise.all([
        fetchImplementation(`${DISCORD_API_BASE}/guilds/${guildId}/roles`, options),
        fetchImplementation(`${DISCORD_API_BASE}/guilds/${guildId}`, options),
      ]);
      if (rolesResponse.status === 429 || guildResponse.status === 429) {
        const response = rolesResponse.status === 429 ? rolesResponse : guildResponse;
        const body = await boundedJson(response);
        return unavailable("rate_limited", boundedRetryAfter(response, body));
      }
      if (!rolesResponse.ok || !guildResponse.ok) return unavailable("guild_permissions");
      const [roles, guild] = await Promise.all([boundedJson(rolesResponse), boundedJson(guildResponse)]);
      if (!Array.isArray(roles) || typeof guild?.owner_id !== "string") {
        return unavailable("malformed_response");
      }
      if (guild.owner_id === discordUserId
          || hasAdministratorPermission(roles, member.roles, guildId)) {
        return Object.freeze({ status: "authorized", via: "administrator", guildId });
      }
      return Object.freeze({ status: "denied", reason: "insufficient_permissions" });
    } catch (error) {
      return unavailable(error?.name === "AbortError" ? "timeout" : "network");
    } finally {
      clearTimeout(timeout);
    }
  };
}
