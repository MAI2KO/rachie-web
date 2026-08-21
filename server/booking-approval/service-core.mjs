import { createHash, randomUUID } from "node:crypto";

import { validateIdempotencyKey } from "../native-booking/registration-validation.mjs";
import {
  adminApprovalRequest,
  approvalDateOnly,
  APPROVAL_REQUEST_STATES,
  assertTrustedManagerContext,
  BookingApprovalTransitionError,
  DEFAULT_PENDING_HOLD_SECONDS,
  GuestBookingRequestError,
  hashGuestShareToken,
  managerAppointmentBoard,
  publicAppointmentBoard,
  validateGuestBookingInput,
  validateGuestRequirementAnswers,
} from "./domain-core.mjs";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const canonicalRequirements = (requirements) => Object.fromEntries(
  Object.entries(requirements).sort(([left], [right]) => left.localeCompare(right)),
);

export class GuestBookingIdempotencyConflictError extends GuestBookingRequestError {
  constructor() {
    super("idempotency_conflict", "The idempotency key was already used for a different guest request.");
  }
}

function replay(claim, requestHash) {
  if (claim.state === "claimed") return null;
  const row = claim.record;
  if (!row || row.operation !== "guest_booking_request"
      || row.request_hash !== requestHash || row.status !== "completed"
      || !Number.isInteger(row.response_status) || !row.response_body) {
    throw new GuestBookingIdempotencyConflictError();
  }
  return { status: row.response_status, body: row.response_body, replayed: true };
}

function assertBookableSlot(slot, input, at) {
  if (!slot || slot.service_code !== input.serviceCode) {
    throw new GuestBookingRequestError("invalid_slot", "Invalid appointment slot.");
  }
  if (!slot.service_active) {
    throw new GuestBookingRequestError("invalid_service", "The selected service is unavailable.");
  }
  if (slot.window_status !== "open"
      || (slot.opens_at && new Date(slot.opens_at) > at)
      || (slot.closes_at && new Date(slot.closes_at) <= at)) {
    throw new GuestBookingRequestError("booking_window_unavailable", "The booking window is unavailable.");
  }
  if (slot.slot_status !== "available") {
    throw new GuestBookingRequestError("slot_unavailable", "The selected slot is no longer available.");
  }
}

async function recordExpiry(session, request, at, createId) {
  await session.insertApprovalEvent({
    id: createId(),
    communityId: request.community_id,
    requestId: request.id,
    action: "expired",
    actorType: "system",
    previousState: APPROVAL_REQUEST_STATES.PENDING_APPROVAL,
    resultingState: APPROVAL_REQUEST_STATES.EXPIRED,
    correlationId: request.correlation_id,
    metadata: { expiredAt: at.toISOString() },
  });
  await session.markRequestMessagesForUpdate(request.id);
  await session.insertApprovalOutbox({
    id: createId(),
    communityId: request.community_id,
    eventType: "booking.approval.expired",
    idempotencyKey: `booking.approval.expired:${request.id}`,
    correlationId: request.correlation_id,
    payload: { requestId: request.id, status: APPROVAL_REQUEST_STATES.EXPIRED },
  });
}

