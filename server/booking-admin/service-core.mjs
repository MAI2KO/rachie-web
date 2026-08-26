import { randomUUID } from "node:crypto";

import {
  assertTrustedManagerContext,
  generateGuestShareToken,
  guestShareTokenHint,
  hashGuestShareToken,
} from "../booking-approval/domain-core.mjs";
import {
  bookingAdminModel,
  BookingAdminValidationError,
  validateBookingAdminChange,
} from "./domain-core.mjs";

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
  createGuestToken = generateGuestShareToken,
  now = () => new Date(),
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

  async function updateGuestLink(rawChange) {
    const change = validateBookingAdminChange(rawChange);
    if (change.section !== "guestLink") throw new BookingAdminUnavailableError();
    return repository.withTransaction(async (session) => {
      const community = await session.lockCommunity(communityId);
      if (!community || community.status !== "active") throw new BookingAdminUnavailableError();
      const existing = await session.lockGuestLinks(communityId);
      const active = Boolean(existing && (!existing.expires_at || new Date(existing.expires_at) > now()));
      if (change.action === "generate" && active) {
        throw new BookingAdminValidationError(
          "active_link_exists", "An active guest link already exists. Rotate it instead.",
        );
      }
      if (["rotate", "revoke"].includes(change.action) && !active) {
        throw new BookingAdminValidationError(
          "no_active_link", "There is no active guest link to change.",
        );
      }
      if (existing) await session.revokeGuestLink(existing.id, actor.discordUserId);

      let token = null;
      let aggregateId = existing?.id ?? communityId;
      if (change.action !== "revoke") {
        token = createGuestToken();
        aggregateId = createId();
        await session.insertGuestLink({
          id: aggregateId, communityId, tokenHash: hashGuestShareToken(token),
          tokenHint: guestShareTokenHint(token), actorId: actor.discordUserId,
          rotatedFromLinkId: change.action === "rotate" ? existing.id : null,
        });
      }
      const correlationId = createId();
      await session.insertGuestLinkAudit({
        id: createId(), communityId, actorId: actor.discordUserId, correlationId,
        aggregateId, action: change.action,
        beforeData: { status: active ? "active" : "inactive" },
        afterData: { status: token ? "active" : "revoked" },
      });
      const snapshot = await session.readSnapshot(communityId, community);
      if (!snapshot) throw new BookingAdminUnavailableError();
      return Object.freeze({
        configuration: bookingAdminModel(gameProfile, snapshot),
        guestLinkPath: token ? `/book/${token}` : null,
      });
    });
  }

  return Object.freeze({ read, update, updateGuestLink });
}
