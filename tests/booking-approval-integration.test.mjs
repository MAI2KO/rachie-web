import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { createGuestBookingApi } from "../server/booking-approval/api-core.mjs";
import {
  hashGuestShareToken,
} from "../server/booking-approval/domain-core.mjs";
import { createProfileScopedApprovalRepository } from "../server/booking-approval/repository-core.mjs";
import {
  createBookingApprovalService,
  createBookingBoardReadService,
  createGuestBookingPageService,
  createGuestBookingRequestService,
} from "../server/booking-approval/service-core.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { runtimePrivilegeStatements } from "../server/database/runtime-privileges.mjs";
import { createDiscordIntegrationRepository } from "../server/discord-integration/repository-core.mjs";
import { createBookingCreationService } from "../server/native-booking/booking-creation-service-core.mjs";
import { createBookingMutationService } from "../server/native-booking/booking-mutation-service-core.mjs";
import { createProfileScopedBookingRepository } from "../server/native-booking/repository-core.mjs";
import { createRegistrationService } from "../server/native-booking/registration-service-core.mjs";
import { RATE_LIMIT_POLICIES } from "../server/rate-limit/policies.mjs";

const databaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();
const tokens = { wos: "w".repeat(43), kingshot: "k".repeat(43) };

async function withProfile(pool, profile, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile',$1,true)", [profile]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function guestInput(slotId, suffix) {
  return {
    playerId: `9000${String(suffix).padStart(4, "0")}`,
    inGameName: `Guest ${suffix}`,
    alliance: "GST",
    serviceCode: "construction",
    slotId,
    requirements: { speedups: 18 },
  };
}

function manager(profile, communityId, user = "manager-1") {
  return {
    gameProfile: profile,
    authorizedCommunityId: communityId,
    discordUserId: user,
    displayName: user === "manager-1" ? "Mark" : "Jenn",
  };
}

function guestDecisionFixture({ matches = [], requireApproval = true } = {}) {
  const state = { bookings: [], requests: [], events: [], outbox: [], points: [] };
  const communityId = randomUUID();
  const slotId = randomUUID();
  const linkId = randomUUID();
  const session = {
    async findActiveShareLink() { return { id: linkId, community_id: communityId,
      community_status: "active", bookings_open: true }; },
    async lockCommunity() { return { id: communityId, status: "active", bookings_open: true }; },
    async claimGuestRequestIdempotency() { return { state: "claimed" }; },
    async lockSlot() { return { id: slotId, community_id: communityId, window_id: randomUUID(),
      service_date_id: randomUUID(), service_code: "construction", booking_date: "2030-08-22",
      display_time_label: "08:00", slot_status: "available", window_status: "open",
      service_active: true }; },
    async lockGuestPlayerService() {}, async expirePendingForSlot() { return []; },
    async expirePendingForPlayerService() { return []; }, async hasActiveApprovalHold() { return false; },
    async hasActiveSlotBlock() { return false; }, async hasConfirmedBooking() { return false; },
    async hasActivePendingForPlayerService() { return false; },
    async hasConfirmedBookingForPlayerService() { return false; },
    async findSettings() { return { require_unregistered_guest_approval: requireApproval,
      pending_hold_duration_seconds: 1800, construction_speedups_required: true }; },
    async lockRegisteredPlayerIdentity() {},
    async findRegisteredParticipantsByPlayerId() { return matches; },
    async insertConfirmedGuestBooking(input) { const row = { ...input,
      id: input.id, service_code: input.serviceCode, booking_date: input.bookingDate,
      display_time_label_snapshot: input.displayTime, player_id_snapshot: input.playerId,
      in_game_name_snapshot: input.inGameName, alliance_snapshot: input.alliance };
      state.bookings.push(row); return row; },
    async insertGuestBookingAnswer() {},
    async insertGuestBookingEvent(input) { state.events.push(input); },
    async insertApprovalOutbox(input) { state.outbox.push(input); },
    async insertPlayerPointsEntry(input) { state.points.push(input); return true; },
    async insertCommunityParticipationPoints() { return true; },
    async insertApprovalRequest(input) { const row = { ...input, id: input.id,
      service_code: input.serviceCode, booking_date: input.bookingDate,
      display_time_label_snapshot: input.displayTime, status: "pending_approval",
      hold_expires_at: input.holdExpiresAt }; state.requests.push(row); return row; },
    async insertRequestAnswer() {}, async insertApprovalEvent(input) { state.events.push(input); },
    async completeIdempotency() {},
  };
  return { state, slotId, repository: { gameProfile: "wos",
    async withTransaction(work) { return work(session); } } };
}

test("exact registered guest identity auto-confirms with provenance, notification work, and points", async () => {
  const participant = { id: randomUUID(), discord_user_id: "registered-user",
    player_id: "90000001", in_game_name: "Canonical", alliance: "REG",
    source_discord_guild_id: null };
  const fixture = guestDecisionFixture({ matches: [participant] });
  const result = await createGuestBookingRequestService({ gameProfile: "wos",
    repository: fixture.repository }).create(tokens.wos,
    guestInput(fixture.slotId, 1), "registered-guest-request-0001");
  assert.equal(result.status, 201);
  assert.equal(result.body.request.status, "confirmed");
  assert.equal(result.body.request.recognizedRegisteredPlayer, true);
  assert.equal(fixture.state.bookings[0].participantId, participant.id);
  assert.equal(fixture.state.bookings[0].discordUserId, "registered-user");
  assert.equal(fixture.state.bookings[0].inGameName, "Canonical");
  assert.equal(fixture.state.bookings[0].provenance, "guest_registered");
  assert.equal(fixture.state.outbox[0].eventType, "booking.created");
  assert.equal(fixture.state.points.length, 1);
  assert.equal(fixture.state.requests.length, 0);
});

test("registered guest without a linked Discord owner confirms without inventing an identity", async () => {
  const participant = { id: randomUUID(), discord_user_id: null,
    player_id: "90000005", in_game_name: "Legacy Registered", alliance: "REG",
    source_discord_guild_id: null };
  const fixture = guestDecisionFixture({ matches: [participant] });
  const result = await createGuestBookingRequestService({ gameProfile: "wos",
    repository: fixture.repository }).create(tokens.wos,
    guestInput(fixture.slotId, 5), "registered-guest-no-owner-0001");
  assert.equal(result.status, 201);
  assert.equal(result.body.request.recognizedRegisteredPlayer, true);
  assert.equal(fixture.state.bookings[0].participantId, participant.id);
  assert.equal(fixture.state.bookings[0].discordUserId, null);
  assert.equal(fixture.state.outbox.length, 1,
    "the shared notification materializer may safely skip a null recipient");
});

