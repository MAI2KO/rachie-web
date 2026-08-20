import "server-only";

import { verifyDiscordGuildMembership } from "./discord-guild-membership-verifier";
import type { TrustedAuthenticatedBookingContext } from "./authenticated-booking-context";
import { createBookingMembershipRefresher } from "./booking-membership-refresh-core.mjs";
import { createAuthRepository } from "./repository";

export const refreshAuthenticatedBookingMembership =
  createBookingMembershipRefresher({
    createAuthRepository,
    verifyDiscordGuildMembership,
  }) as (
    context: TrustedAuthenticatedBookingContext,
  ) => Promise<TrustedAuthenticatedBookingContext>;