export function createGuestBookingRequestService({
  gameProfile,
  repository,
  createId = randomUUID,
  now = () => new Date(),
}) {
  if (repository.gameProfile !== gameProfile) throw new TypeError("Approval repository profile mismatch.");
  return Object.freeze({
    async create(rawToken, rawInput, publicIdempotencyKey) {
      const tokenHash = hashGuestShareToken(rawToken);
      const input = validateGuestBookingInput(rawInput);
      const publicKey = validateIdempotencyKey(publicIdempotencyKey);
      try {
        return await repository.withTransaction(async (session) => {
          const link = await session.findActiveShareLink(tokenHash);
          if (!link || link.community_status !== "active") {
            throw new GuestBookingRequestError("invalid_share_link", "Guest booking link is invalid or unavailable.");
          }
          const scopedKey = sha256(`${gameProfile}\0${link.community_id}\0${link.id}\0${publicKey}`);
          const requestHash = sha256(JSON.stringify({
            operation: "guest_booking_request",
            gameProfile,
            communityId: link.community_id,
            shareLinkId: link.id,
            playerId: input.playerId,
            inGameName: input.inGameName,
            alliance: input.alliance,
            serviceCode: input.serviceCode,
            slotId: input.slotId,
            requirements: canonicalRequirements(input.requirements),
          }));
          const correlationId = createId();
          const community = await session.lockCommunity(link.community_id);
          const prior = replay(await session.claimGuestRequestIdempotency({
            communityId: link.community_id,
            idempotencyKey: scopedKey,
            requestHash,
            correlationId,
          }), requestHash);
          if (prior) return prior;
          if (!community || community.status !== "active" || !community.bookings_open) {
            throw new GuestBookingRequestError("bookings_closed", "Bookings are closed.");
          }

          const at = now();
          const slot = await session.lockSlot(link.community_id, input.slotId);
          assertBookableSlot(slot, input, at);
          for (const expired of await session.expirePendingForSlot(slot.id, at)) {
            await recordExpiry(session, {
              id: expired.id,
              community_id: expired.community_id,
              correlation_id: expired.correlation_id,
            }, at, createId);
          }
          if (await session.hasActiveApprovalHold(slot.id, at)
              || await session.hasActiveSlotBlock(slot.id)
              || await session.hasConfirmedBooking(slot.id)) {
            throw new GuestBookingRequestError("slot_unavailable", "The selected slot is no longer available.");
          }

          const settings = await session.findSettings(link.community_id);
          const answers = validateGuestRequirementAnswers(gameProfile, input, settings);
          const holdSeconds = Number.isInteger(settings?.pending_hold_duration_seconds)
            ? settings.pending_hold_duration_seconds
            : DEFAULT_PENDING_HOLD_SECONDS;
          const requestId = createId();
          const holdExpiresAt = new Date(at.getTime() + holdSeconds * 1000);
          const request = await session.insertApprovalRequest({
            id: requestId,
            communityId: link.community_id,
            windowId: slot.window_id,
            serviceDateId: slot.service_date_id,
            serviceCode: slot.service_code,
            bookingDate: slot.booking_date,
            slotId: slot.id,
            shareLinkId: link.id,
            playerId: input.playerId,
            inGameName: input.inGameName,
            alliance: input.alliance,
            displayTime: slot.display_time_label,
            holdExpiresAt,
            idempotencyKey: scopedKey,
            correlationId,
          });
          for (const answer of answers) {
            await session.insertRequestAnswer({ requestId, ...answer });
          }
          await session.insertApprovalEvent({
            id: createId(),
            communityId: link.community_id,
            requestId,
            action: "submitted",
            actorType: "guest",
            resultingState: APPROVAL_REQUEST_STATES.PENDING_APPROVAL,
            correlationId,
            metadata: { serviceCode: slot.service_code, slotId: slot.id },
          });
          await session.insertApprovalOutbox({
            id: createId(),
            communityId: link.community_id,
            eventType: "booking.approval.requested",
            idempotencyKey: `booking.approval.requested:${requestId}`,
            correlationId,
            payload: { requestId, serviceCode: slot.service_code, slotId: slot.id },
          });
          const body = {
            request: {
              requestId: request.id,
              service: request.service_code,
              date: approvalDateOnly(request.booking_date),
              time: request.display_time_label_snapshot,
              status: request.status,
              holdExpiresAt: request.hold_expires_at,
            },
          };
          await session.completeIdempotency(link.community_id, scopedKey, 202, body);
          return { status: 202, body, replayed: false };
        });
      } catch (error) {
        if (error?.code === "23505"
            && ["booking_approval_requests_one_pending_per_slot", "minister_bookings_one_active_per_slot"].includes(error.constraint)) {
          throw new GuestBookingRequestError("slot_unavailable", "The selected slot is no longer available.");
        }
        throw error;
      }
    },
  });
}

async function lockedActionRequest(session, communityId, requestId) {
  const candidate = await session.findRequest(requestId);
  if (!candidate || candidate.community_id !== communityId) {
    throw new BookingApprovalTransitionError("request_not_found", "Booking request was not found.");
  }
  await session.lockSlot(communityId, candidate.slot_id);
  const request = await session.lockRequest(requestId);
  if (!request || request.community_id !== communityId) {
    throw new BookingApprovalTransitionError("request_not_found", "Booking request was not found.");
  }
  return request;
}

