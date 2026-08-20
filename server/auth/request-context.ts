import "server-only";

import { normalizeHostname, resolveKnownBrand } from "@/brands/resolve";
import { requestHostnameHeader, trustsRailwayProxy } from "@/server/request-proxy.mjs";

import { resolveAuthRequestContextCore } from "./request-context-core.mjs";

export function resolveAuthRequestContext(request: Request) {
  return resolveAuthRequestContextCore(request, {
    normalizeHostname,
    resolveKnownBrand,
    requestHostnameHeader: (headers: Headers) =>
      requestHostnameHeader(headers, trustsRailwayProxy()),
  });
}
