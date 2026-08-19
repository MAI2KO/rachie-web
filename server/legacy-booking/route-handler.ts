import "server-only";

import { normalizeHostname, resolveKnownBrand } from "@/brands/resolve";
import type { GameProfile } from "@/brands/types";

import { getLegacyBookingBackendUrl } from "./config";
import { handleLegacyBookingProxyRequest } from "./proxy-core.mjs";
import { createLegacyBookingTransport } from "./transport.mjs";

const legacyBookingTransport = createLegacyBookingTransport();

function getRequestHostname(request: Request): string {
  return normalizeHostname(
    request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  );
}

export async function proxyLegacyBookingRequest(
  request: Request,
  expectedProfile: GameProfile,
): Promise<Response> {
  const brand = resolveKnownBrand(getRequestHostname(request));
  const requestProfile = brand?.game.profile ?? null;
  const backendUrl =
    requestProfile === expectedProfile
      ? getLegacyBookingBackendUrl(requestProfile)
      : null;

  return handleLegacyBookingProxyRequest({
    request,
    expectedProfile,
    requestProfile,
    backendUrl,
    transport: legacyBookingTransport,
  });
}
