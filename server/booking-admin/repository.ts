import "server-only";

import type { GameProfile } from "@/brands/types";
import { getDatabasePool } from "@/server/database/pool";

import { createProfileScopedBookingAdminRepository } from "./repository-core.mjs";

export function createBookingAdminRepository(gameProfile: GameProfile) {
  const pool = getDatabasePool();
  return pool ? createProfileScopedBookingAdminRepository(gameProfile, pool) : null;
}
