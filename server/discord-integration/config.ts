import "server-only";

import type { GameProfile } from "@/brands/types";

const SECRET_ENVIRONMENT = {
  wos: "RACHIE_BOOKING_INTEGRATION_SECRET",
  kingshot: "PEGGIE_BOOKING_INTEGRATION_SECRET",
} as const;

export function getBookingIntegrationSecret(profile: GameProfile) {
  const value = String(process.env[SECRET_ENVIRONMENT[profile]] ?? "").trim();
  return value.length >= 32 ? value : null;
}
