import "server-only";

import type { GameProfile } from "@/brands/types";
import { getDatabasePool } from "@/server/database/pool";

import { createProfileScopedRateLimitRepository } from "./repository-core.mjs";

export function createRateLimitRepository(gameProfile: GameProfile) {
  const pool = getDatabasePool();
  return pool
    ? createProfileScopedRateLimitRepository(gameProfile, pool)
    : null;
}
