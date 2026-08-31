import { createHash, randomUUID } from "node:crypto";

import { validateBookingChoice, validateIdempotencyKey, validateRequirementAnswers } from "./booking-creation-validation.mjs";
import {
  APPOINTMENT_CONFIRMED_POINTS,
  CYCLE_DISCORD_PARTICIPATION_POINTS,
  POINT_REASONS,
} from "../points/domain-core.mjs";

const OPERATION = "booking_create";

export class BookingCreationError extends Error {
  constructor(code, message) { super(message); this.name = "BookingCreationError"; this.code = code; }
}
export class BookingIdempotencyConflictError extends BookingCreationError {
  constructor() { super("idempotency_conflict", "The idempotency key was already used for a different request."); }
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const scopedKey = (context, key) => sha256(`${context.gameProfile}\0${context.community.id}\0${context.discordUser.id}\0${key}`);
const canonicalRequirements = (requirements) => Object.fromEntries(
  Object.entries(requirements)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, value]) => {
      const text = typeof value === "number" || typeof value === "string"
        ? String(value).trim()
        : value;
      return [code, typeof text === "string" && /^\d+$/.test(text) ? Number(text) : text];
    }),
);
const fingerprint = (context, choice) => sha256(JSON.stringify({ operation: OPERATION, gameProfile: context.gameProfile, communityId: context.community.id, discordUserId: context.discordUser.id, serviceCode: choice.serviceCode, slotId: choice.slotId, requirements: canonicalRequirements(choice.requirements) }));

function replay(claim, hash) {
  if (claim.state === "claimed") return null;
  const record = claim.record;
  if (!record || record.operation !== OPERATION || record.request_hash !== hash || record.status !== "completed" || !Number.isInteger(record.response_status) || !record.response_body) throw new BookingIdempotencyConflictError();
  return { status: record.response_status, body: record.response_body, replayed: true };
}

function publicAnswer(answer) { return { code: answer.code, label: answer.displayLabel, value: answer.value, ...(answer.unit ? { unit: answer.unit } : {}) }; }

