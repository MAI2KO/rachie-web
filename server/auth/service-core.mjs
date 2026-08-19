import {
  createCsrfToken,
  createOpaqueToken,
  hashOpaqueToken,
  safelyEqual,
  verifyCsrfToken,
} from "./crypto.mjs";

export const OAUTH_STATE_LIFETIME_SECONDS = 10 * 60;
export const AUTH_SESSION_LIFETIME_SECONDS = 12 * 60 * 60;

export class AuthenticationRejectedError extends Error {
  constructor() {
    super("Authentication could not be completed.");
    this.name = "AuthenticationRejectedError";
  }
}

export class InvalidSessionError extends Error {
  constructor() {
    super("A valid session is required.");
    this.name = "InvalidSessionError";
  }
}

export class InvalidCsrfError extends Error {
  constructor() {
    super("The request could not be verified.");
    this.name = "InvalidCsrfError";
  }
}

export class CommunitySelectionRejectedError extends Error {
  constructor() {
    super("That community is not available for this session.");
    this.name = "CommunitySelectionRejectedError";
  }
}

function futureDate(now, seconds) {
  return new Date(now().getTime() + seconds * 1000);
}

function publicSession(session, csrfToken, gameProfile) {
  const communities = session.communities.map((community) => ({
    locationCode: community.locationCode,
    displayName: community.displayName,
  }));
  const selected = session.communities.find((community) => community.selected);
  return {
    authenticated: true,
    gameProfile,
    user: {
      id: session.user.id,
      username: session.user.username,
      globalName: session.user.globalName,
      avatarHash: session.user.avatarHash,
    },
    communities,
    selectedCommunity: selected
      ? {
          locationCode: selected.locationCode,
          displayName: selected.displayName,
        }
      : null,
    expiresAt:
      session.expiresAt instanceof Date
        ? session.expiresAt.toISOString()
        : String(session.expiresAt),
    csrfToken,
  };
}

export function createAuthService({
  gameProfile,
  repository,
  discordClient,
  sessionSecret,
  now = () => new Date(),
}) {
  async function requireSession(sessionToken) {
    if (typeof sessionToken !== "string" || !sessionToken) {
      throw new InvalidSessionError();
    }
    const session = await repository.findSession(hashOpaqueToken(sessionToken));
    if (!session) throw new InvalidSessionError();
    return session;
  }

  function requireCsrf(sessionToken, suppliedCsrfToken) {
    if (
      !verifyCsrfToken(
        suppliedCsrfToken,
        sessionToken,
        gameProfile,
        sessionSecret,
      )
    ) {
      throw new InvalidCsrfError();
    }
  }

  return Object.freeze({
    async beginLogin() {
      const state = createOpaqueToken();
      await repository.createOAuthState(
        hashOpaqueToken(state),
        futureDate(now, OAUTH_STATE_LIFETIME_SECONDS),
      );
      return { state, authorizationUrl: discordClient.authorizationUrl(state) };
    },

    async completeLogin({ code, state, cookieState }) {
      if (
        typeof code !== "string" ||
        !code ||
        !safelyEqual(state, cookieState) ||
        !(await repository.consumeOAuthState(hashOpaqueToken(state)))
      ) {
        throw new AuthenticationRejectedError();
      }

      const accessToken = await discordClient.exchangeCode(code);
      const identity = await discordClient.fetchIdentityAndGuilds(accessToken);
      const sessionToken = createOpaqueToken();
      await repository.createSession({
        tokenHash: hashOpaqueToken(sessionToken),
        expiresAt: futureDate(now, AUTH_SESSION_LIFETIME_SECONDS),
        user: identity.user,
        guildIds: identity.guildIds,
      });
      return { sessionToken };
    },

    async getSession(sessionToken) {
      try {
        const session = await requireSession(sessionToken);
        return publicSession(
          session,
          createCsrfToken(sessionToken, gameProfile, sessionSecret),
          gameProfile,
        );
      } catch (error) {
        if (error instanceof InvalidSessionError) {
          return { authenticated: false };
        }
        throw error;
      }
    },

    async selectCommunity({ sessionToken, csrfToken, locationCode }) {
      await requireSession(sessionToken);
      requireCsrf(sessionToken, csrfToken);
      if (
        typeof locationCode !== "string" ||
        !locationCode.trim() ||
        !(await repository.selectCommunity(
          hashOpaqueToken(sessionToken),
          locationCode.trim(),
        ))
      ) {
        throw new CommunitySelectionRejectedError();
      }
      const session = await requireSession(sessionToken);
      return publicSession(
        session,
        createCsrfToken(sessionToken, gameProfile, sessionSecret),
        gameProfile,
      );
    },

    async logout({ sessionToken, csrfToken }) {
      await requireSession(sessionToken);
      requireCsrf(sessionToken, csrfToken);
      await repository.revokeSession(hashOpaqueToken(sessionToken));
    },
  });
}
