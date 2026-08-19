import "server-only";

import { normalizeHostname, resolveKnownBrand } from "@/brands/resolve";

import { resolveAuthRequestContextCore } from "./request-context-core.mjs";

export function resolveAuthRequestContext(request: Request) {
  return resolveAuthRequestContextCore(request, {
    normalizeHostname,
    resolveKnownBrand,
  });
}
