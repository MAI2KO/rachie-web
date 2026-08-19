import "server-only";

import type { GameProfile } from "@/brands/types";

import { getDatabasePool } from "@/server/database/pool";

import { createProfileScopedAuthRepository } from "./repository-core.mjs";

export function createAuthRepository(gameProfile: GameProfile) {
  const pool = getDatabasePool();
  return pool
    ? createProfileScopedAuthRepository(gameProfile, pool)
    : null;
}
