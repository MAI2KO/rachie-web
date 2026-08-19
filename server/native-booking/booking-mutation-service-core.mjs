import { createHash, randomUUID } from "node:crypto";

import { validateIdempotencyKey } from "./registration-validation.mjs";
import { validateRequirementAnswers, validateRescheduleChoice } from "./booking-creation-validation.mjs";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const scopedKey = (context, key) => sha256(`${context.gameProfile}\0${context.community.id}\0${context.discordUser.id}\0${key}`);
const canonical = (requirements) => Object.fromEntries(Object.entries(requirements).sort(([a], [b]) => a.localeCompare(b)).map(([code, value]) => [code, /^\d+$/.test(String(value).trim()) ? Number(String(value).trim()) : value]));

export class BookingMutationError extends Error {
  constructor(code, message) { super(message); this.name = "BookingMutationError"; this.code = code; }
}
export class BookingMutationIdempotencyConflictError extends BookingMutationError {
  constructor() { super("idempotency_conflict", "The idempotency key was already used for a different request."); }
}

function requestHash(context, operation, bookingId, payload) {
  return sha256(JSON.stringify({ operation, gameProfile: context.gameProfile, communityId: context.community.id, discordUserId: context.discordUser.id, bookingId, ...payload }));
}
function replayOrConflict(claim, operation, hash) {
  if (claim.state === "claimed") return null;
  const row = claim.record;
  if (!row || row.operation !== operation || row.request_hash !== hash || row.status !== "completed" || !Number.isInteger(row.response_status) || !row.response_body) throw new BookingMutationIdempotencyConflictError();
  return { status: row.response_status, body: row.response_body, replayed: true };
}
const publicAnswer = (answer) => ({ code: answer.code, label: answer.displayLabel, value: answer.value, ...(answer.unit ? { unit: answer.unit } : {}) });
const storedAnswers = (rows) => rows.map((row) => ({ code: row.requirement_code, label: row.display_label, value: Number(row.numeric_value), ...(row.unit ? { unit: row.unit } : {}) }));
const sameAnswers = (left, right) => JSON.stringify([...left].sort((a, b) => a.code.localeCompare(b.code))) === JSON.stringify([...right].sort((a, b) => a.code.localeCompare(b.code)));
const bookingPublic = (booking, serviceLabel, answers) => ({ bookingId: booking.id, serviceCode: booking.service_code, serviceLabel, date: booking.booking_date, displayTime: booking.display_time_label_snapshot, playerName: booking.in_game_name_snapshot, alliance: booking.alliance_snapshot, requirements: answers, status: booking.status });

async function lockOwnedActive(session, context, bookingId, lockedCommunity = null) {
  const community = lockedCommunity ?? await session.lockCommunityForBooking(context.community.id);
  if (!community || community.status !== "active") throw new BookingMutationError("booking_not_found", "Booking was not found.");
  const participants = await session.lockActiveParticipantsByDiscordUser(context.community.id, context.discordUser.id);
  if (participants.length !== 1) throw new BookingMutationError("registration_required", "An active participant registration is required.");
  const participant = participants[0];
  const booking = await session.lockOwnedBooking(context.community.id, participant.id, bookingId);
  if (!booking) throw new BookingMutationError("booking_not_found", "Booking was not found.");
  if (booking.status !== "confirmed") throw new BookingMutationError("booking_not_active", "Booking is not active.");
  return { community, participant, booking };
}

