export class ManagerAccessDeniedError extends Error {
  constructor(code = "manager_forbidden", message = "Manager access is not authorized for this community.") {
    super(message);
    this.name = "ManagerAccessDeniedError";
    this.code = code;
  }
}

export class ManagerVerificationUnavailableError extends Error {
  constructor(retryAfterSeconds = null) {
    super("Manager access could not be verified right now.");
    this.name = "ManagerVerificationUnavailableError";
    this.code = "manager_verification_unavailable";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function validateCommunityCode(value) {
  const code = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) {
    throw new ManagerAccessDeniedError("community_not_found", "Community was not found.");
  }
  return code;
}

export function createCommunityManagerAuthorizer({
  gameProfile,
  repository,
  verifyDiscordGuildManager,
}) {
  if (repository.gameProfile !== gameProfile) throw new TypeError("Manager repository profile mismatch.");
  return Object.freeze({
    async authorize(discordSession, rawCommunityCode) {
      if (!discordSession || discordSession.gameProfile !== gameProfile
          || typeof discordSession.discordUser?.id !== "string") {
        throw new ManagerAccessDeniedError();
      }
      const communityCode = validateCommunityCode(rawCommunityCode);
      const scope = await repository.withTransaction(async (session) => {
        const community = await session.findActiveCommunityByLocationCode(communityCode);
        if (!community) return null;
        return { community, guilds: await session.listLinkedManagerGuilds(community.id) };
      });
      if (!scope) throw new ManagerAccessDeniedError("community_not_found", "Community was not found.");

      let unavailable = null;
      for (const guild of scope.guilds) {
        const result = await verifyDiscordGuildManager({
          gameProfile,
          discordUserId: discordSession.discordUser.id,
          guildId: guild.discord_guild_id,
        });
        if (result.status === "authorized") {
          return Object.freeze({
            gameProfile,
            authorizedCommunityId: scope.community.id,
            communityCode: scope.community.location_code,
            discordUserId: discordSession.discordUser.id,
            displayName: discordSession.discordUser.globalName
              ?? discordSession.discordUser.username,
            authorization: Object.freeze({ via: result.via, guildId: result.guildId }),
          });
        }
        if (result.status === "unavailable") unavailable = result;
      }
      if (unavailable) throw new ManagerVerificationUnavailableError(unavailable.retryAfterSeconds);
      throw new ManagerAccessDeniedError();
    },
  });
}
