import "server-only";

import type { GameProfile } from "@/brands/types";
import { validateCommunityCode } from "@/server/booking-board/manager-authorization-core.mjs";

import { getAllianceEventsClient } from "./client";
import { readAllianceEventsCommunityCore } from "./read-core.mjs";
import { createAllianceEventsRepository } from "./repository";

export async function readAllianceEventsCommunity(gameProfile: GameProfile, rawCommunityCode: string) {
  let communityCode;
  try { communityCode = validateCommunityCode(rawCommunityCode); } catch { return null; }
  return readAllianceEventsCommunityCore(gameProfile, communityCode, {
    createRepository: createAllianceEventsRepository,
    getClient: getAllianceEventsClient,
  });
}
