import "server-only";

import type { GameProfile } from "@/brands/types";

import {
  resolveAuthSessionSecret,
  resolveDiscordOAuthConfig,
} from "./auth-config.mjs";

export interface DiscordOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export function getDiscordOAuthConfig(
  gameProfile: GameProfile,
): DiscordOAuthConfig | null {
  return resolveDiscordOAuthConfig(gameProfile, process.env);
}

export function getAuthSessionSecret(): string | null {
  return resolveAuthSessionSecret(process.env);
}
