import "server-only";

import type { Pool } from "pg";

import type { GameProfile } from "@/brands/types";
import { getDatabasePool } from "@/server/database/pool";

import { createProfileScopedBookingRepository } from "./repository-core.mjs";

export interface BookingCommunityRecord {
  readonly game_profile: GameProfile;
  readonly id: string;
  readonly location_code: string;
  readonly display_name: string;
  readonly status: "active" | "archived";
  readonly bookings_open: boolean;
}

export interface BookingIdempotencyRecord {
  readonly game_profile: GameProfile;
  readonly community_id: string;
  readonly idempotency_key: string;
  readonly operation: string;
  readonly request_hash: string;
  readonly request_id: string | null;
  readonly correlation_id: string;
  readonly status: "started" | "completed" | "failed";
  readonly response_status: number | null;
  readonly response_body: Record<string, unknown> | null;
}

export interface BookingWindowRecord {
  readonly game_profile: GameProfile;
  readonly id: string;
  readonly community_id: string;
  readonly status: "open" | "closed";
}

export interface MinisterServiceRecord {
  readonly game_profile: GameProfile;
  readonly service_code: "construction" | "research" | "troop";
  readonly display_label: string;
  readonly appointment_label: string;
  readonly sort_order: number;
}

export interface BookingServiceDateRecord {
  readonly game_profile: GameProfile;
  readonly service_code: MinisterServiceRecord["service_code"];
  readonly booking_date: string;
}

export interface BookingSettingsRecord {
  readonly game_profile: GameProfile;
  readonly community_id: string;
  readonly construction_fc_required: boolean;
  readonly construction_rfc_required: boolean;
  readonly construction_speedups_required: boolean;
  readonly research_shards_required: boolean;
  readonly research_speedups_required: boolean;
  readonly troop_speedups_required: boolean;
}

export interface AppointmentSlotRecord {
  readonly id: string;
  readonly service_code: MinisterServiceRecord["service_code"];
  readonly booking_date: string;
  readonly display_time_label: string;
  readonly ordinal: number;
}

export interface BookingParticipantRecord {
  readonly game_profile: GameProfile;
  readonly id: string;
  readonly community_id: string;
  readonly discord_user_id: string | null;
  readonly player_id: string;
  readonly in_game_name: string;
  readonly alliance: string;
}

export interface ParticipantBookingRecord {
  readonly id: string;
  readonly service_code: MinisterServiceRecord["service_code"];
  readonly booking_date: string;
  readonly display_time_label_snapshot: string;
  readonly ordinal: number;
}

export interface NativeBookingSession {
  findCommunityById(id: string): Promise<BookingCommunityRecord | null>;
  findCommunityByLocationCode(
    locationCode: string,
  ): Promise<BookingCommunityRecord | null>;
  findCommunityForDiscordGuild(
    discordGuildId: string,
  ): Promise<BookingCommunityRecord | null>;
  findIdempotencyRecord(
    communityId: string,
    idempotencyKey: string,
  ): Promise<BookingIdempotencyRecord | null>;
  claimRegistrationIdempotency(input: {
    communityId: string;
    idempotencyKey: string;
    requestHash: string;
    correlationId: string;
  }): Promise<
    | { readonly state: "claimed" }
    | {
        readonly state: "existing";
        readonly record: {
          readonly operation: string;
          readonly request_hash: string;
          readonly status: "started" | "completed" | "failed";
          readonly response_status: number | null;
          readonly response_body: Record<string, unknown> | null;
        } | null;
      }
  >;
  completeRegistrationIdempotency(
    communityId: string,
    idempotencyKey: string,
    responseStatus: number,
    responseBody: Record<string, unknown>,
  ): Promise<void>;
  findCurrentBookingWindow(
    communityId: string,
  ): Promise<BookingWindowRecord | null>;
  listActiveMinisterServices(): Promise<readonly MinisterServiceRecord[]>;
  listServiceDates(
    communityId: string,
    windowId: string,
  ): Promise<readonly BookingServiceDateRecord[]>;
  findBookingSettings(
    communityId: string,
  ): Promise<BookingSettingsRecord | null>;
  listAvailableAppointmentSlots(
    communityId: string,
    windowId: string,
    serviceCode: MinisterServiceRecord["service_code"],
  ): Promise<readonly AppointmentSlotRecord[]>;
  findActiveParticipantByDiscordUser(
    communityId: string,
    discordUserId: string,
  ): Promise<BookingParticipantRecord | null>;
  listActiveParticipantsByDiscordUser(
    communityId: string,
    discordUserId: string,
  ): Promise<readonly BookingParticipantRecord[]>;
  lockActiveParticipantsByDiscordUser(
    communityId: string,
    discordUserId: string,
  ): Promise<readonly BookingParticipantRecord[]>;
  insertWebsiteParticipant(input: {
    id: string;
    communityId: string;
    discordUserId: string;
    playerId: string;
    inGameName: string;
    alliance: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<BookingParticipantRecord>;
  updateWebsiteParticipant(input: {
    id: string;
    communityId: string;
    discordUserId: string;
    playerId: string;
    inGameName: string;
    alliance: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<BookingParticipantRecord | null>;
  insertParticipantChangeEvent(input: {
    id: string;
    communityId: string;
    participantId: string;
    eventType: "participant_registered" | "participant_registration_updated";
    actorId: string;
    correlationId: string;
    beforeData: Record<string, unknown> | null;
    afterData: Record<string, unknown>;
  }): Promise<void>;
  listConfirmedBookingsForParticipant(
    communityId: string,
    participantId: string,
  ): Promise<readonly ParticipantBookingRecord[]>;
}

export interface NativeBookingRepository {
  readonly gameProfile: GameProfile;
  withTransaction<T>(
    work: (session: NativeBookingSession) => Promise<T>,
  ): Promise<T>;
}

export function createNativeBookingRepository(
  trustedGameProfile: GameProfile,
  pool: Pool | null = getDatabasePool(),
): NativeBookingRepository | null {
  if (!pool) return null;

  return createProfileScopedBookingRepository(
    trustedGameProfile,
    pool,
  ) as NativeBookingRepository;
}
