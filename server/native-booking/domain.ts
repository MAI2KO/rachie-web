import {
  isKnownMinisterServiceCode,
  MINISTER_SERVICE_CODES,
} from "./service-codes.mjs";

export { MINISTER_SERVICE_CODES };

export type MinisterServiceCode = "construction" | "research" | "troop";

export function isMinisterServiceCode(
  value: string | null,
): value is MinisterServiceCode {
  return isKnownMinisterServiceCode(value);
}

export interface PublicRequirementConfiguration {
  readonly construction: {
    readonly fcRequired: boolean;
    readonly rfcRequired: boolean;
    readonly speedupsRequired: boolean;
  };
  readonly research: {
    readonly shardsRequired: boolean;
    readonly speedupsRequired: boolean;
  };
  readonly troop: {
    readonly speedupsRequired: boolean;
  };
}

export interface NativeBookingContext {
  readonly community: {
    readonly locationCode: string;
    readonly displayName: string;
  };
  readonly bookingsOpen: boolean;
  readonly windowState: "open" | "closed" | "unavailable";
  readonly requirements: PublicRequirementConfiguration | null;
  readonly services: readonly {
    readonly code: MinisterServiceCode;
    readonly displayLabel: string;
    readonly appointmentLabel: string;
    readonly date: string | null;
  }[];
}

export interface NativeBookingAvailability {
  readonly service: {
    readonly code: MinisterServiceCode;
    readonly displayLabel: string;
  };
  readonly date: string | null;
  readonly bookingsOpen: boolean;
  readonly slots: readonly {
    readonly slotId: string;
    readonly displayTime: string;
    readonly ordinal: number;
  }[];
}

export interface NativeParticipantBookingSummary {
  readonly registration:
    | { readonly status: "unregistered" }
    | {
        readonly status: "registered";
        readonly playerId: string;
        readonly inGameName: string;
        readonly alliance: string;
      };
  readonly bookings: readonly {
    readonly bookingId: string;
    readonly serviceCode: MinisterServiceCode;
    readonly date: string;
    readonly displayTime: string;
    readonly ordinal: number;
  }[];
}
