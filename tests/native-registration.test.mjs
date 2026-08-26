import assert from "node:assert/strict";
import test from "node:test";

import {
  BookingAuthenticationRequiredError,
  BookingCommunitySelectionRequiredError,
} from "../server/auth/authenticated-booking-context-core.mjs";
import { createRegistrationApi } from "../server/native-booking/registration-api-core.mjs";
import {
  createRegistrationService,
  RegistrationIdempotencyConflictError,
} from "../server/native-booking/registration-service-core.mjs";
import {
  InvalidIdempotencyKeyError,
  InvalidRegistrationError,
  validateIdempotencyKey,
  validateRegistrationInput,
} from "../server/native-booking/registration-validation.mjs";

function trustedContext(profile = "wos", overrides = {}) {
  return {
    brand: { game: { profile } },
    hostname: profile === "wos" ? "localhost" : "peggie.localhost",
    gameProfile: profile,
    session: { tokenHash: `${profile}-session` },
    discordUser: { id: `${profile}-discord-user` },
    community: {
      id: `${profile}-community`,
      locationCode: profile === "wos" ? "1001" : "2002",
      displayName: profile === "wos" ? "State 1001" : "Kingdom 2002",
      discordGuildId: `${profile}-guild`,
      membershipVerifiedAt: new Date(),
    },
    ...overrides,
  };
}

function copyState(state) {
  return structuredClone(state);
}

function createTransactionalRepository(gameProfile = "wos") {
  let state = {
    participants: [],
    idempotency: new Map(),
    events: [],
    bookingSnapshots: [],
  };
  let failAudit = false;

  return {
    gameProfile,
    get state() {
      return state;
    },
    setFailAudit(value) {
      failAudit = value;
    },
    async withTransaction(work) {
      const draft = copyState(state);
      const session = {
        async claimRegistrationIdempotency(input) {
          const existing = draft.idempotency.get(input.idempotencyKey);
          if (existing) return { state: "existing", record: existing };
          draft.idempotency.set(input.idempotencyKey, {
            operation: "participant_registration_upsert",
            request_hash: input.requestHash,
            status: "started",
            response_status: null,
            response_body: null,
          });
          return { state: "claimed" };
        },
        async completeRegistrationIdempotency(
          communityId,
          idempotencyKey,
          responseStatus,
          responseBody,
        ) {
          assert.equal(communityId, `${gameProfile}-community`);
          Object.assign(draft.idempotency.get(idempotencyKey), {
            status: "completed",
            response_status: responseStatus,
            response_body: responseBody,
          });
        },
        async lockActiveParticipantsByDiscordUser(communityId, discordUserId) {
          return draft.participants.filter(
            (participant) =>
              participant.community_id === communityId &&
              participant.discord_user_id === discordUserId &&
              participant.status === "active",
          );
        },
        async insertWebsiteParticipant(input) {
          const participant = {
            game_profile: gameProfile,
            id: input.id,
            community_id: input.communityId,
            discord_user_id: input.discordUserId,
            player_id: input.playerId,
            in_game_name: input.inGameName,
            alliance: input.alliance,
            status: "active",
          };
          draft.participants.push(participant);
          return participant;
        },
        async updateWebsiteParticipant(input) {
          const participant = draft.participants.find(
            (candidate) =>
              candidate.id === input.id &&
              candidate.community_id === input.communityId &&
              candidate.discord_user_id === input.discordUserId &&
              candidate.status === "active",
          );
          if (!participant) return null;
          participant.player_id = input.playerId;
          participant.in_game_name = input.inGameName;
          participant.alliance = input.alliance;
          return participant;
        },
        async insertParticipantChangeEvent(event) {
          if (failAudit) throw new Error("forced audit failure");
          draft.events.push(event);
        },
      };
      const result = await work(session);
      state = draft;
      return result;
    },
  };
}

