export function resolveAuthRequestContextCore(
  request,
  { normalizeHostname, resolveKnownBrand, requestHostnameHeader },
) {
  const hostname = normalizeHostname(
    requestHostnameHeader
      ? requestHostnameHeader(request.headers)
      : request.headers.get("host"),
  );
  const brand = resolveKnownBrand(hostname);
  return brand
    ? Object.freeze({ hostname, brand, gameProfile: brand.game.profile })
    : null;
}
