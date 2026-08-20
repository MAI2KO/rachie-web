const PROFILE_ENVIRONMENT = Object.freeze({
  wos: Object.freeze({
    clientId: "RACHIE_DISCORD_OAUTH_CLIENT_ID",
    clientSecret: "RACHIE_DISCORD_OAUTH_CLIENT_SECRET",
    redirectUri: "RACHIE_DISCORD_OAUTH_REDIRECT_URI",
  }),
  kingshot: Object.freeze({
    clientId: "PEGGIE_DISCORD_OAUTH_CLIENT_ID",
    clientSecret: "PEGGIE_DISCORD_OAUTH_CLIENT_SECRET",
    redirectUri: "PEGGIE_DISCORD_OAUTH_REDIRECT_URI",
  }),
});

const PROFILE_BOT_TOKEN_ENVIRONMENT = Object.freeze({
  wos: "RACHIE_DISCORD_BOT_TOKEN",
  kingshot: "PEGGIE_DISCORD_BOT_TOKEN",
});

function readNonEmpty(environment, name) {
  const value = String(environment[name] ?? "").trim();
  return value || null;
}

export function resolveDiscordOAuthConfig(gameProfile, environment) {
  const names = PROFILE_ENVIRONMENT[gameProfile];
  if (!names) return null;

  const clientId = readNonEmpty(environment, names.clientId);
  const clientSecret = readNonEmpty(environment, names.clientSecret);
  const redirectUri = readNonEmpty(environment, names.redirectUri);
  if (!clientId || !clientSecret || !redirectUri) return null;

  return Object.freeze({ clientId, clientSecret, redirectUri });
}

export function resolveDiscordBotToken(gameProfile, environment) {
  const name = PROFILE_BOT_TOKEN_ENVIRONMENT[gameProfile];
  return name ? readNonEmpty(environment, name) : null;
}

export function resolveAuthSessionSecret(environment) {
  const secret = readNonEmpty(environment, "AUTH_SESSION_SECRET");
  return secret && Buffer.byteLength(secret, "utf8") >= 32 ? secret : null;
}
