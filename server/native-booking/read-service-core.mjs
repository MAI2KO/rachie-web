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

async function requireCommunity(session, locationCode) {
  const community = await session.findCommunityByLocationCode(locationCode);
  if (!community || community.status !== "active") {
    throw new NativeBookingCommunityNotFoundError();
  }
  return community;
}

export function createNativeBookingReadService({
  gameProfile,
  communityLocationCode,
  repository,
}) {
  return Object.freeze({
    gameProfile,

    async getContext() {
      return repository.withTransaction(async (session) => {
        const community = await requireCommunity(
          session,
          communityLocationCode,
        );
        const window = await session.findCurrentBookingWindow(community.id);
        const services = await session.listActiveMinisterServices();
        const settings = await session.findBookingSettings(community.id);
        const dates = window
          ? await session.listServiceDates(community.id, window.id)
          : [];
        const datesByService = new Map(
          dates.map((date) => [date.service_code, date.booking_date]),
        );
        const bookingsOpen =
          community.bookings_open && window?.status === "open";

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
          communityLocationCode,
        );
        const window = await session.findCurrentBookingWindow(community.id);
        const services = await session.listActiveMinisterServices();
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
          community.bookings_open && window?.status === "open";
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
          date: serviceDate?.booking_date ?? null,
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
          communityLocationCode,
        );
        const participant =
          await session.findActiveParticipantByDiscordUser(
            community.id,
            trustedDiscordUserId,
          );
        if (!participant) return null;

        const bookings = await session.listConfirmedBookingsForParticipant(
          community.id,
          participant.id,
        );

        return {
          participant: {
            playerId: participant.player_id,
            inGameName: participant.in_game_name,
            alliance: participant.alliance,
          },
          bookings: bookings.map((booking) => ({
            bookingId: booking.id,
            serviceCode: booking.service_code,
            date: booking.booking_date,
            displayTime: booking.display_time_label_snapshot,
            ordinal: booking.ordinal,
          })),
        };
      });
    },
  });
}
