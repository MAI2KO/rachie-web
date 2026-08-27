import { allianceEventsRequestHeaders } from "../alliance-events/auth-core.mjs";

const PROFILE_SET = new Set(["wos", "kingshot"]);

const unavailable = (reason, retryAfterSeconds = null) =>
  Object.freeze({ status: "unavailable", reason, retryAfterSeconds });

function retryAfter(response) {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.ceil(value), 3600) : null;
}

export function createNativeBotManagerVerifier({
  resolveIntegrationConfig,
  verifyDiscordOwnerOrAdministrator,
  fetchImplementation = fetch,
  now = Date.now,
  createNonce = undefined,
  logger = console,
}) {
  return async function verifyNativeBotManager({ gameProfile, discordUserId, guildId }) {
    if (!PROFILE_SET.has(gameProfile) || !/^\d{15,22}$/.test(discordUserId)
        || !/^\d{15,22}$/.test(guildId)) {
      return unavailable("invalid_identifier");
    }

    let primary = unavailable("configuration");
    const config = resolveIntegrationConfig(gameProfile);
    if (config) {
      const path = `/internal/v1/manager-authorization/guild/${guildId}/user/${discordUserId}`;
      try {
        const response = await fetchImplementation(`${config.baseUrl}${path}`, {
          method: "GET",
          headers: allianceEventsRequestHeaders({
            secret: config.secret,
            profile: gameProfile,
            method: "GET",
            path,
            now,
            ...(createNonce ? { createNonce } : {}),
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        if (response.status === 200) {
          const body = await response.json();
          if (body?.ok === true && body.canManage === false) {
            return Object.freeze({ status: "denied", reason: "insufficient_permissions" });
          }
          if (body?.ok === true && body.canManage === true
              && ["administrator", "bot_manager_role"].includes(body.via)) {
            return Object.freeze({ status: "authorized", via: body.via, guildId });
          }
          primary = unavailable("malformed_response");
        } else {
          primary = unavailable(response.status === 503 ? "bot_verification_unavailable"
            : "unexpected_response", retryAfter(response));
        }
      } catch (error) {
        primary = unavailable(error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "timeout" : "network");
      }
    }

    logger.warn("native_bot_manager_verification_unavailable", {
      gameProfile,
      reason: primary.reason,
    });
    const fallback = await verifyDiscordOwnerOrAdministrator({
      gameProfile,
      discordUserId,
      guildId,
      managerRoleId: null,
    });
    if (fallback.status === "authorized") return fallback;
    return unavailable(primary.reason, primary.retryAfterSeconds);
  };
}
