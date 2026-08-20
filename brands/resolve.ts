import {
  brandConfigs,
  DEFAULT_BRAND_ID,
  type ActiveBrand,
} from "./config";
import {
  normalizeHostname,
  resolveKnownBrandCore,
} from "./resolve-core.mjs";

export { normalizeHostname };

export function resolveKnownBrand(hostname: string): ActiveBrand | null {
  return resolveKnownBrandCore(hostname, brandConfigs) as ActiveBrand | null;
}

export function resolveBrand(hostname: string): ActiveBrand {
  return resolveKnownBrand(hostname) ?? brandConfigs[DEFAULT_BRAND_ID];
}
