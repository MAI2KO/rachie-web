import "server-only";

import type { TrustedAuthenticatedBookingContext } from "@/server/auth/authenticated-booking-context";
import type { NativeBookingRepository } from "./repository";
import { createBookingCreationService } from "./booking-creation-service-core.mjs";

export function createNativeBookingCreationService(context: TrustedAuthenticatedBookingContext, repository: NativeBookingRepository) {
  return createBookingCreationService({ context, repository });
}
