import "server-only";

import type { GameProfile } from "@/brands/types";
import { getDatabasePool } from "@/server/database/pool";

import { createProfileScopedAllianceEventsRepository } from "./repository-core.mjs";

export function createAllianceEventsRepository(gameProfile: GameProfile) {
  const pool = getDatabasePool();
  return pool ? createProfileScopedAllianceEventsRepository(gameProfile, pool) : null;
}
