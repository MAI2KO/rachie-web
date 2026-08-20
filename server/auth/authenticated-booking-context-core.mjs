export const BOOKING_READ_MEMBERSHIP_MAX_AGE_SECONDS = 30 * 60;
export const FUTURE_BOOKING_MUTATION_MEMBERSHIP_MAX_AGE_SECONDS = 5 * 60;

export class BookingAuthenticationRequiredError extends Error {
  constructor(message = "Authentication is required.") {
    super(message);
    this.name = "BookingAuthenticationRequiredError";
  }
}

export class BookingCommunitySelectionRequiredError extends Error {
  constructor() {
    super("A verified booking community must be selected.");
    this.name = "BookingCommunitySelectionRequiredError";
  }
}

export class BookingMembershipRefreshRequiredError extends Error {
  constructor() {
    super("Discord membership must be refreshed by signing in again.");
    this.name = "BookingMembershipRefreshRequiredError";
  }
}

export class BookingMembershipVerificationUnavailableError extends Error {
  constructor(retryAfterSeconds = null) {
    super("Discord membership could not be verified right now.");
    this.name = "BookingMembershipVerificationUnavailableError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class BookingCommunityMembershipLostError extends Error {
  constructor() {
    super("Discord membership in the selected community could not be confirmed.");
    this.name = "BookingCommunityMembershipLostError";
  }
}

export class AuthenticatedBookingContextUnavailableError extends Error {
  constructor() {
    super("Authenticated booking context is unavailable.");
    this.name = "AuthenticatedBookingContextUnavailableError";
  }
}

export class AuthenticatedBookingHostNotFoundError extends Error {
  constructor() {
    super("Booking host was not recognized.");
    this.name = "AuthenticatedBookingHostNotFoundError";
  }
}

export function isMembershipFresh(
  verifiedAt,
  now,
  maxAgeSeconds,
  futureClockToleranceSeconds = 300,
) {
  const verifiedAtDate =
    verifiedAt instanceof Date ? verifiedAt : new Date(String(verifiedAt));
  if (Number.isNaN(verifiedAtDate.getTime())) return false;
  const ageMilliseconds = now.getTime() - verifiedAtDate.getTime();
  return (
    ageMilliseconds >= -futureClockToleranceSeconds * 1000 &&
    ageMilliseconds <= maxAgeSeconds * 1000
  );
}

export function assertFutureBookingMutationMembershipFresh(
  context,
  now = new Date(),
) {
  if (
    !isMembershipFresh(
      context?.community?.membershipVerifiedAt,
      now,
      FUTURE_BOOKING_MUTATION_MEMBERSHIP_MAX_AGE_SECONDS,
    )
  ) {
    throw new BookingMembershipRefreshRequiredError();
  }
}

export async function resolveAuthenticatedBookingContextCore(
  request,
  {
    resolveHostContext,
    readSessionToken,
    hashSessionToken,
    createAuthRepository,
    now = () => new Date(),
    membershipMaxAgeSeconds = BOOKING_READ_MEMBERSHIP_MAX_AGE_SECONDS,
  },
) {
  const hostContext = resolveHostContext(request);
  if (!hostContext) throw new AuthenticatedBookingHostNotFoundError();

  const sessionToken = readSessionToken(request);
  if (typeof sessionToken !== "string" || !sessionToken) {
    throw new BookingAuthenticationRequiredError();
  }
  const repository = createAuthRepository(hostContext.gameProfile);
  if (!repository) throw new AuthenticatedBookingContextUnavailableError();

  const tokenHash = hashSessionToken(sessionToken);
  const session = await repository.findSession(tokenHash);
  if (!session) throw new BookingAuthenticationRequiredError();

  const selectedCommunities = session.communities.filter(
    (community) => community.selected,
  );
  if (selectedCommunities.length === 0) {
    throw new BookingCommunitySelectionRequiredError();
  }
  if (selectedCommunities.length !== 1) {
    throw new AuthenticatedBookingContextUnavailableError();
  }

  const selected = selectedCommunities[0];
  if (
    !isMembershipFresh(
      selected.verifiedAt,
      now(),
      membershipMaxAgeSeconds,
    )
  ) {
    throw new BookingMembershipRefreshRequiredError();
  }

  return Object.freeze({
    brand: hostContext.brand,
    hostname: hostContext.hostname,
    gameProfile: hostContext.gameProfile,
    session: Object.freeze({
      tokenHash,
      expiresAt: session.expiresAt,
    }),
    discordUser: Object.freeze({ ...session.user }),
    community: Object.freeze({
      id: selected.id,
      locationCode: selected.locationCode,
      displayName: selected.displayName,
      discordGuildId: selected.discordGuildId,
      membershipVerifiedAt: selected.verifiedAt,
    }),
  });
}
