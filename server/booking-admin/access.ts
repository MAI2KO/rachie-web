import "server-only";

import { createBookingApprovalRepository } from "@/server/booking-approval/repository";
import { resolveAuthenticatedDiscordSession } from "@/server/auth/authenticated-discord-session";
import { verifyDiscordGuildManager } from "@/server/auth/discord-guild-membership-verifier";
import { createCommunityManagerAuthorizer } from "@/server/booking-board/manager-authorization-core.mjs";

export async function authorizeBookingAdminRequest(request: Request, communityCode: string) {
  const discordSession = await resolveAuthenticatedDiscordSession(request);
  const authorizationRepository = createBookingApprovalRepository(discordSession.gameProfile);
  if (!authorizationRepository) throw new Error("Booking administration database is unavailable.");
  const managerContext = await createCommunityManagerAuthorizer({
    gameProfile: discordSession.gameProfile,
    repository: authorizationRepository,
    verifyDiscordGuildManager,
  }).authorize(discordSession, communityCode);
  return Object.freeze({ discordSession, managerContext });
}
