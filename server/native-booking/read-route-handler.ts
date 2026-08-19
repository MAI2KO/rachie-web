import "server-only";

import { createNativeBookingReadApi } from "./read-api-core.mjs";
import { createNativeBookingReadService } from "./read-service";
import { createNativeBookingRepository } from "./repository";
import { resolveNativeBookingRequestContext } from "./request-context";

const nativeBookingReadApi = createNativeBookingReadApi({
  resolveRequestContext: resolveNativeBookingRequestContext,
  createRepository: createNativeBookingRepository,
  createReadService: createNativeBookingReadService,
});

export async function handleNativeBookingContextRead(
  request: Request,
): Promise<Response> {
  return nativeBookingReadApi.context(request);
}

export async function handleNativeBookingAvailabilityRead(
  request: Request,
): Promise<Response> {
  return nativeBookingReadApi.availability(request);
}
