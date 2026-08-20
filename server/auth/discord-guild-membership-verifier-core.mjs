const DISCORD_API_BASE = "https://discord.com/api/v10";
const UNKNOWN_MEMBER_CODE = 10007;
const DEFAULT_TIMEOUT_MS = 5_000;

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
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
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
