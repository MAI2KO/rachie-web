import "server-only";

import type { TrustedAuthenticatedBookingContext } from "@/server/auth/authenticated-booking-context";
import type { NativeBookingRepository } from "./repository";
import { createBookingMutationService } from "./booking-mutation-service-core.mjs";

export function createNativeBookingMutationService(context: TrustedAuthenticatedBookingContext, repository: NativeBookingRepository) {
  return createBookingMutationService({ context, repository });
}
