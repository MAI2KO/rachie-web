export function normalizeHostname(host) {
  const firstHost = host?.split(",", 1)[0]?.trim().toLowerCase() ?? "";
  if (firstHost.startsWith("[")) {
    const closingBracket = firstHost.indexOf("]");
    return closingBracket === -1
      ? firstHost
      : firstHost.slice(1, closingBracket);
  }
  return firstHost.split(":", 1)[0]?.replace(/\.$/, "") ?? "";
}

export function resolveKnownBrandCore(hostname, brands) {
  const normalizedHostname = normalizeHostname(hostname);
  return (
    Object.values(brands).find(
      (brand) =>
        brand.domain === normalizedHostname ||
        brand.stagingDomain === normalizedHostname ||
        brand.localHostnames.some(
          (localHostname) => localHostname === normalizedHostname,
        ),
    ) ?? null
  );
}
