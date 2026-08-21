import "server-only";

import type { GameProfile } from "@/brands/types";
import { getDatabasePool } from "@/server/database/pool";

import { createDiscordIntegrationRepository } from "./repository-core.mjs";

export function getDiscordIntegrationRepository(gameProfile: GameProfile) {
  const pool = getDatabasePool();
  return pool ? createDiscordIntegrationRepository(gameProfile, pool) : null;
}
