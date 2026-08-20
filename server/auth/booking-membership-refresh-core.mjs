import {
  BookingCommunityMembershipLostError,
  BookingMembershipVerificationUnavailableError,
  FUTURE_BOOKING_MUTATION_MEMBERSHIP_MAX_AGE_SECONDS,
  isMembershipFresh,
} from "./authenticated-booking-context-core.mjs";

const sharedRefreshes = new Map();

function refreshKey(context) {
  return [
    context.gameProfile,
    context.session.tokenHash,
    context.discordUser.id,
    context.community.id,
    context.community.discordGuildId,
  ].join(":");
}

export function createBookingMembershipRefresher({
  createAuthRepository,
  verifyDiscordGuildMembership,
  now = () => new Date(),
  inFlightRefreshes = sharedRefreshes,
}) {
  return async function refreshAuthenticatedBookingMembership(context) {
    if (
      isMembershipFresh(
        context.community.membershipVerifiedAt,
        now(),
        FUTURE_BOOKING_MUTATION_MEMBERSHIP_MAX_AGE_SECONDS,
      )
    ) {
      return context;
    }

    const key = refreshKey(context);
    let refresh = inFlightRefreshes.get(key);
    if (!refresh) {
      refresh = (async () => {
        const result = await verifyDiscordGuildMembership({
          gameProfile: context.gameProfile,
          discordUserId: context.discordUser.id,
          guildId: context.community.discordGuildId,
        });
        if (result.status === "unavailable") {
          throw new BookingMembershipVerificationUnavailableError(
            result.retryAfterSeconds,
          );
        }
        const repository = createAuthRepository(context.gameProfile);
        if (!repository) throw new BookingMembershipVerificationUnavailableError();

        if (result.status === "member") {
          const verifiedAt = await repository.refreshSessionCommunityMembership(
            context.session.tokenHash,
            context.community.id,
            context.community.discordGuildId,
          );
          if (!verifiedAt) throw new BookingMembershipVerificationUnavailableError();
          return verifiedAt;
        }
        if (result.status === "not_member") {
          await repository.revokeSessionCommunityMembership(
            context.session.tokenHash,
            context.community.id,
            context.community.discordGuildId,
          );
          throw new BookingCommunityMembershipLostError();
        }
        throw new BookingMembershipVerificationUnavailableError();
      })();
      inFlightRefreshes.set(key, refresh);
      void refresh.then(
        () => { if (inFlightRefreshes.get(key) === refresh) inFlightRefreshes.delete(key); },
        () => { if (inFlightRefreshes.get(key) === refresh) inFlightRefreshes.delete(key); },
      );
    }

    const membershipVerifiedAt = await refresh;
    return Object.freeze({
      ...context,
      community: Object.freeze({
        ...context.community,
        membershipVerifiedAt,
      }),
    });
  };
}