test("unmatched guest follows the community policy and name alone never matches", async () => {
  const pending = guestDecisionFixture({ matches: [], requireApproval: true });
  const pendingResult = await createGuestBookingRequestService({ gameProfile: "wos",
    repository: pending.repository }).create(tokens.wos,
    guestInput(pending.slotId, 2), "unmatched-guest-pending-0001");
  assert.equal(pendingResult.status, 202);
  assert.equal(pending.state.requests.length, 1);
  assert.equal(pending.state.bookings.length, 0);

  const automatic = guestDecisionFixture({ matches: [], requireApproval: false });
  const automaticResult = await createGuestBookingRequestService({ gameProfile: "wos",
    repository: automatic.repository }).create(tokens.wos,
    guestInput(automatic.slotId, 3), "unmatched-guest-confirmed-0001");
  assert.equal(automaticResult.status, 201);
  assert.equal(automaticResult.body.request.recognizedRegisteredPlayer, false);
  assert.equal(automatic.state.bookings[0].provenance, "guest_unregistered");
  assert.equal(automatic.state.points.length, 0);
});

test("ambiguous registered Player ID always remains pending", async () => {
  const fixture = guestDecisionFixture({ requireApproval: false, matches: [
    { id: randomUUID(), player_id: "90000004" },
    { id: randomUUID(), player_id: "90000004" },
  ] });
  const result = await createGuestBookingRequestService({ gameProfile: "wos",
    repository: fixture.repository }).create(tokens.wos,
    guestInput(fixture.slotId, 4), "ambiguous-guest-request-0001");
  assert.equal(result.status, 202);
  assert.equal(fixture.state.bookings.length, 0);
  assert.equal(fixture.state.requests.length, 1);
  assert.equal(fixture.state.events[0].metadata.provenance, "ambiguous_registered_player");
});

test("guest booking API consumes the dedicated bounded rate-limit policy", async () => {
  let captured;
  const api = createGuestBookingApi({
    resolveRateLimitSubject: () => "trusted-ip-subject",
    async consumeRateLimit(policy, subject) {
      captured = { policy, subject };
      return { allowed: false, retryAfterSeconds: 17 };
    },
    createService() { throw new Error("rate limit must run before service creation"); },
  });
  const response = await api.submit(new Request("https://example.test/guest", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "guest-api-request-0001" },
    body: JSON.stringify({}),
  }), tokens.wos);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "17");
  assert.equal(captured.policy, RATE_LIMIT_POLICIES.guestBookingSubmission);
  assert.match(captured.subject, /^[0-9a-f]{64}:trusted-ip-subject$/);
  assert.doesNotMatch(captured.subject, new RegExp(tokens.wos));
});

test("guest booking API rate-limits anonymous reads without using the plaintext token as a subject", async () => {
  let captured;
  const api = createGuestBookingApi({
    resolveRateLimitSubject: () => "trusted-ip-subject",
    async consumeRateLimit(policy, subject) {
      captured = { policy, subject };
      return { allowed: false, retryAfterSeconds: 11 };
    },
    createPageService() { throw new Error("rate limit must run before reading the page"); },
  });
  const response = await api.read(new Request("https://example.test/guest"), tokens.wos);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "11");
  assert.equal(captured.policy, RATE_LIMIT_POLICIES.guestBookingRead);
  assert.match(captured.subject, /^[0-9a-f]{64}:trusted-ip-subject$/);
  assert.doesNotMatch(captured.subject, new RegExp(tokens.wos));
});

test("guest booking API reads anonymously and strips internal request IDs on submission", async () => {
  const page = { community: { code: "9999", displayName: "Test" }, services: [] };
  const api = createGuestBookingApi({
    createPageService: () => ({ read: async () => page }),
    createService: () => ({ create: async () => ({ status: 202, replayed: false, body: { request: { requestId: "secret-id", service: "construction", date: "2030-01-01", time: "10:00", status: "pending_approval", holdExpiresAt: "2030-01-01T10:30:00Z" } } }) }),
    verifyOrigin: () => true, resolveRateLimitSubject: () => "client",
    consumeRateLimit: async () => ({ allowed: true }),
  });
  assert.deepEqual((await (await api.read(new Request("https://example.test"), tokens.wos)).json()).page, page);
  const response = await api.submit(new Request("https://example.test", { method: "POST", headers: { "idempotency-key": "guest-safe-api-0001" }, body: "{}" }), tokens.wos);
  const body = await response.json();
  assert.equal(response.status, 202); assert.doesNotMatch(JSON.stringify(body), /secret-id|requestId/);
});

test("recognized guest response exposes confirmation but no registered account identity", async () => {
  const api = createGuestBookingApi({
    createService: () => ({ create: async () => ({ status: 201, replayed: false,
      body: { request: { service: "construction", date: "2030-01-01", time: "10:00",
        status: "confirmed", holdExpiresAt: null, recognizedRegisteredPlayer: true,
        discordUserId: "123456789012345678", discordUsername: "private-user",
        participantId: randomUUID(), pointsAccount: { total: 99 } } } }) }),
    verifyOrigin: () => true, resolveRateLimitSubject: () => "client",
    consumeRateLimit: async () => ({ allowed: true }),
  });
  const response = await api.submit(new Request("https://example.test", {
    method: "POST", headers: { "idempotency-key": "recognized-safe-api-0001" }, body: "{}",
  }), tokens.wos);
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(body.request.recognizedRegisteredPlayer, true);
  assert.doesNotMatch(JSON.stringify(body), /123456789012345678|private-user|participantId|pointsAccount/);
});

