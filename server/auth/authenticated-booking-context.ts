import "server-only";

import type { ActiveBrand } from "@/brands/config";
import type { GameProfile } from "@/brands/types";

import { AUTH_SESSION_COOKIE, parseCookie } from "./cookies.mjs";
import { hashOpaqueToken } from "./crypto.mjs";
import { createAuthRepository } from "./repository";
import { resolveAuthRequestContext } from "./request-context";
import {
  resolveAuthenticatedBookingContextCore,
} from "./authenticated-booking-context-core.mjs";

export interface TrustedAuthenticatedBookingContext {
  readonly brand: ActiveBrand;
  readonly hostname: string;
  readonly gameProfile: GameProfile;
  readonly session: {
    readonly tokenHash: string;
    readonly expiresAt: Date | string;
  };
  readonly discordUser: {
    readonly id: string;
    readonly username: string;
    readonly globalName: string | null;
    readonly avatarHash: string | null;
  };
  readonly community: {
    readonly id: string;
    readonly locationCode: string;
    readonly displayName: string;
    readonly discordGuildId: string;
    readonly membershipVerifiedAt: Date | string;
  };
}

export async function resolveAuthenticatedBookingRequestContext(
  request: Request,
): Promise<TrustedAuthenticatedBookingContext> {
  return resolveAuthenticatedBookingContextCore(request, {
    resolveHostContext: resolveAuthRequestContext,
    readSessionToken: (currentRequest: Request) =>
      parseCookie(currentRequest, AUTH_SESSION_COOKIE),
    hashSessionToken: hashOpaqueToken,
    createAuthRepository,
  }) as Promise<TrustedAuthenticatedBookingContext>;
}
