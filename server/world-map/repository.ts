import "server-only";

import type { GameProfile } from "@/brands/types";
import { getDatabasePool } from "@/server/database/pool";

import { createProfileScopedWorldMapRepository } from "./repository-core.mjs";

export function createWorldMapRepository(gameProfile: GameProfile) {
  const pool = getDatabasePool();
  return pool ? createProfileScopedWorldMapRepository(gameProfile, pool) : null;
}
