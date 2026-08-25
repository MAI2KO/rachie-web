import "server-only";

import type { GameProfile } from "@/brands/types";
import { createBookingApprovalRepository } from "@/server/booking-approval/repository";
import { validateCommunityCode } from "@/server/booking-board/manager-authorization-core.mjs";

import { getAllianceEventsClient } from "./client";

export async function readAllianceEventsCommunity(gameProfile: GameProfile, rawCommunityCode: string) {
  let communityCode;
  try { communityCode = validateCommunityCode(rawCommunityCode); } catch { return null; }
  const repository = createBookingApprovalRepository(gameProfile);
  if (!repository) throw new Error("Community database is unavailable.");
  const community = await repository.withTransaction((session: {
    findActiveCommunityByLocationCode(code: string): Promise<{
      id: string; location_code: string; display_name: string;
    } | null>;
  }) => session.findActiveCommunityByLocationCode(communityCode));
  if (!community) return null;
  const client = getAllianceEventsClient(gameProfile);
  if (!client) return { community, availability: "unavailable" as const, alliances: [] };
  try {
    const model = await client.read(communityCode);
    return { community, availability: "available" as const, alliances: model.alliances };
  } catch {
    return { community, availability: "unavailable" as const, alliances: [] };
  }
}