function idFactory() {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

function registration(overrides = {}) {
  return {
    playerId: "123456789",
    inGameName: "Player One",
    alliance: "ABC",
    ...overrides,
  };
}

function service(context = trustedContext(), repository = createTransactionalRepository()) {
  return {
    context,
    repository,
    instance: createRegistrationService({
      context,
      repository,
      createId: idFactory(),
    }),
  };
}

function mutationRequest(body, headers = {}) {
  return new Request("http://localhost/api/v1/booking/me/registration", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "registration-key-0001",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function registrationApi(overrides = {}) {
  const context = trustedContext();
  return createRegistrationApi({
    async resolveAuthenticatedContext() {
      return context;
    },
    async consumeMutationRateLimit() {
      return { allowed: true, retryAfterSeconds: 1 };
    },
    verifyCsrf() {
      return true;
    },
    createRepository() {
      return { gameProfile: "wos" };
    },
    createService(resolvedContext) {
      assert.equal(resolvedContext, context);
      return {
        async upsert(value) {
          return {
            status: 201,
            body: { outcome: "created", registration: { status: "registered", ...value } },
            replayed: false,
          };
        },
      };
    },
    ...overrides,
  });
}

test("registration validation canonicalizes strong native fields", () => {
  assert.deepEqual(
    validateRegistrationInput({
      playerId: " 123456 ",
      inGameName: " Player Name ",
      alliance: " a1z ",
    }),
    { playerId: "123456", inGameName: "Player Name", alliance: "A1Z" },
  );
  for (const value of ["", "12x", "1".repeat(33)]) {
    assert.throws(
      () => validateRegistrationInput(registration({ playerId: value })),
      InvalidRegistrationError,
    );
  }
  for (const value of ["", "AB", "AB-", "ABCD"]) {
    assert.throws(
      () => validateRegistrationInput(registration({ alliance: value })),
      InvalidRegistrationError,
    );
  }
  for (const value of ["", " ", "x".repeat(31), "bad\u0000name"]) {
    assert.throws(
      () => validateRegistrationInput(registration({ inGameName: value })),
      InvalidRegistrationError,
    );
  }
  assert.equal(validateIdempotencyKey("registration-key-0001"), "registration-key-0001");
  assert.throws(() => validateIdempotencyKey("short"), InvalidIdempotencyKeyError);
});

test("registration creates, updates, audits, and never duplicates the owned row", async () => {
  const fixture = service();
  const created = await fixture.instance.upsert(
    registration(),
    "registration-key-0001",
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.outcome, "created");
  assert.equal(fixture.repository.state.participants.length, 1);
  assert.equal(fixture.repository.state.events[0].eventType, "participant_registered");

  const updated = await fixture.instance.upsert(
    registration({ inGameName: "Player Updated", alliance: "Z9Z" }),
    "registration-key-0002",
  );
  assert.equal(updated.status, 200);
  assert.equal(updated.body.outcome, "updated");
  assert.equal(fixture.repository.state.participants.length, 1);
  assert.equal(fixture.repository.state.participants[0].in_game_name, "Player Updated");
  assert.equal(
    fixture.repository.state.events[1].eventType,
    "participant_registration_updated",
  );
  assert.deepEqual(fixture.repository.state.events[1].beforeData, {
    playerId: "123456789",
    inGameName: "Player One",
    alliance: "ABC",
  });
});

test("ownership is context-bound while player IDs may repeat", async () => {
  const repository = createTransactionalRepository();
  const first = createRegistrationService({
    context: trustedContext(),
    repository,
    createId: idFactory(),
  });
  const otherContext = trustedContext("wos", {
    discordUser: { id: "other-discord-user" },
  });
  const other = createRegistrationService({
    context: otherContext,
    repository,
    createId: idFactory(),
  });
  await first.upsert(registration(), "registration-first-0001");
  await other.upsert(
    registration({ inGameName: "Other Player" }),
    "registration-other-0001",
  );
  assert.equal(repository.state.participants.length, 2);
  assert.equal(repository.state.participants[0].in_game_name, "Player One");
  assert.equal(repository.state.participants[1].in_game_name, "Other Player");
  assert.equal(repository.state.participants[0].player_id, "123456789");
  assert.equal(repository.state.participants[1].player_id, "123456789");
});

test("WOS and Kingshot services reject repository profile crossover", () => {
  assert.throws(
    () =>
      createRegistrationService({
        context: trustedContext("wos"),
        repository: createTransactionalRepository("kingshot"),
      }),
    /profile mismatch/,
  );
});

test("idempotent replay returns the original result and changed payload conflicts", async () => {
  const fixture = service();
  const original = await fixture.instance.upsert(
    registration(),
    "registration-key-0001",
  );
  const replay = await fixture.instance.upsert(
    registration(),
    "registration-key-0001",
  );
  assert.deepEqual(replay.body, original.body);
  assert.equal(replay.status, 201);
  assert.equal(replay.replayed, true);
  assert.equal(fixture.repository.state.participants.length, 1);
  assert.equal(fixture.repository.state.events.length, 1);
  await assert.rejects(
    fixture.instance.upsert(
      registration({ alliance: "XYZ" }),
      "registration-key-0001",
    ),
    RegistrationIdempotencyConflictError,
  );
});

test("transaction failure rolls participant, idempotency, and audit back together", async () => {
  const fixture = service();
  fixture.repository.state.bookingSnapshots.push({
    playerId: "old-player",
    inGameName: "Old Name",
    alliance: "OLD",
  });
  fixture.repository.setFailAudit(true);
  await assert.rejects(
    fixture.instance.upsert(registration(), "registration-key-0001"),
    /forced audit failure/,
  );
  assert.equal(fixture.repository.state.participants.length, 0);
  assert.equal(fixture.repository.state.events.length, 0);
  assert.equal(fixture.repository.state.idempotency.size, 0);
  assert.deepEqual(fixture.repository.state.bookingSnapshots, [
    { playerId: "old-player", inGameName: "Old Name", alliance: "OLD" },
  ]);
});

test("API ignores hostile ownership fields and returns only normalized registration", async () => {
  let captured;
  const api = registrationApi({
    createService(context) {
      assert.equal(context.gameProfile, "wos");
      assert.equal(context.community.id, "wos-community");
      assert.equal(context.discordUser.id, "wos-discord-user");
      return {
        async upsert(value) {
          captured = value;
          return {
            status: 201,
            body: { outcome: "created", registration: { status: "registered", ...value } },
            replayed: false,
          };
        },
      };
    },
  });
  const response = await api.upsert(
    mutationRequest({
      ...registration({ alliance: "abc" }),
      game_profile: "kingshot",
      community_id: "hostile",
      discordUserId: "other-user",
    }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(captured, registration());
  assert.doesNotMatch(await response.text(), /hostile|other-user|community_id/);
});

test("API returns stable auth, membership, CSRF, rate, and validation errors", async () => {
  const request = mutationRequest(registration());
  const unauthenticated = registrationApi({
    async resolveAuthenticatedContext() {
      throw new BookingAuthenticationRequiredError();
    },
  });
  assert.equal((await unauthenticated.upsert(request.clone())).status, 401);

  const unselected = registrationApi({
    async resolveAuthenticatedContext() {
      throw new BookingCommunitySelectionRequiredError();
    },
  });
  assert.equal((await unselected.upsert(request.clone())).status, 409);

  const stale = registrationApi({
    async resolveAuthenticatedContext() {
      return trustedContext("wos", {
        community: {
          ...trustedContext().community,
          membershipVerifiedAt: new Date(Date.now() - 6 * 60 * 1000),
        },
      });
    },
  });
  assert.equal((await stale.upsert(request.clone())).status, 401);

  const csrf = registrationApi({ verifyCsrf: () => false });
  const csrfResponse = await csrf.upsert(request.clone());
  assert.equal(csrfResponse.status, 403);
  assert.equal((await csrfResponse.json()).code, "csrf_invalid");

  const limited = registrationApi({
    async consumeMutationRateLimit() {
      return { allowed: false, retryAfterSeconds: 12 };
    },
  });
  const limitedResponse = await limited.upsert(request.clone());
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers.get("retry-after"), "12");

  for (const invalid of [
    registration({ playerId: "12x" }),
    registration({ alliance: "AB" }),
    registration({ inGameName: "" }),
  ]) {
    const response = await registrationApi().upsert(mutationRequest(invalid));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_registration");
  }

  const conflict = registrationApi({
    createService() {
      return {
        async upsert() {
          throw new RegistrationIdempotencyConflictError();
        },
      };
    },
  });
  const conflictResponse = await conflict.upsert(request.clone());
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json()).code, "idempotency_conflict");

  const unavailable = registrationApi({ createRepository: () => null });
  const unavailableResponse = await unavailable.upsert(request.clone());
  assert.equal(unavailableResponse.status, 503);
  assert.doesNotMatch(
    await unavailableResponse.text(),
    /postgres|booking_participants|stack/i,
  );
});
