import { createHash, randomUUID } from "node:crypto";

import {
  validateIdempotencyKey,
  validateRegistrationInput,
} from "./registration-validation.mjs";

const REGISTRATION_OPERATION = "participant_registration_upsert";

export class RegistrationIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used for a different request.");
    this.name = "RegistrationIdempotencyConflictError";
  }
}

export class RegistrationOwnershipAmbiguousError extends Error {
  constructor() {
    super("Participant registration ownership is ambiguous.");
    this.name = "RegistrationOwnershipAmbiguousError";
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scopedIdempotencyKey(context, publicKey) {
  return sha256(
    `${context.gameProfile}\0${context.community.id}\0${context.discordUser.id}\0${publicKey}`,
  );
}

function requestFingerprint(context, registration) {
  return sha256(
    JSON.stringify({
      operation: REGISTRATION_OPERATION,
      gameProfile: context.gameProfile,
      communityId: context.community.id,
      discordUserId: context.discordUser.id,
      playerId: registration.playerId,
      inGameName: registration.inGameName,
      alliance: registration.alliance,
    }),
  );
}

function auditRegistration(participant) {
  return {
    playerId: participant.player_id,
    inGameName: participant.in_game_name,
    alliance: participant.alliance,
  };
}

function publicRegistration(participant) {
  return {
    status: "registered",
    playerId: participant.player_id,
    inGameName: participant.in_game_name,
    alliance: participant.alliance,
  };
}

function replayOrConflict(claim, requestHash) {
  if (claim.state === "claimed") return null;
  const record = claim.record;
  if (
    !record ||
    record.operation !== REGISTRATION_OPERATION ||
    record.request_hash !== requestHash ||
    record.status !== "completed" ||
    !Number.isInteger(record.response_status) ||
    !record.response_body
  ) {
    throw new RegistrationIdempotencyConflictError();
  }
  return {
    status: record.response_status,
    body: record.response_body,
    replayed: true,
  };
}

export function createRegistrationService({
  context,
  repository,
  createId = randomUUID,
}) {
  if (repository.gameProfile !== context.gameProfile) {
    throw new TypeError("Registration repository profile mismatch.");
  }

  return Object.freeze({
    async upsert(registration, publicIdempotencyKey) {
      const normalizedRegistration = validateRegistrationInput(registration);
      const normalizedIdempotencyKey = validateIdempotencyKey(
        publicIdempotencyKey,
      );
      const idempotencyKey = scopedIdempotencyKey(
        context,
        normalizedIdempotencyKey,
      );
      const requestHash = requestFingerprint(context, normalizedRegistration);

      return repository.withTransaction(async (session) => {
        const correlationId = createId();
        const claim = await session.claimRegistrationIdempotency({
          communityId: context.community.id,
          idempotencyKey,
          requestHash,
          correlationId,
        });
        const replay = replayOrConflict(claim, requestHash);
        if (replay) return replay;

        const existing = await session.lockActiveParticipantsByDiscordUser(
          context.community.id,
          context.discordUser.id,
        );
        if (existing.length > 1) {
          throw new RegistrationOwnershipAmbiguousError();
        }

        const before = existing[0] ?? null;
        const beforeData = before ? auditRegistration(before) : null;
        const participant = before
          ? await session.updateWebsiteParticipant({
              id: before.id,
              communityId: context.community.id,
              discordUserId: context.discordUser.id,
              playerId: normalizedRegistration.playerId,
              inGameName: normalizedRegistration.inGameName,
              alliance: normalizedRegistration.alliance,
              idempotencyKey,
              correlationId,
            })
          : await session.insertWebsiteParticipant({
              id: createId(),
              communityId: context.community.id,
              discordUserId: context.discordUser.id,
              playerId: normalizedRegistration.playerId,
              inGameName: normalizedRegistration.inGameName,
              alliance: normalizedRegistration.alliance,
              idempotencyKey,
              correlationId,
            });
        if (!participant) throw new RegistrationOwnershipAmbiguousError();

        const outcome = before ? "updated" : "created";
        const status = before ? 200 : 201;
        const body = {
          outcome,
          registration: publicRegistration(participant),
        };

        await session.insertParticipantChangeEvent({
          id: createId(),
          communityId: context.community.id,
          participantId: participant.id,
          eventType: before
            ? "participant_registration_updated"
            : "participant_registered",
          actorId: context.discordUser.id,
          correlationId,
          beforeData,
          afterData: auditRegistration(participant),
        });
        await session.completeRegistrationIdempotency(
          context.community.id,
          idempotencyKey,
          status,
          body,
        );
        return { status, body, replayed: false };
      });
    },
  });
}
