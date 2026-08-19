import "server-only";

import type { GameProfile } from "@/brands/types";

import { resolveLegacyBookingBackendUrl } from "./backend-config.mjs";

export function getLegacyBookingBackendUrl(
  profile: GameProfile,
): string | null {
  return resolveLegacyBookingBackendUrl(profile, process.env);
}