test("migration 0005 preserves existing confirmed booking data and defaults communities to auto-approve", { skip: !databaseUrl && "TEST_DATABASE_URL is not configured" }, async () => {
  const schema = `approval_upgrade_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA ${schema}`);
  try {
    const migrations = await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url)));
    await runMigrations(pool, migrations.slice(0, 4));
    const ids = {
      community: randomUUID(), window: randomUUID(), serviceDate: randomUUID(),
      slot: randomUUID(), participant: randomUUID(), booking: randomUUID(),
    };
    await withProfile(pool, "wos", async (client) => {
      await client.query(
        "INSERT INTO booking_communities (game_profile,id,location_code,display_name,bookings_open) VALUES ('wos',$1,'9999','Existing Staging',true)",
        [ids.community],
      );
      await client.query("INSERT INTO booking_settings (game_profile,community_id) VALUES ('wos',$1)", [ids.community]);
      await client.query(
        "INSERT INTO booking_windows (game_profile,id,community_id,status,created_by_actor_type) VALUES ('wos',$1,$2,'open','system')",
        [ids.window, ids.community],
      );
      await client.query(
        "INSERT INTO booking_service_dates (game_profile,id,community_id,window_id,service_code,booking_date) VALUES ('wos',$1,$2,$3,'construction','2026-09-01')",
        [ids.serviceDate, ids.community, ids.window],
      );
      await client.query(
        `INSERT INTO appointment_slots
           (game_profile,id,community_id,window_id,service_date_id,service_code,
            booking_date,ordinal,display_time_label,local_start_time,time_zone)
         VALUES ('wos',$1,$2,$3,$4,'construction','2026-09-01',0,'08:00','08:00','UTC')`,
        [ids.slot, ids.community, ids.window, ids.serviceDate],
      );
      await client.query(
        `INSERT INTO booking_idempotency_keys
           (game_profile,community_id,idempotency_key,operation,request_hash,correlation_id,status)
         VALUES ('wos',$1,'existing-booking-key','booking_create',$2,'existing-correlation','completed')`,
        [ids.community, "a".repeat(64)],
      );
      await client.query(
        `INSERT INTO booking_participants
           (game_profile,id,community_id,discord_user_id,player_id,in_game_name,
            alliance,source,idempotency_key,correlation_id)
         VALUES ('wos',$1,$2,'existing-user','12345678','Existing Player','OLD',
                 'website','existing-booking-key','existing-correlation')`,
        [ids.participant, ids.community],
      );
      await client.query(
        `INSERT INTO minister_bookings
           (game_profile,id,community_id,window_id,service_date_id,service_code,
            booking_date,slot_id,participant_id,discord_user_id,player_id_snapshot,
            in_game_name_snapshot,alliance_snapshot,display_time_label_snapshot,
            source,actor_type,actor_id,idempotency_key,correlation_id)
         VALUES ('wos',$1,$2,$3,$4,'construction','2026-09-01',$5,$6,
                 'existing-user','12345678','Existing Player','OLD','08:00',
                 'website','discord_user','existing-user','existing-booking-key','existing-correlation')`,
        [ids.booking, ids.community, ids.window, ids.serviceDate, ids.slot, ids.participant],
      );
    });

    assert.deepEqual((await runMigrations(pool, migrations)).applied,
      ["0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014", "0015"]);
    const preserved = await withProfile(pool, "wos", (client) => client.query(
      `SELECT booking.id,booking.status,booking.in_game_name_snapshot,
              booking.approval_request_id,booking.entry_provenance,
              booking.guest_share_link_id,participant.is_primary,
              settings.booking_approval_policy,
              settings.require_unregistered_guest_approval,
              settings.pending_hold_duration_seconds
       FROM minister_bookings AS booking
       JOIN booking_participants AS participant
         ON participant.game_profile=booking.game_profile
        AND participant.id=booking.participant_id
        AND participant.community_id=booking.community_id
       JOIN booking_settings AS settings
         ON settings.game_profile=booking.game_profile
        AND settings.community_id=booking.community_id
       WHERE booking.id=$1`,
      [ids.booking],
    ));
    assert.deepEqual(preserved.rows, [{
      id: ids.booking,
      status: "confirmed",
      in_game_name_snapshot: "Existing Player",
      approval_request_id: null,
      entry_provenance: "legacy",
      guest_share_link_id: null,
      is_primary: false,
      booking_approval_policy: "auto_approve",
      require_unregistered_guest_approval: true,
      pending_hold_duration_seconds: 1800,
    }]);
  } finally {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});

test("migration 0015 backfills only provable historical provenance", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const schema = `provenance_upgrade_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA ${schema}`);
  try {
    const migrations = await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url)));
    await runMigrations(pool, migrations.slice(0, 14));
    const ids = { community: randomUUID(), window: randomUUID(), date: randomUUID(),
      participant: randomUUID(), link: randomUUID(), request: randomUUID() };
    const slots = Array.from({ length: 4 }, () => randomUUID());
    const bookings = Array.from({ length: 4 }, () => randomUUID());
    await withProfile(pool, "wos", async (client) => {
      await client.query(
        "INSERT INTO booking_communities (game_profile,id,location_code,display_name) VALUES ('wos',$1,'9915','Provenance')",
        [ids.community],
      );
      await client.query("INSERT INTO booking_settings (game_profile,community_id) VALUES ('wos',$1)", [ids.community]);
      await client.query(
        "INSERT INTO booking_windows (game_profile,id,community_id,status,created_by_actor_type) VALUES ('wos',$1,$2,'open','system')",
        [ids.window, ids.community],
      );
      await client.query(
        "INSERT INTO booking_service_dates (game_profile,id,community_id,window_id,service_code,booking_date) VALUES ('wos',$1,$2,$3,'construction','2030-09-01')",
        [ids.date, ids.community, ids.window],
      );
      for (const [ordinal, slot] of slots.entries()) {
        await client.query(
          `INSERT INTO appointment_slots
             (game_profile,id,community_id,window_id,service_date_id,service_code,
              booking_date,ordinal,display_time_label,local_start_time,time_zone)
           VALUES ('wos',$1,$2,$3,$4,'construction','2030-09-01',$5,$6,$7,'UTC')`,
          [slot, ids.community, ids.window, ids.date, ordinal,
           `${String(8 + ordinal).padStart(2, "0")}:00`,
           `${String(8 + ordinal).padStart(2, "0")}:00`],
        );
      }
      await client.query(
        `INSERT INTO booking_idempotency_keys
           (game_profile,community_id,idempotency_key,operation,request_hash,correlation_id,status)
         VALUES ('wos',$1,'provenance-participant','participant_registration_upsert',$2,
                 'provenance-participant','started')`,
        [ids.community, "b".repeat(64)],
      );
      await client.query(
        `INSERT INTO booking_participants
           (game_profile,id,community_id,discord_user_id,player_id,in_game_name,
            alliance,source,idempotency_key,correlation_id)
         VALUES ('wos',$1,$2,'provenance-user','100001','Member','MEM',
                 'website','provenance-participant','provenance-participant')`,
        [ids.participant, ids.community],
      );
      await client.query(
        `INSERT INTO booking_guest_share_links
           (game_profile,id,community_id,token_hash,label)
         VALUES ('wos',$1,$2,$3,'Historical guest')`,
        [ids.link, ids.community, "a".repeat(64)],
      );
      for (let index = 0; index < bookings.length; index += 1) {
        await client.query(
          `INSERT INTO booking_idempotency_keys
             (game_profile,community_id,idempotency_key,operation,request_hash,correlation_id,status)
           VALUES ('wos',$1,$2,'fixture',$3,$4,'completed')`,
          [ids.community, `provenance-booking-${index}`, String(index).repeat(64), `correlation-${index}`],
        );
      }
      await client.query(
        `INSERT INTO booking_approval_requests
           (game_profile,id,community_id,window_id,service_date_id,service_code,
            booking_date,slot_id,request_source,share_link_id,player_id_snapshot,
            in_game_name_snapshot,alliance_snapshot,display_time_label_snapshot,
            hold_expires_at,idempotency_key,correlation_id)
         VALUES ('wos',$1,$2,$3,$4,'construction','2030-09-01',$5,'guest_link',$6,
                 '100002','Guest','GST','09:00',now()+interval '30 minutes',
                 'provenance-booking-1','correlation-1')`,
        [ids.request, ids.community, ids.window, ids.date, slots[1], ids.link],
      );
      const shapes = [
        { source: "website", actor: "discord_user", actorId: "provenance-user",
          participant: ids.participant, discord: "provenance-user", approval: null },
        { source: "website", actor: "admin", actorId: "manager",
          participant: null, discord: null, approval: ids.request },
        { source: "admin", actor: "admin", actorId: "manager",
          participant: null, discord: null, approval: null },
        { source: "legacy_import", actor: "legacy_import", actorId: null,
          participant: null, discord: null, approval: null },
      ];
      for (const [index, shape] of shapes.entries()) {
        await client.query(
          `INSERT INTO minister_bookings
             (game_profile,id,community_id,window_id,service_date_id,service_code,
              booking_date,slot_id,participant_id,discord_user_id,player_id_snapshot,
              in_game_name_snapshot,alliance_snapshot,display_time_label_snapshot,
              source,actor_type,actor_id,idempotency_key,correlation_id,approval_request_id)
           VALUES ('wos',$1,$2,$3,$4,'construction','2030-09-01',$5,$6,$7,$8,$9,'TAG',$10,
                   $11,$12,$13,$14,$15,$16)`,
          [bookings[index], ids.community, ids.window, ids.date, slots[index],
           shape.participant, shape.discord, `10000${index + 1}`,
           ["Member", "Guest", "Manual", "Unknown"][index],
           `${String(8 + index).padStart(2, "0")}:00`,
           shape.source, shape.actor, shape.actorId, `provenance-booking-${index}`,
           `correlation-${index}`, shape.approval],
        );
      }
      await client.query(
        `UPDATE booking_approval_requests SET status='confirmed',decided_at=now(),
                decided_by_discord_user_id='manager',confirmed_booking_id=$3
          WHERE game_profile='wos' AND id=$1 AND community_id=$2`,
        [ids.request, ids.community, bookings[1]],
      );
      for (const [bookingId, eventType, actorType] of [
        [bookings[0], "booking_created", "discord_user"],
        [bookings[2], "manager_manual_booking", "admin"],
      ]) {
        await client.query(
          `INSERT INTO booking_change_events
             (game_profile,id,community_id,aggregate_type,aggregate_id,event_type,
              source,actor_type,actor_id,correlation_id)
           VALUES ('wos',$1,$2,'minister_booking',$3,$4,'website',$5,'manager',$6)`,
          [randomUUID(), ids.community, bookingId, eventType, actorType, `event-${eventType}`],
        );
      }
    });
    assert.deepEqual((await runMigrations(pool, migrations)).applied, ["0015"]);
    const result = await withProfile(pool, "wos", (client) => client.query(
      `SELECT id,entry_provenance,guest_share_link_id
         FROM minister_bookings WHERE community_id=$1 ORDER BY id`, [ids.community],
    ));
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    assert.deepEqual(bookings.map((id) => byId.get(id).entry_provenance),
      ["member", "guest_unregistered", "admin", "legacy"]);
    assert.equal(byId.get(bookings[1]).guest_share_link_id, ids.link);
    assert.equal(byId.get(bookings[0]).guest_share_link_id, null);
  } finally {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});

