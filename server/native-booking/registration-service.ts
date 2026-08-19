import "server-only";

import type { TrustedAuthenticatedBookingContext } from "@/server/auth/authenticated-booking-context";

import type { NativeBookingRepository } from "./repository";
import { createRegistrationService as createRegistrationServiceCore } from "./registration-service-core.mjs";

export function createNativeRegistrationService(
  context: TrustedAuthenticatedBookingContext,
  repository: NativeBookingRepository,
) {
  return createRegistrationServiceCore({ context, repository });
}