export function createBookingApprovalService({
  gameProfile,
  communityId,
  managerContext,
  repository,
  createId = randomUUID,
  now = () => new Date(),
}) {
  if (repository.gameProfile !== gameProfile) throw new TypeError("Approval repository profile mismatch.");
  const actor = assertTrustedManagerContext(managerContext, gameProfile, communityId);

  async function expireLocked(session, request, at) {
    const expired = await session.expireRequest(request.id, at);
    if (!expired) return null;
    await recordExpiry(session, expired, at, createId);
    return expired;
  }

  return Object.freeze({
    async approve(requestId) {
      return repository.withTransaction(async (session) => {
        const at = now();
        const request = await lockedActionRequest(session, communityId, requestId);
        if (request.status !== APPROVAL_REQUEST_STATES.PENDING_APPROVAL) {
          throw new BookingApprovalTransitionError("invalid_transition", "Booking request has already been decided.");
        }
        if (new Date(request.hold_expires_at) <= at) {
          const expired = await expireLocked(session, request, at);
          return { outcome: "expired", request: adminApprovalRequest({ ...expired, requirements: [], audit: [] }) };
        }
        if (await session.hasActiveSlotBlock(request.slot_id)
            || await session.hasConfirmedBooking(request.slot_id)) {
          throw new BookingApprovalTransitionError("slot_unavailable", "The held slot is no longer available.");
        }
        const correlationId = createId();
        const bookingId = createId();
        const booking = await session.insertConfirmedBookingFromRequest(
          request,
          bookingId,
          actor,
          correlationId,
        );
        await session.copyRequestAnswersToBooking(request.id, bookingId);
        const confirmed = await session.confirmRequest(request.id, bookingId, actor, at);
        if (!confirmed) throw new BookingApprovalTransitionError("invalid_transition", "Booking request could not be approved.");
        await session.insertApprovalEvent({
          id: createId(), communityId, requestId: request.id, action: "approved",
          actorType: "discord_user", actorDiscordUserId: actor.discordUserId,
          actorDisplayName: actor.displayName,
          previousState: APPROVAL_REQUEST_STATES.PENDING_APPROVAL,
          resultingState: APPROVAL_REQUEST_STATES.CONFIRMED,
          correlationId,
          metadata: { bookingId },
        });
        await session.markRequestMessagesForUpdate(request.id);
        await session.insertApprovalOutbox({
          id: createId(), communityId, eventType: "booking.approval.confirmed",
          idempotencyKey: `booking.approval.confirmed:${request.id}`,
          correlationId,
          payload: { requestId: request.id, bookingId, status: APPROVAL_REQUEST_STATES.CONFIRMED },
        });
        return {
          outcome: "confirmed",
          booking: {
            bookingId: booking.id,
            service: booking.service_code,
            date: approvalDateOnly(booking.booking_date),
            time: booking.display_time_label_snapshot,
            playerName: booking.in_game_name_snapshot,
          },
        };
      });
    },

    async deny(requestId) {
      return repository.withTransaction(async (session) => {
        const at = now();
        const request = await lockedActionRequest(session, communityId, requestId);
        if (request.status !== APPROVAL_REQUEST_STATES.PENDING_APPROVAL) {
          throw new BookingApprovalTransitionError("invalid_transition", "Booking request has already been decided.");
        }
        if (new Date(request.hold_expires_at) <= at) {
          const expired = await expireLocked(session, request, at);
          return { outcome: "expired", requestId: expired.id };
        }
        const denied = await session.denyRequest(request.id, actor, at);
        if (!denied) throw new BookingApprovalTransitionError("invalid_transition", "Booking request could not be denied.");
        const correlationId = createId();
        await session.insertApprovalEvent({
          id: createId(), communityId, requestId: request.id, action: "denied",
          actorType: "discord_user", actorDiscordUserId: actor.discordUserId,
          actorDisplayName: actor.displayName,
          previousState: APPROVAL_REQUEST_STATES.PENDING_APPROVAL,
          resultingState: APPROVAL_REQUEST_STATES.DENIED,
          correlationId,
        });
        await session.markRequestMessagesForUpdate(request.id);
        await session.insertApprovalOutbox({
          id: createId(), communityId, eventType: "booking.approval.denied",
          idempotencyKey: `booking.approval.denied:${request.id}`,
          correlationId,
          payload: { requestId: request.id, status: APPROVAL_REQUEST_STATES.DENIED },
        });
        return { outcome: "denied", requestId: denied.id };
      });
    },

    async expire(requestId) {
      return repository.withTransaction(async (session) => {
        const at = now();
        const request = await lockedActionRequest(session, communityId, requestId);
        if (request.status !== APPROVAL_REQUEST_STATES.PENDING_APPROVAL) {
          throw new BookingApprovalTransitionError("invalid_transition", "Booking request has already been decided.");
        }
        if (new Date(request.hold_expires_at) > at) {
          throw new BookingApprovalTransitionError("hold_active", "Booking request hold has not expired.");
        }
        const expired = await expireLocked(session, request, at);
        if (!expired) throw new BookingApprovalTransitionError("invalid_transition", "Booking request could not be expired.");
        return { outcome: "expired", requestId: expired.id };
      });
    },
  });
}

export function createBookingBoardReadService({
  gameProfile,
  communityId,
  repository,
  managerContext = /** @type {any} */ (null),
  now = () => new Date(),
}) {
  if (repository.gameProfile !== gameProfile) throw new TypeError("Approval repository profile mismatch.");
  return Object.freeze({
    async publicBoard() {
      return repository.withTransaction(async (session) => {
        const community = await session.findActiveCommunityById(communityId);
        if (!community) throw new BookingApprovalTransitionError("community_not_found", "Community was not found.");
        return publicAppointmentBoard(community, await session.listBoardRows(communityId, now()));
      });
    },
    async managerBoard() {
      assertTrustedManagerContext(managerContext, gameProfile, communityId);
      return repository.withTransaction(async (session) => {
        const community = await session.findActiveCommunityById(communityId);
        if (!community) throw new BookingApprovalTransitionError("community_not_found", "Community was not found.");
        const [rows, activity] = await Promise.all([
          session.listManagerBoardRows(communityId, now()),
          session.listRecentApprovalActivity(communityId, 50),
        ]);
        return managerAppointmentBoard(community, rows, activity);
      });
    },
    async adminRequest(requestId) {
      assertTrustedManagerContext(managerContext, gameProfile, communityId);
      return repository.withTransaction(async (session) => {
        const row = await session.findRequestDetail(communityId, requestId);
        if (!row) throw new BookingApprovalTransitionError("request_not_found", "Booking request was not found.");
        return adminApprovalRequest(row);
      });
    },
  });
}
