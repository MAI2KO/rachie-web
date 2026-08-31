import { createHash, randomUUID } from "node:crypto";

import { assertTrustedManagerContext } from "../booking-approval/domain-core.mjs";
import {
  BookingMutationError,
  BookingMutationIdempotencyConflictError,
} from "../native-booking/booking-mutation-service-core.mjs";
import { validateIdempotencyKey } from "../native-booking/registration-validation.mjs";
import {
  validateGuestBookingInput,
  validateGuestRequirementAnswers,
} from "../booking-approval/domain-core.mjs";
import {
  APPOINTMENT_CONFIRMED_POINTS,
  CYCLE_DISCORD_PARTICIPATION_POINTS,
  POINT_REASONS,
} from "../points/domain-core.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function validateSlotId(value) {
  const slotId = typeof value === "string" ? value.trim() : "";
  if (!UUID_PATTERN.test(slotId)) {
    throw new BookingMutationError("invalid_slot", "Invalid appointment slot.");
  }
  return slotId;
}

function scopedKey(gameProfile, communityId, actorId, publicKey) {
  return sha256(`${gameProfile}\0${communityId}\0manager\0${actorId}\0${publicKey}`);
}

function requestHash(gameProfile, communityId, actorId, operation, bookingId, payload) {
  return sha256(JSON.stringify({ gameProfile, communityId, actorId, operation, bookingId, ...payload }));
}

function replayOrConflict(claim, operation, hash) {
  if (claim.state === "claimed") return null;
  const row = claim.record;
  if (!row || row.operation !== operation || row.request_hash !== hash
      || row.status !== "completed" || !Number.isInteger(row.response_status)
      || !row.response_body) {
    throw new BookingMutationIdempotencyConflictError();
  }
  return { status: row.response_status, body: row.response_body, replayed: true };
}

const publicBooking = (booking, serviceLabel) => ({
  bookingId: booking.id,
  serviceCode: booking.service_code,
  serviceLabel,
  date: booking.booking_date,
  displayTime: booking.display_time_label_snapshot,
  status: booking.status,
});

async function lockActiveBooking(session, communityId, bookingId) {
  const community = await session.lockCommunityForBooking(communityId);
  if (!community || community.status !== "active") {
    throw new BookingMutationError("booking_not_found", "Booking was not found.");
  }
  const booking = await session.lockCommunityBooking(communityId, bookingId);
  if (!booking) throw new BookingMutationError("booking_not_found", "Booking was not found.");
  if (booking.status !== "confirmed") {
    throw new BookingMutationError("booking_not_active", "Booking is not active.");
  }
  return booking;
}

