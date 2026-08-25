import "server-only";

import type { GameProfile } from "@/brands/types";

const ENVIRONMENT = {
  wos: {
    url: "RACHIE_ALLIANCE_EVENTS_INTERNAL_URL",
    secret: "RACHIE_ALLIANCE_EVENTS_INTEGRATION_SECRET",
  },
  kingshot: {
    url: "PEGGIE_ALLIANCE_EVENTS_INTERNAL_URL",
    secret: "PEGGIE_ALLIANCE_EVENTS_INTEGRATION_SECRET",
  },
} as const;

export interface AllianceEventsIntegrationConfig {
  readonly profile: GameProfile;
  readonly baseUrl: string;
  readonly secret: string;
}

export function getAllianceEventsIntegrationConfig(
  profile: GameProfile,
  environment: NodeJS.ProcessEnv = process.env,
): AllianceEventsIntegrationConfig | null {
  const names = ENVIRONMENT[profile];
  const rawUrl = String(environment[names.url] ?? "").trim().replace(/\/$/, "");
  const secret = String(environment[names.secret] ?? "");
  let safeUrl = false;
  try {
    const parsed = new URL(rawUrl);
    safeUrl = parsed.protocol === "https:"
      || (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname));
  } catch {}
  return safeUrl && secret.length >= 32
    ? Object.freeze({ profile, baseUrl: rawUrl, secret })
    : null;
}
