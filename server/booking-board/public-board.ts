import "server-only";

import type { GameProfile } from "@/brands/types";
import { createBookingApprovalRepository } from "@/server/booking-approval/repository";
import { createBookingBoardReadService } from "@/server/booking-approval/service-core.mjs";
import { validateCommunityCode } from "./manager-authorization-core.mjs";

export async function readPublicAppointmentBoard(gameProfile: GameProfile, rawCommunityCode: string) {
  const communityCode = validateCommunityCode(rawCommunityCode);
  const repository = createBookingApprovalRepository(gameProfile);
  if (!repository) throw new Error("Appointment board database is unavailable.");
  const community = await repository.withTransaction((session: {
    findActiveCommunityByLocationCode(code: string): Promise<{ id: string } | null>;
  }) => session.findActiveCommunityByLocationCode(communityCode));
  if (!community) return null;
  return createBookingBoardReadService({
    gameProfile,
    communityId: community.id,
    repository,
  }).publicBoard();
}
