import "server-only";

import type { GameProfile } from "@/brands/types";
import { getDatabasePool } from "@/server/database/pool";

import { createProfileScopedApprovalRepository } from "./repository-core.mjs";

export function createBookingApprovalRepository(gameProfile: GameProfile) {
  const pool = getDatabasePool();
  return pool ? createProfileScopedApprovalRepository(gameProfile, pool) : null;
}
