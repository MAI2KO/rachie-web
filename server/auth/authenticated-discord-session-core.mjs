import {
  AuthenticatedBookingContextUnavailableError,
  AuthenticatedBookingHostNotFoundError,
  BookingAuthenticationRequiredError,
} from "./authenticated-booking-context-core.mjs";

export async function resolveAuthenticatedDiscordSessionCore(request, {
  resolveHostContext,
  readSessionToken,
  hashSessionToken,
  createAuthRepository,
}) {
  const hostContext = resolveHostContext(request);
  if (!hostContext) throw new AuthenticatedBookingHostNotFoundError();
  const rawToken = readSessionToken(request);
  if (typeof rawToken !== "string" || !rawToken) throw new BookingAuthenticationRequiredError();
  const repository = createAuthRepository(hostContext.gameProfile);
  if (!repository) throw new AuthenticatedBookingContextUnavailableError();
  const tokenHash = hashSessionToken(rawToken);
  const session = await repository.findSession(tokenHash);
  if (!session) throw new BookingAuthenticationRequiredError();
  return Object.freeze({
    brand: hostContext.brand,
    hostname: hostContext.hostname,
    gameProfile: hostContext.gameProfile,
    session: Object.freeze({ tokenHash, expiresAt: session.expiresAt }),
    discordUser: Object.freeze({ ...session.user }),
  });
}
