export function resolveAuthRequestContextCore(
  request,
  { normalizeHostname, resolveKnownBrand },
) {
  const hostname = normalizeHostname(
    request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  );
  const brand = resolveKnownBrand(hostname);
  return brand
    ? Object.freeze({ hostname, brand, gameProfile: brand.game.profile })
    : null;
}
