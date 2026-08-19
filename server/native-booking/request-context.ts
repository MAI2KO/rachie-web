import "server-only";

import { normalizeHostname, resolveKnownBrand } from "@/brands/resolve";
import type { ActiveBrand } from "@/brands/config";
import type { GameProfile } from "@/brands/types";

import { resolveNativeBookingCommunityCode } from "./community-config.mjs";
import { resolveNativeBookingRequestContextCore } from "./request-context-core.mjs";

export interface TrustedNativeBookingRequestContext {
  readonly brand: ActiveBrand;
  readonly gameProfile: GameProfile;
  readonly hostname: string;
  readonly communityLocationCode: string | null;
}

export function resolveNativeBookingRequestContext(
  request: Request,
): TrustedNativeBookingRequestContext | null {
  return resolveNativeBookingRequestContextCore(request, {
    normalizeHostname,
    resolveKnownBrand,
    resolveCommunityCode: (gameProfile: GameProfile) =>
      resolveNativeBookingCommunityCode(gameProfile, process.env),
  }) as TrustedNativeBookingRequestContext | null;
}
