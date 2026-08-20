import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import { requestHostnameHeader, trustsRailwayProxy } from "@/server/request-proxy.mjs";

import { normalizeHostname, resolveBrand } from "./resolve";

export interface BrandRequestContext {
  readonly brand: ReturnType<typeof resolveBrand>;
  readonly hostname: string;
}

export const getBrandRequestContext = cache(async (): Promise<BrandRequestContext> => {
  const requestHeaders = await headers();
  const hostHeader = requestHostnameHeader(
    requestHeaders,
    trustsRailwayProxy(),
  );
  const hostname = normalizeHostname(hostHeader);

  return {
    brand: resolveBrand(hostname),
    hostname: hostname || "unknown",
  };
});
