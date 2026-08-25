import "server-only";

import { resolveNativeBookingRequestContext } from "@/server/native-booking/request-context";

import { readAllianceEventsCommunity } from "./read";
import { handlePublicAllianceEventsCore } from "./route-core.mjs";

export function handlePublicAllianceEvents(request: Request, communityCode: string) {
  return handlePublicAllianceEventsCore(request, communityCode, {
    resolveRequestContext: resolveNativeBookingRequestContext,
    readCommunity: readAllianceEventsCommunity,
  });
}