export function createManagerBookingMutationService({
  gameProfile,
  communityId,
  managerContext,
  repository,
  createId = randomUUID,
  now = () => new Date(),
}) {
  if (repository.gameProfile !== gameProfile) throw new TypeError("Booking repository profile mismatch.");
  const actor = assertTrustedManagerContext(managerContext, gameProfile, communityId);

  return Object.freeze({
    async create(rawInput, publicIdempotencyKey) {
      const input = validateGuestBookingInput(rawInput);
      const key = scopedKey(gameProfile, communityId, actor.discordUserId,
        validateIdempotencyKey(publicIdempotencyKey));
      const operation = "manager_manual_booking";
      const hash = requestHash(gameProfile, communityId, actor.discordUserId,
        operation, null, input);
      try {
        return await repository.withTransaction(async (session) => {
          const correlationId = createId();
          const community = await session.lockCommunityForBooking(communityId);
          const prior = replayOrConflict(await session.claimBookingMutationIdempotency({
            communityId, idempotencyKey: key, operation, requestHash: hash, correlationId,
          }), operation, hash);
          if (prior) return prior;
          if (!community || community.status !== "active") {
            throw new BookingMutationError("community_unavailable", "The community is unavailable.");
          }
          const slot = await session.lockAppointmentSlot(communityId, input.slotId);
          if (!slot || slot.service_code !== input.serviceCode) {
            throw new BookingMutationError("invalid_slot", "Invalid appointment slot.");
          }
          if (!slot.service_active) {
            throw new BookingMutationError("invalid_service", "The selected service is unavailable.");
          }
          const at = now();
          if (slot.slot_status !== "available"
              || await session.hasActiveSlotBlock(slot.id)
              || await session.hasActiveApprovalHoldForSlot(slot.id, at)
              || await session.hasConfirmedBookingForSlot(slot.id)) {
            throw new BookingMutationError("slot_unavailable", "The selected slot is no longer available.");
          }
          if (await session.hasConfirmedBookingForPlayerService(
            communityId, slot.window_id, input.serviceCode, input.playerId,
          )) {
            throw new BookingMutationError("booking_already_exists",
              "This Player ID already has an appointment for this service and cycle.");
          }
          const settings = await session.findBookingSettings(communityId);
          const answers = validateGuestRequirementAnswers(gameProfile, input, settings);
          const participant = await session.findUniqueActiveParticipantForManualBooking(
            communityId, input.playerId, input.inGameName, input.alliance,
          );
          const bookingId = createId();
          const booking = await session.insertConfirmedBooking({
            id: bookingId, communityId, windowId: slot.window_id,
            serviceDateId: slot.service_date_id, serviceCode: slot.service_code,
            bookingDate: slot.booking_date, slotId: slot.id, playerId: input.playerId,
            inGameName: input.inGameName, alliance: input.alliance,
            displayTime: slot.display_time_label, actorId: actor.discordUserId,
            source: "admin", actorType: "admin",
            participantId: participant?.id, discordUserId: participant?.discord_user_id,
            sourceGuildId: participant?.source_discord_guild_id,
            idempotencyKey: key, correlationId,
          });
          for (const answer of answers) {
            await session.insertBookingRequirementAnswer({ bookingId, ...answer });
          }
          const afterData = {
            action: "manager_manual_booking", bookingId, serviceCode: slot.service_code,
            slotId: slot.id, date: String(slot.booking_date).slice(0, 10),
            displayTime: slot.display_time_label, playerId: input.playerId,
            playerName: input.inGameName, alliance: input.alliance,
            actorDisplayName: actor.displayName, correlationId,
          };
          await session.insertBookingMutationEvent({
            id: createId(), communityId, bookingId,
            eventType: "manager_manual_booking", actorId: actor.discordUserId,
            correlationId, beforeData: {}, afterData,
          });
          await session.insertBookingMutationOutbox({
            id: createId(), communityId, eventType: "booking.created",
            idempotencyKey: `manager.booking.created:${bookingId}`, correlationId,
            payload: afterData,
          });
          if (participant) {
            await session.insertPlayerPointsEntry({
              id: createId(), participantId: participant.id, communityId,
              discordUserId: participant.discord_user_id,
              pointsDelta: APPOINTMENT_CONFIRMED_POINTS,
              reason: POINT_REASONS.appointmentConfirmed,
              bookingWindowId: slot.window_id, bookingId,
              sourceGuildId: participant.source_discord_guild_id,
              idempotencyKey: `appointment_confirmed:${participant.id}:${slot.window_id}:${slot.service_code}`,
              metadata: { serviceCode: slot.service_code, createdByManager: true },
            });
            if (participant.source_discord_guild_id) {
              await session.insertCommunityParticipationPoints({
                id: createId(), communityId,
                sourceGuildId: participant.source_discord_guild_id,
                bookingWindowId: slot.window_id,
                pointsDelta: CYCLE_DISCORD_PARTICIPATION_POINTS,
                reason: POINT_REASONS.cycleDiscordParticipation,
                idempotencyKey: `cycle_discord_participation:${slot.window_id}:${participant.source_discord_guild_id}`,
                metadata: { firstQualifyingBookingId: bookingId },
              });
            }
          }
          const body = {
            outcome: "created",
            booking: { ...publicBooking(booking, slot.service_label),
              playerName: booking.in_game_name_snapshot,
              alliance: booking.alliance_snapshot },
          };
          await session.completeBookingIdempotency(communityId, key, 201, body);
          return { status: 201, body, replayed: false };
        });
      } catch (error) {
        if (error?.code === "23505") {
          if (error.constraint === "minister_bookings_one_active_per_slot") {
            throw new BookingMutationError("slot_unavailable", "The selected slot is no longer available.");
          }
          if (["minister_bookings_one_active_player_service",
            "minister_bookings_one_active_participant_service"].includes(error.constraint)) {
            throw new BookingMutationError("booking_already_exists",
              "This Player ID already has an appointment for this service and cycle.");
          }
        }
        throw error;
      }
    },

    async reschedule(bookingId, rawSlotId, publicIdempotencyKey) {
      const slotId = validateSlotId(rawSlotId);
      const key = scopedKey(gameProfile, communityId, actor.discordUserId,
        validateIdempotencyKey(publicIdempotencyKey));
      const operation = "manager_booking_reschedule";
      const hash = requestHash(gameProfile, communityId, actor.discordUserId,
        operation, bookingId, { slotId });
      try {
        return await repository.withTransaction(async (session) => {
          const correlationId = createId();
          await session.lockBookingMutation(bookingId);
          const prior = replayOrConflict(await session.claimBookingMutationIdempotency({
            communityId, idempotencyKey: key, operation, requestHash: hash, correlationId,
          }), operation, hash);
          if (prior) return prior;
          const booking = await lockActiveBooking(session, communityId, bookingId);
          await session.lockAppointmentSlot(communityId, booking.slot_id);
          const target = await session.lockAppointmentSlot(communityId, slotId);
          if (!target || target.window_id !== booking.window_id
              || target.service_code !== booking.service_code
              || target.service_date_id !== booking.service_date_id) {
            throw new BookingMutationError("invalid_slot", "Invalid appointment slot.");
          }
          if (target.id === booking.slot_id) {
            const body = { outcome: "unchanged", booking: publicBooking(booking, booking.service_label) };
            await session.completeBookingIdempotency(communityId, key, 200, body);
            return { status: 200, body, replayed: false };
          }
          const at = now();
          if (!target.service_active || target.slot_status !== "available"
              || await session.hasActiveSlotBlock(target.id)
              || await session.hasActiveApprovalHoldForSlot(target.id, at)
              || await session.hasConfirmedBookingForSlotExcluding(target.id, booking.id)) {
            throw new BookingMutationError("slot_unavailable", "The selected slot is no longer available.");
          }
          const replacementId = createId();
          const replacement = await session.replaceBookingAsManager({
            oldBookingId: booking.id,
            newBookingId: replacementId,
            communityId,
            serviceDateId: target.service_date_id,
            bookingDate: target.booking_date,
            slotId: target.id,
            displayTime: target.display_time_label,
            idempotencyKey: key,
            actorId: actor.discordUserId,
            correlationId,
          });
          if (!replacement) throw new BookingMutationError("booking_not_active", "Booking is not active.");
          await session.copyBookingRequirementAnswers(booking.id, replacementId);
          const beforeData = {
            bookingId: booking.id, slotId: booking.slot_id,
            date: booking.booking_date, displayTime: booking.display_time_label_snapshot,
            status: booking.status,
          };
          const afterData = {
            bookingId: replacementId, replacesBookingId: booking.id, slotId: target.id,
            date: target.booking_date, displayTime: target.display_time_label,
            status: "confirmed", actorDisplayName: actor.displayName, correlationId,
          };
          await session.insertBookingMutationEvent({
            id: createId(), communityId, bookingId: replacementId,
            eventType: "manager_booking_rescheduled", actorId: actor.discordUserId,
            correlationId, beforeData, afterData,
          });
          await session.insertBookingMutationOutbox({
            id: createId(), communityId, eventType: "booking.rescheduled",
            idempotencyKey: `manager.booking.rescheduled:${replacementId}`,
            correlationId,
            payload: { ...afterData, serviceCode: booking.service_code },
          });
          const body = {
            outcome: "rescheduled",
            booking: publicBooking(replacement, target.service_label),
          };
          await session.completeBookingIdempotency(communityId, key, 200, body);
          return { status: 200, body, replayed: false };
        });
      } catch (error) {
        if (error?.code === "23505"
            && error.constraint === "minister_bookings_one_active_per_slot") {
          throw new BookingMutationError("slot_unavailable", "The selected slot is no longer available.");
        }
        throw error;
      }
    },

    async cancel(bookingId, publicIdempotencyKey) {
      const key = scopedKey(gameProfile, communityId, actor.discordUserId,
        validateIdempotencyKey(publicIdempotencyKey));
      const operation = "manager_booking_cancel";
      const hash = requestHash(gameProfile, communityId, actor.discordUserId,
        operation, bookingId, {});
      return repository.withTransaction(async (session) => {
        const correlationId = createId();
        await session.lockBookingMutation(bookingId);
        const prior = replayOrConflict(await session.claimBookingMutationIdempotency({
          communityId, idempotencyKey: key, operation, requestHash: hash, correlationId,
        }), operation, hash);
        if (prior) return prior;
        const booking = await lockActiveBooking(session, communityId, bookingId);
        await session.lockAppointmentSlot(communityId, booking.slot_id);
        const cancelled = await session.cancelBookingAsManager({
          communityId, bookingId: booking.id, actorId: actor.discordUserId,
        });
        if (!cancelled) throw new BookingMutationError("booking_not_active", "Booking is not active.");
        const beforeData = {
          bookingId: booking.id, slotId: booking.slot_id, status: booking.status,
          date: booking.booking_date, displayTime: booking.display_time_label_snapshot,
        };
        const afterData = {
          bookingId: booking.id, status: "cancelled",
          actorDisplayName: actor.displayName, correlationId,
        };
        await session.insertBookingMutationEvent({
          id: createId(), communityId, bookingId: booking.id,
          eventType: "manager_booking_cancelled", actorId: actor.discordUserId,
          correlationId, beforeData, afterData,
        });
        await session.insertBookingMutationOutbox({
          id: createId(), communityId, eventType: "booking.cancelled",
          idempotencyKey: `manager.booking.cancelled:${booking.id}`,
          correlationId,
          payload: { ...afterData, serviceCode: booking.service_code },
        });
        const body = { outcome: "cancelled", booking: publicBooking(cancelled, booking.service_label) };
        await session.completeBookingIdempotency(communityId, key, 200, body);
        return { status: 200, body, replayed: false };
      });
    },
  });
}
