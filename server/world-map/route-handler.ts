import "server-only";

import { resolveNativeBookingRequestContext } from "@/server/native-booking/request-context";

import { handlePublicWorldMapCore } from "./read-core.mjs";
import { readPublicWorldMap } from "./read";

export function handlePublicWorldMap(request: Request) {
  return handlePublicWorldMapCore(request, {
    resolveRequestContext: resolveNativeBookingRequestContext,
    listCommunities: readPublicWorldMap,
  });
}
