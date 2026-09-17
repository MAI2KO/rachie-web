import { createHash, randomUUID } from "node:crypto";

import {
  validateIdempotencyKey,
  validatePlayerId,
  validateRegistrationInput,
} from "./registration-validation.mjs";
import {
  PLAYER_REGISTRATION_POINTS,
  POINT_REASONS,
} from "../points/domain-core.mjs";

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

export class RegistrationOwnershipMismatchError extends Error {
  constructor() {
    super("The Player ID is actively owned by another Discord user.");
    this.name = "RegistrationOwnershipMismatchError";
  }
}

export async function deactivateAuthoritativeParticipantMirrors({
  gameProfile, discordUserId, playerId, repository,
}) {
  if (repository.gameProfile !== gameProfile) {
    throw new TypeError("Registration repository profile mismatch.");
  }
  const normalizedPlayerId = validatePlayerId(playerId);
  return repository.withTransaction(async (session) => {
    await session.lockAuthoritativePrimaryOwner(discordUserId);
    await session.lockRegisteredPlayerIdentity(null, normalizedPlayerId);
    const mirrors = await session.lockActivePlayerOwnership(normalizedPlayerId);
    if (mirrors.some((row) => row.discord_user_id !== discordUserId)) {
      throw new RegistrationOwnershipMismatchError();
    }
    const deactivated = await session.deactivateAuthoritativeParticipantMirrors(
      discordUserId, normalizedPlayerId,
    );
    return Object.freeze({ playerId: normalizedPlayerId, mirroredCharacters: deactivated });
  });
}

export async function synchronizeAuthoritativePrimary({
  gameProfile, discordUserId, playerId, repository,
}) {
  if (repository.gameProfile !== gameProfile) {
    throw new TypeError("Registration repository profile mismatch.");
  }
  const normalizedPlayerId = validatePlayerId(playerId);
  return repository.withTransaction(async (session) => {
    await session.lockAuthoritativePrimaryOwner(discordUserId);
    const targets = await session.lockActivePrimaryTargets(discordUserId, normalizedPlayerId);
    if (!targets.length) throw new RegistrationOwnershipAmbiguousError();
    await session.clearAuthoritativePrimaryParticipants(discordUserId);
    const updated = await session.markAuthoritativePrimaryParticipants(
      discordUserId, normalizedPlayerId,
    );
    if (updated !== targets.length) throw new RegistrationOwnershipAmbiguousError();
    return Object.freeze({ playerId: normalizedPlayerId, mirroredCharacters: updated });
  });
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scopedIdempotencyKey(context, publicKey) {
  return sha256(
    `${context.gameProfile}\0${context.community.id}\0${context.discordUser.id}\0${publicKey}`,
  );
}

function requestFingerprint(context, registration, options = {}) {
  return sha256(
    JSON.stringify({
      operation: REGISTRATION_OPERATION,
      gameProfile: context.gameProfile,
      communityId: context.community.id,
      discordUserId: context.discordUser.id,
      playerId: registration.playerId,
      inGameName: registration.inGameName,
      alliance: registration.alliance,
      isPrimary: typeof options.isPrimary === "boolean" ? options.isPrimary : null,
    }),
  );
}

function auditRegistration(participant) {
  return {
    playerId: participant.player_id,
    inGameName: participant.in_game_name,
    alliance: participant.alliance,
    isPrimary: participant.is_primary,
  };
}

function publicRegistration(participant) {
  return {
    status: "registered",
    playerId: participant.player_id,
    inGameName: participant.in_game_name,
    alliance: participant.alliance,
    isPrimary: participant.is_primary,
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
    async upsert(registration, publicIdempotencyKey, options = {}) {
      const normalizedRegistration = validateRegistrationInput(registration);
      const normalizedIdempotencyKey = validateIdempotencyKey(
        publicIdempotencyKey,
      );
      const idempotencyKey = scopedIdempotencyKey(
        context,
        normalizedIdempotencyKey,
      );
      const requestHash = requestFingerprint(context, normalizedRegistration, options);

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

        await session.lockAuthoritativePrimaryOwner(context.discordUser.id);
        await session.lockParticipantRegistrationOwner(
          context.community.id,
          context.discordUser.id,
        );
        await session.lockRegisteredPlayerIdentity(
          context.community.id,
          normalizedRegistration.playerId,
        );
        const ownership = await session.lockActivePlayerOwnership(
          normalizedRegistration.playerId,
        );
        if (ownership.some((row) => row.discord_user_id !== context.discordUser.id)) {
          throw new RegistrationOwnershipMismatchError();
        }
        const matches = await session.lockActiveParticipantsByPlayerId(
          context.community.id,
          normalizedRegistration.playerId,
        );
        if (matches.length > 1 || (matches[0]
            && matches[0].discord_user_id !== context.discordUser.id)) {
          throw new RegistrationOwnershipAmbiguousError();
        }
        await session.lockActiveParticipantsByDiscordUser(
          context.community.id,
          context.discordUser.id,
        );
        const before = matches[0] ?? null;
        const authoritativePrimary = typeof options.isPrimary === "boolean";
        const isPrimary = authoritativePrimary
          ? options.isPrimary
          : before?.is_primary ?? false;
        const participantId = before?.id ?? createId();
        if (authoritativePrimary && isPrimary) {
          await session.clearAuthoritativePrimaryParticipants(context.discordUser.id);
        }
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
              sourceGuildId: context.community.discordGuildId ?? null,
              isPrimary: authoritativePrimary ? false : isPrimary,
            })
          : await session.insertWebsiteParticipant({
              id: participantId,
              communityId: context.community.id,
              discordUserId: context.discordUser.id,
              playerId: normalizedRegistration.playerId,
              inGameName: normalizedRegistration.inGameName,
              alliance: normalizedRegistration.alliance,
              idempotencyKey,
              correlationId,
              sourceGuildId: context.community.discordGuildId ?? null,
              isPrimary: authoritativePrimary ? false : isPrimary,
            });
        if (!participant) throw new RegistrationOwnershipAmbiguousError();
        if (authoritativePrimary && isPrimary) {
          await session.markAuthoritativePrimaryParticipants(
            context.discordUser.id, normalizedRegistration.playerId,
          );
          participant.is_primary = true;
        } else if (authoritativePrimary) {
          await session.clearAuthoritativePlayerPrimary(
            context.discordUser.id, normalizedRegistration.playerId,
          );
          participant.is_primary = false;
        }

        if (!before) {
          await session.insertPlayerPointsEntry({
            id: createId(), participantId: participant.id, communityId: context.community.id,
            discordUserId: context.discordUser.id, pointsDelta: PLAYER_REGISTRATION_POINTS,
            reason: POINT_REASONS.playerRegistered,
            sourceGuildId: context.community.discordGuildId ?? null,
            idempotencyKey: `player_registered:${participant.id}`,
            metadata: { registrationSource: context.community.discordGuildId ? "discord_guild" : "website" },
          });
        }

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
