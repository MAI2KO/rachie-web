import "server-only";

import type { GameProfile } from "@/brands/types";

import type {
  MinisterServiceCode,
  NativeBookingAvailability,
  NativeBookingContext,
  NativeParticipantBookingSummary,
} from "./domain";
import {
  createNativeBookingReadService as createReadServiceCore,
  NativeBookingCommunityNotFoundError,
  NativeBookingParticipantAmbiguousError,
  NativeBookingServiceNotFoundError,
} from "./read-service-core.mjs";
import type { NativeBookingRepository } from "./repository";

export {
  NativeBookingCommunityNotFoundError,
  NativeBookingParticipantAmbiguousError,
  NativeBookingServiceNotFoundError,
};

export interface NativeBookingReadService {
  readonly gameProfile: GameProfile;
  getContext(): Promise<NativeBookingContext>;
  getAvailability(
    serviceCode: MinisterServiceCode,
  ): Promise<NativeBookingAvailability>;
  getParticipantBookingsForDiscordUser(
    trustedDiscordUserId: string,
  ): Promise<NativeParticipantBookingSummary>;
}

export function createNativeBookingReadService(
  trustedContext: {
    readonly gameProfile: GameProfile;
    readonly community: { readonly id: string };
  },
  repository: NativeBookingRepository,
): NativeBookingReadService {
  if (repository.gameProfile !== trustedContext.gameProfile) {
    throw new TypeError("Native booking repository profile mismatch.");
  }

  return createReadServiceCore({
    gameProfile: trustedContext.gameProfile,
    communityId: trustedContext.community.id,
    repository,
  }) as NativeBookingReadService;
}
