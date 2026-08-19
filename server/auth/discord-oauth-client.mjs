const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN_URL = `${DISCORD_API_BASE}/oauth2/token`;
export const DISCORD_OAUTH_SCOPES = Object.freeze(["identify", "guilds"]);

export class DiscordOAuthError extends Error {
  constructor() {
    super("Discord authentication is temporarily unavailable.");
    this.name = "DiscordOAuthError";
  }
}

function validString(value) {
  return typeof value === "string" && value.length > 0;
}

async function requestJson(fetchImplementation, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new DiscordOAuthError();
    return await response.json();
  } catch (error) {
    if (error instanceof DiscordOAuthError) throw error;
    throw new DiscordOAuthError();
  } finally {
    clearTimeout(timeout);
  }
}

export function createDiscordOAuthClient(
  config,
  { fetchImplementation = fetch, timeoutMs = 8_000 } = {},
) {
  function authorizationUrl(state) {
    const url = new URL(DISCORD_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("scope", DISCORD_OAUTH_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", config.redirectUri);
    return url.toString();
  }

  async function exchangeCode(code) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    });
    const basicCredentials = Buffer.from(
      `${config.clientId}:${config.clientSecret}`,
      "utf8",
    ).toString("base64");
    const payload = await requestJson(
      fetchImplementation,
      DISCORD_TOKEN_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicCredentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
      timeoutMs,
    );
    if (!validString(payload?.access_token)) throw new DiscordOAuthError();
    return payload.access_token;
  }

  async function fetchIdentityAndGuilds(accessToken) {
    const options = { headers: { Authorization: `Bearer ${accessToken}` } };
    const [user, guilds] = await Promise.all([
      requestJson(fetchImplementation, `${DISCORD_API_BASE}/users/@me`, options, timeoutMs),
      requestJson(
        fetchImplementation,
        `${DISCORD_API_BASE}/users/@me/guilds?limit=200`,
        options,
        timeoutMs,
      ),
    ]);
    if (!validString(user?.id) || !validString(user?.username)) {
      throw new DiscordOAuthError();
    }
    if (!Array.isArray(guilds) || guilds.some((guild) => !validString(guild?.id))) {
      throw new DiscordOAuthError();
    }
    return {
      user: {
        id: user.id,
        username: user.username,
        globalName: typeof user.global_name === "string" ? user.global_name : null,
        avatarHash: typeof user.avatar === "string" ? user.avatar : null,
      },
      guildIds: [...new Set(guilds.map((guild) => guild.id))],
    };
  }

  return Object.freeze({ authorizationUrl, exchangeCode, fetchIdentityAndGuilds });
}
