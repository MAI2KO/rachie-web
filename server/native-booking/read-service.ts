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
  NativeBookingServiceNotFoundError,
} from "./read-service-core.mjs";
import type { NativeBookingRepository } from "./repository";

export {
  NativeBookingCommunityNotFoundError,
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
  ): Promise<NativeParticipantBookingSummary | null>;
}

export function createNativeBookingReadService(
  trustedGameProfile: GameProfile,
  trustedCommunityLocationCode: string,
  repository: NativeBookingRepository,
): NativeBookingReadService {
  if (repository.gameProfile !== trustedGameProfile) {
    throw new TypeError("Native booking repository profile mismatch.");
  }

  return createReadServiceCore({
    gameProfile: trustedGameProfile,
    communityLocationCode: trustedCommunityLocationCode,
    repository,
  }) as NativeBookingReadService;
}
