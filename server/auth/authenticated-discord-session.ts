import "server-only";

import { AUTH_SESSION_COOKIE, parseCookie } from "./cookies.mjs";
import { hashOpaqueToken } from "./crypto.mjs";
import { createAuthRepository } from "./repository";
import { resolveAuthRequestContext } from "./request-context";
import { resolveAuthenticatedDiscordSessionCore } from "./authenticated-discord-session-core.mjs";

export interface TrustedAuthenticatedDiscordSession {
  readonly brand: { readonly game: { readonly profile: "wos" | "kingshot" } };
  readonly hostname: string;
  readonly gameProfile: "wos" | "kingshot";
  readonly session: { readonly tokenHash: string; readonly expiresAt: Date | string };
  readonly discordUser: {
    readonly id: string;
    readonly username: string;
    readonly globalName: string | null;
    readonly avatarHash: string | null;
  };
}

export function resolveAuthenticatedDiscordSession(request: Request) {
  return resolveAuthenticatedDiscordSessionCore(request, {
    resolveHostContext: resolveAuthRequestContext,
    readSessionToken: (currentRequest: Request) => parseCookie(currentRequest, AUTH_SESSION_COOKIE),
    hashSessionToken: hashOpaqueToken,
    createAuthRepository,
  }) as Promise<TrustedAuthenticatedDiscordSession>;
}
