import { randomUUID } from "node:crypto";

import { assertTrustedManagerContext } from "../booking-approval/domain-core.mjs";
import { bookingAdminModel, validateBookingAdminChange } from "./domain-core.mjs";

export class BookingAdminUnavailableError extends Error {
  constructor(message = "Booking administration is unavailable.") {
    super(message);
    this.name = "BookingAdminUnavailableError";
    this.code = "booking_admin_unavailable";
  }
}

export function createBookingAdminService({
  gameProfile,
  communityId,
  managerContext,
  repository,
  createId = randomUUID,
}) {
  if (repository.gameProfile !== gameProfile) throw new TypeError("Booking-admin repository profile mismatch.");
  const actor = assertTrustedManagerContext(managerContext, gameProfile, communityId);

  async function read() {
    return repository.withTransaction(async (session) => {
      const snapshot = await session.readSnapshot(communityId);
      if (!snapshot) throw new BookingAdminUnavailableError();
      return bookingAdminModel(gameProfile, snapshot);
    });
  }

  async function update(rawChange) {
    const change = validateBookingAdminChange(rawChange);
    return repository.withTransaction(async (session) => {
      const community = await session.lockCommunity(communityId);
      if (!community || community.status !== "active") throw new BookingAdminUnavailableError();
      const beforeSnapshot = await session.readSnapshot(communityId, community);
      if (!beforeSnapshot) throw new BookingAdminUnavailableError();
      let previousEnabled;
      if (change.section === "booking") {
        previousEnabled = Boolean(community.bookings_open);
        await session.setBookingEnabled(communityId, change.enabled);
      } else if (change.section === "service") {
        previousEnabled = Boolean(beforeSnapshot.services.find(
          (service) => service.service_code === change.serviceCode,
        )?.enabled);
        await session.setServiceEnabled(communityId, change.serviceCode, change.enabled, actor.discordUserId);
      } else {
        previousEnabled = Boolean(beforeSnapshot.settings?.[
          `${change.serviceCode}_${change.requirementCode}_required`
        ]);
        await session.setRequirementEnabled(
          communityId, change.serviceCode, change.requirementCode, change.enabled,
        );
      }
      const correlationId = createId();
      await session.insertAudit({
        id: createId(), communityId, actorId: actor.discordUserId, correlationId,
        beforeData: { ...change, enabled: previousEnabled }, afterData: change,
      });
      const snapshot = await session.readSnapshot(communityId, {
        ...community,
        bookings_open: change.section === "booking" ? change.enabled : community.bookings_open,
      });
      if (!snapshot) throw new BookingAdminUnavailableError();
      return bookingAdminModel(gameProfile, snapshot);
    });
  }

  return Object.freeze({ read, update });
}
