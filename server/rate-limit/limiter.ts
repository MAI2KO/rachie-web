import "server-only";

import type { GameProfile } from "@/brands/types";

import { getAuthSessionSecret } from "@/server/auth/config";

import { createRateLimiter } from "./limiter-core.mjs";
import { createRateLimitRepository } from "./repository";

export function createServerRateLimiter(gameProfile: GameProfile) {
  const repository = createRateLimitRepository(gameProfile);
  const secret = getAuthSessionSecret();
  return repository && secret
    ? createRateLimiter({ gameProfile, repository, secret })
    : null;
}