export function createBookingMutationService({ context, repository, createId = randomUUID, now = () => new Date() }) {
  if (repository.gameProfile !== context.gameProfile) throw new TypeError("Booking repository profile mismatch.");
  return Object.freeze({
    async reschedule(bookingId, input, publicKey) {
      const choice = validateRescheduleChoice(input);
      const key = scopedKey(context, validateIdempotencyKey(publicKey));
      const operation = "booking_reschedule";
      const hash = requestHash(context, operation, bookingId, { slotId: choice.slotId, requirements: canonical(choice.requirements) });
      try {
        return await repository.withTransaction(async (session) => {
          const correlationId = createId();
          await session.lockBookingMutation(bookingId);
          const lockedCommunity = await session.lockCommunityForBooking(context.community.id);
          const prior = replayOrConflict(await session.claimBookingMutationIdempotency({ communityId: context.community.id, idempotencyKey: key, operation, requestHash: hash, correlationId }), operation, hash);
          if (prior) return prior;
          const { community, participant, booking } = await lockOwnedActive(session, context, bookingId, lockedCommunity);
          if (!community.bookings_open) throw new BookingMutationError("bookings_closed", "Bookings are closed.");
          const target = await session.lockAppointmentSlot(context.community.id, choice.slotId);
          if (!target || target.window_id !== booking.window_id || target.service_code !== booking.service_code) throw new BookingMutationError("invalid_slot", "Invalid appointment slot.");
          const at = now();
          if (target.window_status !== "open" || (target.opens_at && new Date(target.opens_at) > at) || (target.closes_at && new Date(target.closes_at) <= at)) throw new BookingMutationError("booking_window_unavailable", "The booking window is unavailable.");
          if (!target.service_active || target.slot_status !== "available" || await session.hasActiveSlotBlock(target.id) || await session.hasConfirmedBookingForSlotExcluding(target.id, booking.id)) throw new BookingMutationError("slot_unavailable", "The selected slot is no longer available.");
          const answers = validateRequirementAnswers(context.gameProfile, booking.service_code, await session.findBookingSettings(context.community.id), choice.requirements);
          const publicAnswers = answers.map(publicAnswer);
          if (target.id === booking.slot_id) {
            const currentAnswers = storedAnswers(await session.listBookingRequirementAnswers(booking.id));
            if (sameAnswers(currentAnswers, publicAnswers)) {
              const body = { outcome: "unchanged", booking: bookingPublic(booking, booking.service_label, currentAnswers) };
              await session.completeBookingIdempotency(context.community.id, key, 200, body);
              return { status: 200, body, replayed: false };
            }
          }
          const replacementId = createId();
          const replacement = await session.replaceBookingAtomically({ oldBookingId: booking.id, newBookingId: replacementId, communityId: context.community.id, windowId: booking.window_id, serviceDateId: target.service_date_id, serviceCode: booking.service_code, bookingDate: target.booking_date, participantId: participant.id, discordUserId: context.discordUser.id, slotId: target.id, playerId: participant.player_id, inGameName: participant.in_game_name, alliance: participant.alliance, displayTime: target.display_time_label, idempotencyKey: key, correlationId });
          if (!replacement) throw new BookingMutationError("booking_not_active", "Booking is not active.");
          for (const answer of answers) await session.insertBookingRequirementAnswer({ bookingId: replacementId, ...answer });
          const body = { outcome: "rescheduled", booking: bookingPublic(replacement, target.service_label, publicAnswers) };
          const beforeData = { bookingId: booking.id, slotId: booking.slot_id, date: booking.booking_date, displayTime: booking.display_time_label_snapshot };
          const afterData = { bookingId: replacementId, replacesBookingId: booking.id, slotId: target.id, date: target.booking_date, displayTime: target.display_time_label, correlationId };
          await session.insertBookingMutationEvent({ id: createId(), communityId: context.community.id, bookingId: replacementId, eventType: "booking_rescheduled", actorId: context.discordUser.id, correlationId, beforeData, afterData });
          await session.insertBookingMutationOutbox({ id: createId(), communityId: context.community.id, eventType: "booking.rescheduled", idempotencyKey: `booking.rescheduled:${replacementId}`, correlationId, payload: { ...afterData, serviceCode: booking.service_code } });
          await session.completeBookingIdempotency(context.community.id, key, 200, body);
          return { status: 200, body, replayed: false };
        });
      } catch (error) {
        if (error?.code === "23505" && error.constraint === "minister_bookings_one_active_per_slot") throw new BookingMutationError("slot_unavailable", "The selected slot is no longer available.");
        throw error;
      }
    },

    async cancel(bookingId, publicKey) {
      const key = scopedKey(context, validateIdempotencyKey(publicKey));
      const operation = "booking_cancel";
      const hash = requestHash(context, operation, bookingId, {});
      return repository.withTransaction(async (session) => {
        const correlationId = createId();
        await session.lockBookingMutation(bookingId);
        const lockedCommunity = await session.lockCommunityForBooking(context.community.id);
        const prior = replayOrConflict(await session.claimBookingMutationIdempotency({ communityId: context.community.id, idempotencyKey: key, operation, requestHash: hash, correlationId }), operation, hash);
        if (prior) return prior;
        const { booking } = await lockOwnedActive(session, context, bookingId, lockedCommunity);
        const cancelled = await session.cancelOwnedBooking({ communityId: context.community.id, participantId: booking.participant_id, bookingId: booking.id, actorId: context.discordUser.id });
        if (!cancelled) throw new BookingMutationError("booking_not_active", "Booking is not active.");
        const body = { booking: { bookingId: cancelled.id, serviceCode: cancelled.service_code, serviceLabel: booking.service_label, date: cancelled.booking_date, displayTime: cancelled.display_time_label_snapshot, status: cancelled.status } };
        const beforeData = { bookingId: booking.id, slotId: booking.slot_id, status: booking.status };
        const afterData = { bookingId: booking.id, status: "cancelled", correlationId };
        await session.insertBookingMutationEvent({ id: createId(), communityId: context.community.id, bookingId: booking.id, eventType: "booking_cancelled", actorId: context.discordUser.id, correlationId, beforeData, afterData });
        await session.insertBookingMutationOutbox({ id: createId(), communityId: context.community.id, eventType: "booking.cancelled", idempotencyKey: `booking.cancelled:${booking.id}`, correlationId, payload: { ...afterData, serviceCode: booking.service_code } });
        await session.completeBookingIdempotency(context.community.id, key, 200, body);
        return { status: 200, body, replayed: false };
      });
    },
  });
}
