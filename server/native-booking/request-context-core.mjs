export function resolveNativeBookingRequestContextCore(
  request,
  { normalizeHostname, resolveKnownBrand, resolveCommunityCode, requestHostnameHeader },
) {
  const hostname = normalizeHostname(
    requestHostnameHeader
      ? requestHostnameHeader(request.headers)
      : request.headers.get("host"),
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
