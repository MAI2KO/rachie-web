import "server-only";

import type { GameProfile } from "@/brands/types";
import { getDatabasePool } from "@/server/database/pool";

import { createProfileScopedPointsRepository } from "./repository-core.mjs";

export function createPointsRepository(gameProfile: GameProfile) {
  const pool = getDatabasePool();
  return pool ? createProfileScopedPointsRepository(gameProfile, pool) : null;
}