test("guest approval foundation is transactional and profile-isolated in PostgreSQL", { skip: !databaseUrl && "TEST_DATABASE_URL is not configured" }, async (t) => {
  const schema = `approval_${randomUUID().replaceAll("-", "")}`;
  const runtimeRole = `approval_runtime_${randomUUID().replaceAll("-", "")}`;
  const runtimePassword = `pw_${randomUUID()}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const owner = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  let runtime;

  const fixtures = {};
  try {
    await runMigrations(owner, await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url))));
    for (const profile of ["wos", "kingshot"]) {
      const communityId = randomUUID();
      const windowId = randomUUID();
      const serviceDateId = randomUUID();
      const linkId = randomUUID();
      const guildId = profile === "wos" ? "111111111111111111" : "222222222222222222";
      const slots = Array.from({ length: 16 }, () => randomUUID());
      fixtures[profile] = { communityId, windowId, serviceDateId, linkId, guildId, slots };
      await withProfile(owner, profile, async (client) => {
        await client.query(
          `INSERT INTO booking_communities
             (game_profile,id,location_code,display_name,status,bookings_open)
           VALUES ($1,$2,'9999',$3,'active',true)`,
          [profile, communityId, `${profile} Test Server`],
        );
        await client.query(
          `INSERT INTO booking_discord_guilds
             (game_profile,discord_guild_id,community_id,discord_guild_name,bot_manager_role_id,guild_kind)
           VALUES ($1,$2,$3,'Approval Test Guild','333333333333333333','alliance')`,
          [profile, guildId, communityId],
        );
        await client.query(
          `INSERT INTO booking_settings
             (game_profile,community_id,construction_speedups_required)
           VALUES ($1,$2,true)`,
          [profile, communityId],
        );
        await client.query(
          `INSERT INTO booking_windows
             (game_profile,id,community_id,status,created_by_actor_type)
           VALUES ($1,$2,$3,'open','system')`,
          [profile, windowId, communityId],
        );
        await client.query(
          `INSERT INTO booking_service_dates
             (game_profile,id,community_id,window_id,service_code,booking_date)
           VALUES ($1,$2,$3,$4,'construction','2026-09-01')`,
          [profile, serviceDateId, communityId, windowId],
        );
        for (const [ordinal, slotId] of slots.entries()) {
          const time = `${String(8 + ordinal).padStart(2, "0")}:00`;
          await client.query(
            `INSERT INTO appointment_slots
               (game_profile,id,community_id,window_id,service_date_id,service_code,
                booking_date,ordinal,display_time_label,local_start_time,time_zone)
             VALUES ($1,$2,$3,$4,$5,'construction','2026-09-01',$6,$7,$8,'UTC')`,
            [profile, slotId, communityId, windowId, serviceDateId, ordinal, time, time],
          );
        }
        await client.query(
          `INSERT INTO booking_guest_share_links
             (game_profile,id,community_id,token_hash,token_hint,label)
           VALUES ($1,$2,$3,$4,$5,'In-game guest link')`,
          [profile, linkId, communityId, hashGuestShareToken(tokens[profile]), tokens[profile].slice(0, 6)],
        );
      });
    }

    await admin.query(
      `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
    for (const sql of runtimePrivilegeStatements(runtimeRole)) await owner.query(sql);
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtime = new pg.Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${schema}` });
    assert.deepEqual(
      (await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows,
      [{ rolsuper: false, rolbypassrls: false }],
    );
    await assert.rejects(runtime.query("SELECT version FROM app_schema_migrations"), (error) => error.code === "42501");

    const approvalRepositories = {
      wos: createProfileScopedApprovalRepository("wos", runtime),
      kingshot: createProfileScopedApprovalRepository("kingshot", runtime),
    };
    const bookingRepositories = {
      wos: createProfileScopedBookingRepository("wos", runtime),
      kingshot: createProfileScopedBookingRepository("kingshot", runtime),
    };
    const guestService = (profile, clock) => createGuestBookingRequestService({
      gameProfile: profile,
      repository: approvalRepositories[profile],
      ...(clock ? { now: () => new Date(clock) } : {}),
    });
    const approvalService = (profile, actor = manager(profile, fixtures[profile].communityId), clock) => createBookingApprovalService({
      gameProfile: profile,
      communityId: fixtures[profile].communityId,
      managerContext: actor,
      repository: approvalRepositories[profile],
      ...(clock ? { now: () => new Date(clock) } : {}),
    });
    const boardService = (profile, actor = null, clock = null) => createBookingBoardReadService({
      gameProfile: profile,
      communityId: fixtures[profile].communityId,
      repository: approvalRepositories[profile],
      managerContext: actor,
      ...(clock ? { now: () => new Date(clock) } : {}),
    });
    const register = async (profile, userId) => {
      const context = { gameProfile: profile, community: { id: fixtures[profile].communityId }, discordUser: { id: userId } };
      await createRegistrationService({ context, repository: bookingRepositories[profile] }).upsert(
        { playerId: `8${String(userId).replace(/\D/g, "").slice(-7).padStart(7, "0")}`, inGameName: userId, alliance: "DSC" },
        `register-${profile}-${userId}-0001`,
      );
      return context;
    };

    await t.test("registered guest auto-confirms through the normal notification and points path", async () => {
      await register("wos", "1234567");
      await withProfile(owner, "wos", (client) => client.query(
        "UPDATE appointment_slots SET starts_at=now()+interval '20 minutes' WHERE id=$1",
        [fixtures.wos.slots[14]],
      ));
      const input = { ...guestInput(fixtures.wos.slots[14], 70),
        playerId: "81234567", inGameName: "Spoofed name", alliance: "BAD" };
      const result = await guestService("wos", "2030-08-21T09:00:00.000Z").create(
        tokens.wos, input, "registered-guest-database-0001",
      );
      assert.equal(result.status, 201);
      assert.equal(result.body.request.recognizedRegisteredPlayer, true);
      const stored = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT booking.entry_provenance,booking.guest_share_link_id,
                booking.discord_user_id,booking.in_game_name_snapshot,
                booking.participant_id,
                (SELECT count(*)::int FROM booking_approval_requests
                  WHERE slot_id=booking.slot_id) AS request_count,
                (SELECT count(*)::int FROM player_points_ledger
                  WHERE booking_id=booking.id) AS points_count
           FROM minister_bookings AS booking WHERE booking.slot_id=$1`,
        [fixtures.wos.slots[14]],
      ));
      assert.equal(stored.rows[0].entry_provenance, "guest_registered");
      assert.equal(stored.rows[0].guest_share_link_id, fixtures.wos.linkId);
      assert.equal(stored.rows[0].discord_user_id, "1234567");
      assert.equal(stored.rows[0].in_game_name_snapshot, "1234567");
      assert.ok(stored.rows[0].participant_id);
      assert.equal(stored.rows[0].request_count, 0);
      assert.equal(stored.rows[0].points_count, 1);
      const replayed = await guestService("wos", "2030-08-21T09:01:00.000Z").create(
        tokens.wos, input, "registered-guest-database-0001",
      );
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.body.request.status, "confirmed");

      const discord = createDiscordIntegrationRepository("wos", runtime);
      await discord.withTransaction((session) => session.claim(25));
      const notifications = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT notification_type,recipient_discord_user_id
           FROM booking_discord_notifications
          WHERE booking_id=(SELECT id FROM minister_bookings WHERE slot_id=$1)
          ORDER BY notification_type`,
        [fixtures.wos.slots[14]],
      ));
      assert.deepEqual(notifications.rows, [
        { notification_type: "appointment_reminder", recipient_discord_user_id: "1234567" },
        { notification_type: "player_confirmed", recipient_discord_user_id: "1234567" },
      ]);
    });

    await t.test("unregistered guest auto-confirm policy is community scoped", async () => {
      await withProfile(runtime, "wos", (client) => client.query(
        `UPDATE booking_settings SET require_unregistered_guest_approval=false
          WHERE community_id=$1`, [fixtures.wos.communityId],
      ));
      const result = await guestService("wos", "2030-08-21T09:10:00.000Z").create(
        tokens.wos, guestInput(fixtures.wos.slots[15], 71),
        "unregistered-guest-database-0001",
      );
      assert.equal(result.status, 201);
      const stored = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT entry_provenance,participant_id,discord_user_id,guest_share_link_id
           FROM minister_bookings WHERE slot_id=$1`, [fixtures.wos.slots[15]],
      ));
      assert.deepEqual(stored.rows, [{ entry_provenance: "guest_unregistered",
        participant_id: null, discord_user_id: null,
        guest_share_link_id: fixtures.wos.linkId }]);
      const kingshotPolicy = await withProfile(runtime, "kingshot", (client) => client.query(
        "SELECT require_unregistered_guest_approval FROM booking_settings WHERE community_id=$1",
        [fixtures.kingshot.communityId],
      ));
      assert.equal(kingshotPolicy.rows[0].require_unregistered_guest_approval, true);
      await withProfile(runtime, "wos", (client) => client.query(
        `UPDATE booking_settings SET require_unregistered_guest_approval=true
          WHERE community_id=$1`, [fixtures.wos.communityId],
      ));
    });

    await t.test("guest stores alliance in a 30-minute pending hold and manager views expose it safely", async () => {
      const result = await guestService("wos", "2030-08-21T10:00:00.000Z").create(
        tokens.wos, guestInput(fixtures.wos.slots[0], 1), "guest-pending-request-0001",
      );
      assert.equal(result.status, 202);
      assert.equal(result.body.request.status, "pending_approval");
      assert.equal(new Date(result.body.request.holdExpiresAt).toISOString(), "2030-08-21T10:30:00.000Z");
      fixtures.wos.pendingRequestId = result.body.request.requestId;
      const storedRequest = await withProfile(runtime, "wos", (client) => client.query(
        "SELECT alliance_snapshot FROM booking_approval_requests WHERE id=$1",
        [result.body.request.requestId],
      ));
      assert.deepEqual(storedRequest.rows, [{ alliance_snapshot: "GST" }]);
      const confirmed = await withProfile(runtime, "wos", (client) => client.query(
        "SELECT count(*)::integer AS count FROM minister_bookings WHERE slot_id=$1",
        [fixtures.wos.slots[0]],
      ));
      assert.equal(confirmed.rows[0].count, 0);

      const guestPage = await createGuestBookingPageService({
        gameProfile: "wos", repository: approvalRepositories.wos,
        now: () => new Date("2030-08-21T10:05:00.000Z"),
      }).read(tokens.wos);
      assert.deepEqual(guestPage.community, { code: "9999", displayName: "wos Test Server" });
      assert.deepEqual(guestPage.services[0].requirements, [
        { code: "speedups", label: "Speed-ups (days)", unit: "days" },
      ]);
      assert.equal(guestPage.services[0].slots.find((slot) => slot.time === "08:00").state, "unavailable");

      const publicBoard = await boardService("wos", null, "2030-08-21T10:05:00.000Z").publicBoard();
      const pending = publicBoard.services.flatMap((service) => service.slots).find((slot) => slot.time === "08:00");
      assert.deepEqual(pending, { time: "08:00", state: "pending" });
      assert.deepEqual(publicBoard.community, { code: "9999", displayName: "wos Test Server" });
      assert.equal(publicBoard.services[0].name, "Construction");
      assert.deepEqual(publicBoard.services[0].slots[0], { time: "08:00", state: "pending" });
      const serialized = JSON.stringify(pending);
      assert.doesNotMatch(serialized, /Guest 1|90000001|GST|alliance|speedups|discord|playerId|requestId/i);

      const adminView = await boardService("wos", manager("wos", fixtures.wos.communityId)).adminRequest(result.body.request.requestId);
      assert.equal(adminView.player.inGameName, "Guest 1");
      assert.equal(adminView.player.playerId, "90000001");
      assert.equal(adminView.player.alliance, "GST");
      assert.deepEqual(adminView.requirements, [{ code: "speedups", label: "Speed-ups (days)", value: 18, unit: "days" }]);
      assert.equal(adminView.audit[0].action, "submitted");
      const managerBoard = await boardService("wos", manager("wos", fixtures.wos.communityId)).managerBoard();
      const managerSlot = managerBoard.services[0].slots.find((slot) => slot.time === "08:00");
      assert.equal(managerSlot.player.inGameName, "Guest 1");
      assert.equal(managerSlot.player.alliance, "GST");
      assert.equal(managerSlot.player.playerId, "90000001");
      assert.equal(managerSlot.requirements[0].code, "speedups");
      assert.equal(managerBoard.activity[0].action, "submitted");

      const beforePoll = await withProfile(runtime, "wos", (client) => client.query(`SELECT
        (SELECT count(*)::int FROM booking_outbox WHERE event_type='booking.approval.requested' AND payload->>'requestId'=$1::text AND status='pending') AS pending_outbox,
        (SELECT count(*)::int FROM booking_discord_notifications WHERE request_id=$1::uuid) AS notification_rows`,
      [result.body.request.requestId]));
      assert.deepEqual(beforePoll.rows[0], { pending_outbox: 1, notification_rows: 0 });
      const claimed = await createDiscordIntegrationRepository("wos", runtime)
        .withTransaction((session) => session.claim(10));
      assert.ok(claimed.some((work) => work.type === "manager_discovery"
        && work.requestId === result.body.request.requestId));
      const afterPoll = await withProfile(runtime, "wos", (client) => client.query(`SELECT
        (SELECT status FROM booking_outbox WHERE event_type='booking.approval.requested' AND payload->>'requestId'=$1::text) AS outbox_status,
        (SELECT status FROM booking_discord_notifications WHERE request_id=$1::uuid AND notification_type='manager_discovery') AS notification_status`,
      [result.body.request.requestId]));
      assert.deepEqual(afterPoll.rows[0], { outbox_status: "delivered", notification_status: "claimed" });
    });

    await t.test("approval preserves guest alliance in the confirmed booking and manager row", async () => {
      await withProfile(runtime, "wos", (client) => client.query(
        `INSERT INTO booking_approval_discord_messages
           (game_profile,id,community_id,request_id,discord_guild_id,
            discord_channel_id,discord_message_id,delivery_status,sent_at)
         VALUES
           ('wos',$1,$2,$3,$4,'channel-a','message-a','sent',now()),
           ('wos',$5,$2,$3,$4,'channel-b','message-b','sent',now())`,
        [randomUUID(), fixtures.wos.communityId, fixtures.wos.pendingRequestId, fixtures.wos.guildId, randomUUID()],
      ));
      const approved = await approvalService("wos", undefined, "2030-08-21T10:10:00.000Z").approve(fixtures.wos.pendingRequestId);
      assert.equal(approved.outcome, "confirmed");
      const publicEntry = (await boardService("wos").publicBoard()).services.flatMap((service) => service.slots).find((slot) => slot.time === "08:00");
      assert.deepEqual(publicEntry, { time: "08:00", state: "confirmed", playerAlliance: "GST", playerName: "Guest 1" });
      assert.doesNotMatch(JSON.stringify(publicEntry), /90000001|speedups|discord|playerId|requestId|bookingId/i);
      const detail = await boardService("wos", manager("wos", fixtures.wos.communityId)).adminRequest(fixtures.wos.pendingRequestId);
      assert.equal(detail.status, "confirmed");
      assert.equal(detail.decision.discordUserId, "manager-1");
      assert.equal(detail.decision.displayName, "Mark");
      assert.equal(detail.audit.at(-1).previousState, "pending_approval");
      assert.equal(detail.audit.at(-1).resultingState, "confirmed");
      const approvedBooking = await withProfile(runtime, "wos", (client) => client.query(
        "SELECT alliance_snapshot,entry_provenance,guest_share_link_id FROM minister_bookings WHERE approval_request_id=$1",
        [fixtures.wos.pendingRequestId],
      ));
      assert.deepEqual(approvedBooking.rows, [{ alliance_snapshot: "GST",
        entry_provenance: "guest_unregistered", guest_share_link_id: fixtures.wos.linkId }]);
      const confirmedManagerSlot = (await boardService("wos", manager("wos", fixtures.wos.communityId)).managerBoard())
        .services[0].slots.find((slot) => slot.time === "08:00");
      assert.equal(confirmedManagerSlot.player.alliance, "GST");
      const messages = await withProfile(runtime, "wos", (client) => client.query(
        "SELECT delivery_status FROM booking_approval_discord_messages WHERE request_id=$1 ORDER BY discord_message_id",
        [fixtures.wos.pendingRequestId],
      ));
      assert.deepEqual(messages.rows, [{ delivery_status: "update_pending" }, { delivery_status: "update_pending" }]);
    });

    await t.test("denial is auditable and releases the slot immediately", async () => {
      const pending = await guestService("wos", "2030-08-21T11:00:00.000Z").create(
        tokens.wos, guestInput(fixtures.wos.slots[1], 2), "guest-denial-request-0001",
      );
      assert.equal((await approvalService("wos", undefined, "2030-08-21T11:05:00.000Z").deny(pending.body.request.requestId)).outcome, "denied");
      const board = await boardService("wos").publicBoard();
      assert.equal(board.services.flatMap((service) => service.slots).find((slot) => slot.time === "09:00").state, "available");
      const detail = await boardService("wos", manager("wos", fixtures.wos.communityId)).adminRequest(pending.body.request.requestId);
      assert.equal(detail.status, "denied");
      assert.equal(detail.audit.at(-1).action, "denied");
    });

    await t.test("expiry releases the slot and preserves an auditable expired request", async () => {
      const pending = await guestService("wos", "2030-08-21T12:00:00.000Z").create(
        tokens.wos, guestInput(fixtures.wos.slots[2], 3), "guest-expiry-request-0001",
      );
      const expired = await approvalService("wos", undefined, "2030-08-21T12:31:00.000Z").expire(pending.body.request.requestId);
      assert.equal(expired.outcome, "expired");
      assert.equal((await boardService("wos").publicBoard()).services.flatMap((service) => service.slots).find((slot) => slot.time === "10:00").state, "available");
      const detail = await boardService("wos", manager("wos", fixtures.wos.communityId)).adminRequest(pending.body.request.requestId);
      assert.equal(detail.status, "expired");
      assert.equal(detail.audit.at(-1).resultingState, "expired");
    });

    await t.test("two simultaneous guests cannot hold the same slot", async () => {
      const outcomes = await Promise.allSettled([
        guestService("wos", "2030-08-21T13:00:00.000Z").create(tokens.wos, guestInput(fixtures.wos.slots[3], 4), "guest-race-request-a-0001"),
        guestService("wos", "2030-08-21T13:00:00.000Z").create(tokens.wos, guestInput(fixtures.wos.slots[3], 5), "guest-race-request-b-0001"),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason.code === "slot_unavailable").length, 1);
    });

    await t.test("one Player ID can hold only one active request per community service", async () => {
      await guestService("wos", "2030-08-21T15:00:00.000Z").create(
        tokens.wos, guestInput(fixtures.wos.slots[12], 20), "guest-player-guard-a-0001",
      );
      await assert.rejects(
        guestService("wos", "2030-08-21T15:01:00.000Z").create(
          tokens.wos, guestInput(fixtures.wos.slots[13], 20), "guest-player-guard-b-0001",
        ),
        (error) => error.code === "pending_request_exists",
      );
      const afterExpiry = await guestService("wos", "2030-08-21T15:31:00.000Z").create(
        tokens.wos, guestInput(fixtures.wos.slots[13], 20), "guest-player-guard-c-0001",
      );
      assert.equal(afterExpiry.body.request.status, "pending_approval");
    });

    await t.test("an active guest hold prevents normal Discord booking", async () => {
      const pending = await guestService("wos").create(tokens.wos, guestInput(fixtures.wos.slots[4], 6), "guest-blocks-discord-0001");
      fixtures.wos.heldForRaceRequestId = pending.body.request.requestId;
      const context = await register("wos", "discord-user-1001");
      await assert.rejects(
        createBookingCreationService({ context, repository: bookingRepositories.wos }).create(
          { serviceCode: "construction", slotId: fixtures.wos.slots[4], requirements: { speedups: 5 } },
          "discord-held-slot-0001",
        ),
        (error) => error.code === "slot_unavailable",
      );
    });

    await t.test("WOS native booking lifecycle retains alliance in the confirmed manager row", async () => {
      const context = await register("wos", "discord-user-1002");
      const creator = createBookingCreationService({ context, repository: bookingRepositories.wos });
      const created = await creator.create(
        { serviceCode: "construction", slotId: fixtures.wos.slots[5], requirements: { speedups: 6 } },
        "discord-normal-create-0001",
      );
      await assert.rejects(
        guestService("wos").create(tokens.wos, guestInput(fixtures.wos.slots[5], 7), "guest-confirmed-slot-0001"),
        (error) => error.code === "slot_unavailable",
      );
      const mutations = createBookingMutationService({ context, repository: bookingRepositories.wos });
      const rescheduled = await mutations.reschedule(
        created.body.booking.bookingId,
        { slotId: fixtures.wos.slots[6], requirements: { speedups: 7 } },
        "discord-normal-reschedule-0001",
      );
      assert.equal(rescheduled.outcome ?? rescheduled.body.outcome, "rescheduled");
      const cancelled = await mutations.cancel(rescheduled.body.booking.bookingId, "discord-normal-cancel-0001");
      assert.equal(cancelled.body.booking.status, "cancelled");
      const displayed = await creator.create(
        { serviceCode: "construction", slotId: fixtures.wos.slots[6], requirements: { speedups: 8 } },
        "discord-normal-manager-display-0001",
      );
      const managerSlot = (await boardService("wos", manager("wos", fixtures.wos.communityId)).managerBoard())
        .services[0].slots.find((slot) => slot.bookingId === displayed.body.booking.bookingId);
      assert.equal(managerSlot.player.alliance, "DSC");
      const publicSlot = (await boardService("wos").publicBoard()).services[0].slots
        .find((slot) => slot.time === displayed.body.booking.displayTime);
      assert.deepEqual(publicSlot, {
        time: displayed.body.booking.displayTime, state: "confirmed",
        playerAlliance: "DSC", playerName: "discord-user-1002",
      });
    });

    async function pendingForRace(slotIndex, suffix, key) {
      return (await guestService("wos", "2030-08-21T14:00:00.000Z").create(
        tokens.wos, guestInput(fixtures.wos.slots[slotIndex], suffix), key,
      )).body.request.requestId;
    }

    await t.test("concurrent approvals allow exactly one transition", async () => {
      const requestId = await pendingForRace(7, 8, "guest-concurrent-approval-0001");
      const outcomes = await Promise.allSettled([
        approvalService("wos", manager("wos", fixtures.wos.communityId, "manager-1"), "2030-08-21T14:05:00.000Z").approve(requestId),
        approvalService("wos", manager("wos", fixtures.wos.communityId, "manager-2"), "2030-08-21T14:05:00.000Z").approve(requestId),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason.code === "invalid_transition").length, 1);
    });

    await t.test("approve-vs-deny race has one final state", async () => {
      const requestId = await pendingForRace(8, 9, "guest-approve-deny-race-0001");
      const outcomes = await Promise.allSettled([
        approvalService("wos", manager("wos", fixtures.wos.communityId, "manager-1"), "2030-08-21T14:05:00.000Z").approve(requestId),
        approvalService("wos", manager("wos", fixtures.wos.communityId, "manager-2"), "2030-08-21T14:05:00.000Z").deny(requestId),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const detail = await boardService("wos", manager("wos", fixtures.wos.communityId)).adminRequest(requestId);
      assert.ok(["confirmed", "denied"].includes(detail.status));
      assert.equal(detail.audit.filter((event) => ["approved", "denied"].includes(event.action)).length, 1);
    });

    await t.test("approve-vs-expiry race has one final state", async () => {
      const requestId = await pendingForRace(9, 10, "guest-approve-expire-race-0001");
      const outcomes = await Promise.allSettled([
        approvalService("wos", manager("wos", fixtures.wos.communityId), "2030-08-21T14:29:59.000Z").approve(requestId),
        approvalService("wos", manager("wos", fixtures.wos.communityId), "2030-08-21T14:31:00.000Z").expire(requestId),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const detail = await boardService("wos", manager("wos", fixtures.wos.communityId)).adminRequest(requestId);
      assert.ok(["confirmed", "expired"].includes(detail.status));
      assert.equal(detail.audit.filter((event) => ["approved", "expired"].includes(event.action)).length, 1);
    });

    await t.test("native bot-manager-role authorization can approve and deny guest requests", async () => {
      const actor = {
        ...manager("wos", fixtures.wos.communityId, "manager-role-user"),
        authorization: { via: "bot_manager_role", guildId: fixtures.wos.guildId },
      };
      const approvedId = await pendingForRace(10, 11, "guest-role-manager-approve-0001");
      assert.equal((await approvalService("wos", actor, "2030-08-21T14:05:00.000Z")
        .approve(approvedId)).outcome, "confirmed");
      const deniedId = await pendingForRace(11, 12, "guest-role-manager-deny-0001");
      assert.equal((await approvalService("wos", actor, "2030-08-21T14:05:00.000Z")
        .deny(deniedId)).outcome, "denied");
    });

    await t.test("Kingshot guest and native manager rows retain alliance while scope stays isolated", async () => {
      const kingshotGuest = await guestService("kingshot").create(
        tokens.kingshot, guestInput(fixtures.kingshot.slots[0], 11), "kingshot-guest-request-0001",
      );
      assert.equal(kingshotGuest.body.request.status, "pending_approval");
      assert.equal((await boardService("kingshot", manager("kingshot", fixtures.kingshot.communityId)).managerBoard())
        .services[0].slots.find((slot) => slot.slotId === fixtures.kingshot.slots[0]).player.alliance, "GST");
      await approvalService("kingshot").approve(kingshotGuest.body.request.requestId);
      assert.equal((await boardService("kingshot", manager("kingshot", fixtures.kingshot.communityId)).managerBoard())
        .services[0].slots.find((slot) => slot.slotId === fixtures.kingshot.slots[0]).player.alliance, "GST");
      assert.deepEqual((await boardService("kingshot").publicBoard()).services[0].slots
        .find((slot) => slot.time === kingshotGuest.body.request.time), {
        time: kingshotGuest.body.request.time, state: "confirmed",
        playerAlliance: "GST", playerName: "Guest 11",
      });
      const kingshotContext = await register("kingshot", "discord-user-2001");
      const kingshotNative = await createBookingCreationService({
        context: kingshotContext, repository: bookingRepositories.kingshot,
      }).create(
        { serviceCode: "construction", slotId: fixtures.kingshot.slots[1], requirements: { speedups: 9 } },
        "kingshot-native-manager-display-0001",
      );
      assert.equal((await boardService("kingshot", manager("kingshot", fixtures.kingshot.communityId)).managerBoard())
        .services[0].slots.find((slot) => slot.bookingId === kingshotNative.body.booking.bookingId).player.alliance, "DSC");
      assert.deepEqual((await boardService("kingshot").publicBoard()).services[0].slots
        .find((slot) => slot.time === kingshotNative.body.booking.displayTime), {
        time: kingshotNative.body.booking.displayTime, state: "confirmed",
        playerAlliance: "DSC", playerName: "discord-user-2001",
      });
      assert.deepEqual((await createGuestBookingPageService({
        gameProfile: "kingshot", repository: approvalRepositories.kingshot,
      }).read(tokens.kingshot)).community, { code: "9999", displayName: "kingshot Test Server" });
      await assert.rejects(
        createGuestBookingPageService({
          gameProfile: "kingshot", repository: approvalRepositories.kingshot,
        }).read(tokens.wos),
        (error) => error.code === "invalid_share_link",
      );
      await assert.rejects(
        guestService("kingshot").create(tokens.wos, guestInput(fixtures.kingshot.slots[1], 12), "wrong-profile-token-0001"),
        (error) => error.code === "invalid_share_link",
      );
      await assert.rejects(
        guestService("wos").create(tokens.wos, { ...guestInput(fixtures.wos.slots[10], 13), communityId: fixtures.kingshot.communityId }, "hostile-community-0001"),
        (error) => error.code === "invalid_scope",
      );
      assert.throws(
        () => approvalService("wos", manager("wos", fixtures.kingshot.communityId)),
        (error) => error.code === "manager_forbidden",
      );
      const communities = await Promise.all(["wos", "kingshot"].map((profile) => withProfile(runtime, profile, (client) => client.query(
        "SELECT game_profile,location_code FROM booking_communities",
      ))));
      assert.deepEqual(communities.map((result) => result.rows), [
        [{ game_profile: "wos", location_code: "9999" }],
        [{ game_profile: "kingshot", location_code: "9999" }],
      ]);
    });

    await t.test("revoked and malformed share tokens are refused", async () => {
      await withProfile(owner, "kingshot", (client) => client.query(
        "UPDATE booking_guest_share_links SET revoked_at=now(),updated_at=now() WHERE id=$1",
        [fixtures.kingshot.linkId],
      ));
      await assert.rejects(
        guestService("kingshot").create(tokens.kingshot, guestInput(fixtures.kingshot.slots[2], 14), "revoked-token-request-0001"),
        (error) => error.code === "invalid_share_link",
      );
      await assert.rejects(
        createGuestBookingPageService({
          gameProfile: "kingshot", repository: approvalRepositories.kingshot,
        }).read(tokens.kingshot),
        (error) => error.code === "invalid_share_link",
      );
      await assert.rejects(
        guestService("wos").create("guessable", guestInput(fixtures.wos.slots[11], 15), "invalid-token-request-0001"),
        (error) => error.code === "invalid_share_link",
      );
    });

    await t.test("production-equivalent runtime grants support approval operations while forced RLS hides the other profile", async () => {
      const wosRows = await withProfile(runtime, "wos", (client) => client.query(
        "SELECT DISTINCT game_profile FROM booking_approval_requests ORDER BY game_profile",
      ));
      assert.deepEqual(wosRows.rows, [{ game_profile: "wos" }]);
      const kingshotRows = await withProfile(runtime, "kingshot", (client) => client.query(
        "SELECT DISTINCT game_profile FROM booking_approval_requests ORDER BY game_profile",
      ));
      assert.deepEqual(kingshotRows.rows, [{ game_profile: "kingshot" }]);
      assert.equal((await runtime.query(
        "SELECT has_table_privilege(current_user,'booking_guest_share_links','UPDATE') AS table_update,has_column_privilege(current_user,'booking_guest_share_links','updated_at','UPDATE') AS lock_update",
      )).rows[0].table_update, false);
    });
  } finally {
    await runtime?.end();
    await owner.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await admin.end();
  }
});
