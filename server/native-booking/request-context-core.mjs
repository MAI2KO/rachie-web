export function resolveNativeBookingRequestContextCore(
  request,
  { normalizeHostname, resolveKnownBrand, resolveCommunityCode },
) {
  const hostname = normalizeHostname(
    request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  );
  const brand = resolveKnownBrand(hostname);
  if (!brand) return null;

  const gameProfile = brand.game.profile;

  return Object.freeze({
    brand,
    gameProfile,
    hostname,
    communityLocationCode: resolveCommunityCode(gameProfile),
  });
}
