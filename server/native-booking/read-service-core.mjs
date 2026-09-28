export class NativeBookingCommunityNotFoundError extends Error {
  constructor() {
    super("Native booking community was not found.");
    this.name = "NativeBookingCommunityNotFoundError";
  }
}

export class NativeBookingServiceNotFoundError extends Error {
  constructor() {
    super("Native booking service was not found.");
    this.name = "NativeBookingServiceNotFoundError";
  }
}

export class NativeBookingParticipantAmbiguousError extends Error {
  constructor() {
    super("Participant registration ownership is ambiguous.");
    this.name = "NativeBookingParticipantAmbiguousError";
  }
}

function mapRequirements(settings) {
  if (!settings) return null;

  return {
    construction: {
      fcRequired: settings.construction_fc_required,
      rfcRequired: settings.construction_rfc_required,
      speedupsRequired: settings.construction_speedups_required,
    },
    research: {
      shardsRequired: settings.research_shards_required,
      speedupsRequired: settings.research_speedups_required,
    },
    troop: {
      speedupsRequired: settings.troop_speedups_required,
    },
  };
}

function bookingDateString(value) {
  if (!(value instanceof Date)) return value;
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function windowAcceptsBookings(window, now) {
  return window?.status === "open"
    && (!window.opens_at || new Date(window.opens_at) <= now)
    && (!window.closes_at || new Date(window.closes_at) > now);
}

async function requireCommunity(session, communityId) {
  const community = await session.findCommunityById(communityId);
  if (!community || community.status !== "active") {
    throw new NativeBookingCommunityNotFoundError();
  }
  return community;
}

export function createNativeBookingReadService({
  gameProfile,
  communityId,
  repository,
  now = () => new Date(),
}) {
  return Object.freeze({
    gameProfile,

    async getContext() {
      return repository.withTransaction(async (session) => {
        const community = await requireCommunity(
          session,
          communityId,
        );
        const window = await session.findCurrentBookingWindow(community.id);
        const services = await session.listActiveMinisterServices(community.id);
        const settings = await session.findBookingSettings(community.id);
        const dates = window
          ? await session.listServiceDates(community.id, window.id)
          : [];
        const datesByService = new Map(
          dates.map((date) => [date.service_code, bookingDateString(date.booking_date)]),
        );
        const bookingsOpen =
          community.bookings_open && windowAcceptsBookings(window, now());

        return {
          community: {
            locationCode: community.location_code,
            displayName: community.display_name,
          },
          bookingsOpen,
          windowState: window?.status ?? "unavailable",
          requirements: mapRequirements(settings),
          services: services.map((service) => ({
            code: service.service_code,
            displayLabel: service.display_label,
            appointmentLabel: service.appointment_label,
            date: datesByService.get(service.service_code) ?? null,
          })),
        };
      });
    },

    async getAvailability(serviceCode) {
      return repository.withTransaction(async (session) => {
        const community = await requireCommunity(
          session,
          communityId,
        );
        const window = await session.findCurrentBookingWindow(community.id);
        const services = await session.listActiveMinisterServices(community.id);
        const service = services.find(
          (candidate) => candidate.service_code === serviceCode,
        );
        if (!service) throw new NativeBookingServiceNotFoundError();

        const dates = window
          ? await session.listServiceDates(community.id, window.id)
          : [];
        const serviceDate =
          dates.find((date) => date.service_code === serviceCode) ?? null;
        const bookingsOpen =
          community.bookings_open && windowAcceptsBookings(window, now());
        const slots =
          bookingsOpen && window && serviceDate
            ? await session.listAvailableAppointmentSlots(
                community.id,
                window.id,
                serviceCode,
              )
            : [];

        return {
          service: {
            code: service.service_code,
            displayLabel: service.display_label,
          },
          date: serviceDate ? bookingDateString(serviceDate.booking_date) : null,
          bookingsOpen,
          slots: [...slots]
            .sort(
              (left, right) =>
                left.ordinal - right.ordinal || left.id.localeCompare(right.id),
            )
            .map((slot) => ({
              slotId: slot.id,
              displayTime: slot.display_time_label,
              ordinal: slot.ordinal,
            })),
        };
      });
    },

    async getParticipantBookingsForDiscordUser(trustedDiscordUserId) {
      return repository.withTransaction(async (session) => {
        const community = await requireCommunity(
          session,
          communityId,
        );
        const participants =
          await session.listActiveParticipantsByDiscordUser(
            community.id,
            trustedDiscordUserId,
          );
        const participant = participants[0];
        if (!participant) {
          return { registration: { status: "unregistered" }, characters: [], bookings: [] };
        }

        const bookings = await session.listConfirmedBookingsForDiscordUser(
          community.id,
          trustedDiscordUserId,
        );

        return {
          registration: {
            status: "registered",
            playerId: participant.player_id,
            inGameName: participant.in_game_name,
            alliance: participant.alliance,
            participantId: participant.id,
            isPrimary: participant.is_primary,
          },
          characters: participants.map((character) => ({
            participantId: character.id,
            playerId: character.player_id,
            inGameName: character.in_game_name,
            alliance: character.alliance,
            isPrimary: character.is_primary,
          })),
          bookings: bookings.map((booking) => ({
            bookingId: booking.id,
            serviceCode: booking.service_code,
            date: booking.booking_date,
            displayTime: booking.display_time_label_snapshot,
            ordinal: booking.ordinal,
            participantId: booking.participant_id,
            playerId: booking.player_id,
            playerName: booking.in_game_name,
            alliance: booking.alliance,
          })),
        };
      });
    },
  });
}
