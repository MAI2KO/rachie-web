import {
  brandConfigs,
  DEFAULT_BRAND_ID,
  type ActiveBrand,
} from "./config";

export function normalizeHostname(host: string | null): string {
  const firstHost = host?.split(",", 1)[0]?.trim().toLowerCase() ?? "";

  if (firstHost.startsWith("[")) {
    const closingBracket = firstHost.indexOf("]");
    return closingBracket === -1
      ? firstHost
      : firstHost.slice(1, closingBracket);
  }

  return firstHost.split(":", 1)[0]?.replace(/\.$/, "") ?? "";
}

export function resolveBrand(hostname: string): ActiveBrand {
  const normalizedHostname = normalizeHostname(hostname);

  return (
    Object.values(brandConfigs).find(
      (brand) =>
        brand.domain === normalizedHostname ||
        brand.localHostnames.some(
          (localHostname) => localHostname === normalizedHostname,
        ),
    ) ?? brandConfigs[DEFAULT_BRAND_ID]
  );
}
