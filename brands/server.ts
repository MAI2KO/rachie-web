import { headers } from "next/headers";
import { cache } from "react";

import { normalizeHostname, resolveBrand } from "./resolve";

export interface BrandRequestContext {
  readonly brand: ReturnType<typeof resolveBrand>;
  readonly hostname: string;
}

export const getBrandRequestContext = cache(async (): Promise<BrandRequestContext> => {
  const requestHeaders = await headers();
  const hostHeader =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const hostname = normalizeHostname(hostHeader);

  return {
    brand: resolveBrand(hostname),
    hostname: hostname || "unknown",
  };
});