export function createBookingCreationService({ context, repository, createId = randomUUID, now = () => new Date() }) {
  if (repository.gameProfile !== context.gameProfile) throw new TypeError("Booking repository profile mismatch.");
  return Object.freeze({
    async create(input, publicIdempotencyKey) {
      const choice = validateBookingChoice(input);
      const key = scopedKey(context, validateIdempotencyKey(publicIdempotencyKey));
      const hash = fingerprint(context, choice);
      try {
        return await repository.withTransaction(async (session) => {
          const correlationId = createId();
          const community = await session.lockCommunityForBooking(context.community.id);
          const claim = await session.claimBookingIdempotency({ communityId: context.community.id, idempotencyKey: key, requestHash: hash, correlationId });
          const prior = replay(claim, hash);
          if (prior) return prior;

          if (!community || community.status !== "active" || !community.bookings_open) throw new BookingCreationError("bookings_closed", "Bookings are closed.");
          const participants = await session.lockActiveParticipantsByDiscordUser(context.community.id, context.discordUser.id);
          if (participants.length !== 1) throw new BookingCreationError("registration_required", "An active participant registration is required.");
          const participant = participants[0];
          const slot = await session.lockAppointmentSlot(context.community.id, choice.slotId);
          if (!slot || slot.service_code !== choice.serviceCode) throw new BookingCreationError("invalid_slot", "Invalid appointment slot.");
          if (!slot.service_active) throw new BookingCreationError("invalid_service", "The selected service is unavailable.");
          const at = now();
          if (slot.window_status !== "open" || (slot.opens_at && new Date(slot.opens_at) > at) || (slot.closes_at && new Date(slot.closes_at) <= at)) throw new BookingCreationError("booking_window_unavailable", "The booking window is unavailable.");
          if (slot.slot_status !== "available"
              || await session.hasActiveSlotBlock(slot.id)
              || await session.hasActiveApprovalHoldForSlot(slot.id, at)
              || await session.hasConfirmedBookingForSlot(slot.id)) throw new BookingCreationError("slot_unavailable", "The selected slot is no longer available.");
          if (await session.hasConfirmedBookingForParticipantService(context.community.id, slot.window_id, choice.serviceCode, participant.id)) throw new BookingCreationError("booking_already_exists", "A booking already exists for this service and window.");
          const settings = await session.findBookingSettings(context.community.id);
          const answers = validateRequirementAnswers(context.gameProfile, choice.serviceCode, settings, choice.requirements);
          const bookingId = createId();
          const sourceGuildId = context.community.discordGuildId
            ?? participant.source_discord_guild_id ?? null;
          const booking = await session.insertConfirmedBooking({ id: bookingId, communityId: context.community.id, windowId: slot.window_id, serviceDateId: slot.service_date_id, serviceCode: choice.serviceCode, bookingDate: slot.booking_date, slotId: slot.id, participantId: participant.id, discordUserId: context.discordUser.id, playerId: participant.player_id, inGameName: participant.in_game_name, alliance: participant.alliance, displayTime: slot.display_time_label, source: "website", actorType: "discord_user", actorId: context.discordUser.id, idempotencyKey: key, correlationId, sourceGuildId });
          for (const answer of answers) await session.insertBookingRequirementAnswer({ bookingId, ...answer });
          const body = { booking: { bookingId: booking.id, serviceCode: booking.service_code, serviceLabel: slot.service_label, date: booking.booking_date, displayTime: booking.display_time_label_snapshot, playerName: booking.in_game_name_snapshot, alliance: booking.alliance_snapshot, requirements: answers.map(publicAnswer), status: booking.status } };
          const boundedEvent = { bookingId, serviceCode: choice.serviceCode, slotId: slot.id, participant: { playerId: participant.player_id, inGameName: participant.in_game_name, alliance: participant.alliance }, correlationId };
          await session.insertBookingCreatedEvent({ id: createId(), communityId: context.community.id, bookingId, actorId: context.discordUser.id, correlationId, afterData: boundedEvent });
          await session.insertBookingOutboxEvent({ id: createId(), communityId: context.community.id, idempotencyKey: `booking.created:${bookingId}`, correlationId, payload: boundedEvent });
          await session.insertPlayerPointsEntry({
            id: createId(), participantId: participant.id, communityId: context.community.id,
            discordUserId: context.discordUser.id, pointsDelta: APPOINTMENT_CONFIRMED_POINTS,
            reason: POINT_REASONS.appointmentConfirmed, bookingWindowId: slot.window_id,
            bookingId, sourceGuildId,
            idempotencyKey: `appointment_confirmed:${participant.id}:${slot.window_id}:${choice.serviceCode}`,
            metadata: { serviceCode: choice.serviceCode },
          });
          if (sourceGuildId) {
            await session.insertCommunityParticipationPoints({
              id: createId(), communityId: context.community.id, sourceGuildId,
              bookingWindowId: slot.window_id, pointsDelta: CYCLE_DISCORD_PARTICIPATION_POINTS,
              reason: POINT_REASONS.cycleDiscordParticipation,
              idempotencyKey: `cycle_discord_participation:${slot.window_id}:${sourceGuildId}`,
              metadata: { firstQualifyingBookingId: bookingId },
            });
          }
          await session.completeBookingIdempotency(context.community.id, key, 201, body);
          return { status: 201, body, replayed: false };
        });
      } catch (error) {
        if (error?.code === "23505") {
          if (error.constraint === "minister_bookings_one_active_per_slot") throw new BookingCreationError("slot_unavailable", "The selected slot is no longer available.");
          if (["minister_bookings_one_active_player_service", "minister_bookings_one_active_participant_service"].includes(error.constraint)) throw new BookingCreationError("booking_already_exists", "A booking already exists for this service and window.");
        }
        throw error;
      }
    },
  });
}
