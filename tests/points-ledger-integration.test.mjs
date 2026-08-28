import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { createProfileScopedApprovalRepository } from "../server/booking-approval/repository-core.mjs";
import { createBookingApprovalService } from "../server/booking-approval/service-core.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { createBookingCreationService } from "../server/native-booking/booking-creation-service-core.mjs";
import { createBookingMutationService } from "../server/native-booking/booking-mutation-service-core.mjs";
import { createProfileScopedBookingRepository } from "../server/native-booking/repository-core.mjs";
import { createRegistrationService } from "../server/native-booking/registration-service-core.mjs";
import { createProfileScopedPointsRepository } from "../server/points/repository-core.mjs";

const databaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();

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

async function seedCycle(pool, profile, code, guildId) {
  const communityId = randomUUID();
  const windowId = randomUUID();
  const slots = {};
  await withProfile(pool, profile, async (client) => {
    await client.query(
      `INSERT INTO booking_communities
         (game_profile,id,location_code,display_name,bookings_open)
       VALUES ($1,$2,$3,$4,true)`,
      [profile, communityId, code, `${profile} ${code}`],
    );
    await client.query(
      `INSERT INTO booking_settings (game_profile,community_id) VALUES ($1,$2)`,
      [profile, communityId],
    );
    await client.query(
      `INSERT INTO booking_discord_guilds
         (game_profile,discord_guild_id,community_id,discord_guild_name,guild_kind)
       VALUES ($1,$2,$3,$4,'alliance')`,
      [profile, guildId, communityId, `Alliance ${code}`],
    );
    await client.query(
      `INSERT INTO booking_windows
         (game_profile,id,community_id,status,opens_at,closes_at,created_by_actor_type)
       VALUES ($1,$2,$3,'open',now()-interval '1 hour',now()+interval '1 day','system')`,
      [profile, windowId, communityId],
    );
    for (const [ordinal, serviceCode] of ["construction", "research", "troop"].entries()) {
      const dateId = randomUUID();
      const slotId = randomUUID();
      slots[serviceCode] = slotId;
      await client.query(
        `INSERT INTO booking_service_dates
           (game_profile,id,community_id,window_id,service_code,booking_date)
         VALUES ($1,$2,$3,$4,$5,'2026-09-07')`,
        [profile, dateId, communityId, windowId, serviceCode],
      );
      await client.query(
        `INSERT INTO appointment_slots
           (game_profile,id,community_id,window_id,service_date_id,service_code,
            booking_date,ordinal,display_time_label)
         VALUES ($1,$2,$3,$4,$5,$6,'2026-09-07',$7,$8)`,
        [profile, slotId, communityId, windowId, dateId, serviceCode, ordinal, `${ordinal + 9}:00`],
      );
    }
  });
  return { communityId, windowId, guildId, slots };
}

function context(profile, fixture, userId) {
  return {
    gameProfile: profile,
    community: { id: fixture.communityId, discordGuildId: fixture.guildId },
    discordUser: { id: userId },
  };
}

test("points ledgers award canonical events once and remain append-only and isolated", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const schema = `points_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await runMigrations(pool, await loadMigrations(
      fileURLToPath(new URL("../db/migrations/", import.meta.url)),
    ));
    const wos = await seedCycle(pool, "wos", "1001", "111111111111111111");
    const other = await seedCycle(pool, "wos", "1002", "222222222222222222");
    const kingshot = await seedCycle(pool, "kingshot", "2001", "111111111111111111");
    const bookingRepository = createProfileScopedBookingRepository("wos", pool);
    const points = createProfileScopedPointsRepository("wos", pool);
    const registration = createRegistrationService({
      context: context("wos", wos, "player-one"), repository: bookingRepository,
    });
    const created = await registration.upsert({
      playerId: "101", inGameName: "Player One", alliance: "ONE",
    }, "registration-player-one-0001");
    assert.equal(created.body.outcome, "created");
    await registration.upsert({
      playerId: "101", inGameName: "Player One Updated", alliance: "ONE",
    }, "registration-player-one-0002");
    const participant = await bookingRepository.withTransaction((session) =>
      session.findActiveParticipantByDiscordUser(wos.communityId, "player-one"));
    assert.equal(await points.getPlayerBalance(participant.id), 100);

    const creator = createBookingCreationService({
      context: context("wos", wos, "player-one"), repository: bookingRepository,
    });
    const first = await creator.create({
      serviceCode: "construction", slotId: wos.slots.construction, requirements: {},
    }, "booking-player-one-construction-0001");
    const replay = await creator.create({
      serviceCode: "construction", slotId: wos.slots.construction, requirements: {},
    }, "booking-player-one-construction-0001");
    assert.equal(replay.body.booking.bookingId, first.body.booking.bookingId);
    const rescheduleSlot = await withProfile(pool, "wos", async (client) => {
      const template = (await client.query(
        "SELECT service_date_id,booking_date FROM appointment_slots WHERE id=$1",
        [wos.slots.construction],
      )).rows[0];
      const slotId = randomUUID();
      await client.query(
        `INSERT INTO appointment_slots
           (game_profile,id,community_id,window_id,service_date_id,service_code,
            booking_date,ordinal,display_time_label)
         VALUES ('wos',$1,$2,$3,$4,'construction',$5,30,'30:00')`,
        [slotId, wos.communityId, wos.windowId, template.service_date_id, template.booking_date],
      );
      return slotId;
    });
    const mutations = createBookingMutationService({
      context: context("wos", wos, "player-one"), repository: bookingRepository,
    });
    const rescheduled = await mutations.reschedule(
      first.body.booking.bookingId, { slotId: rescheduleSlot, requirements: {} },
      "reschedule-player-one-0001");
    assert.equal(rescheduled.body.outcome, "rescheduled");
    assert.equal(await points.getPlayerBalance(participant.id), 125,
      "rescheduling the confirmed booking does not award again");
    await mutations.cancel(rescheduled.body.booking.bookingId, "cancel-player-one-0001");
    await creator.create({
      serviceCode: "construction", slotId: wos.slots.construction, requirements: {},
    }, "booking-player-one-construction-recreated-0001");
    assert.equal(await points.getPlayerBalance(participant.id), 125,
      "cancel and recreate cannot farm the same cycle/service award");
    await creator.create({
      serviceCode: "research", slotId: wos.slots.research, requirements: {},
    }, "booking-player-one-research-0001");
    assert.equal(await points.getPlayerBalance(participant.id), 150);
    assert.equal(await points.getCommunityBalance(wos.communityId), 50,
      "one guild earns only once for a booking cycle");
    assert.equal((await points.listPlayerEntries(participant.id)).length, 3);
    assert.equal((await points.listCommunityEntries(wos.communityId)).length, 1);

    const approvalIds = await withProfile(pool, "wos", async (client) => {
      const template = (await client.query(
        `SELECT service_date_id,booking_date FROM appointment_slots WHERE id=$1`,
        [wos.slots.troop],
      )).rows[0];
      const ids = [];
      for (const [ordinal, suffix, hashChar] of [[20, "approved", "a"], [21, "denied", "b"]]) {
        const slotId = randomUUID();
        const requestId = randomUUID();
        const key = `points-approval-${suffix}`;
        await client.query(
          `INSERT INTO appointment_slots
             (game_profile,id,community_id,window_id,service_date_id,service_code,
              booking_date,ordinal,display_time_label)
           VALUES ('wos',$1,$2,$3,$4,'troop',$5,$6,$7)`,
          [slotId, wos.communityId, wos.windowId, template.service_date_id,
           template.booking_date, ordinal, `${ordinal}:00`],
        );
        await client.query(
          `INSERT INTO booking_idempotency_keys
             (game_profile,community_id,idempotency_key,operation,request_hash,
              correlation_id,status)
           VALUES ('wos',$1,$2,'discord_booking_request',$3,$4,'completed')`,
          [wos.communityId, key, hashChar.repeat(64), randomUUID()],
        );
        await client.query(
          `INSERT INTO booking_approval_requests
             (game_profile,id,community_id,window_id,service_date_id,service_code,
              booking_date,slot_id,request_source,participant_id,discord_user_id,
              player_id_snapshot,in_game_name_snapshot,alliance_snapshot,
              display_time_label_snapshot,hold_expires_at,idempotency_key,correlation_id)
           VALUES ('wos',$1,$2,$3,$4,'troop',$5,$6,'discord',$7,'player-one',
                   '101','Player One Updated','ONE',$8,now()+interval '1 day',$9,$10)`,
          [requestId, wos.communityId, wos.windowId, template.service_date_id,
           template.booking_date, slotId, participant.id, `${ordinal}:00`, key, randomUUID()],
        );
        ids.push(requestId);
      }
      return ids;
    });
    assert.equal(await points.getPlayerBalance(participant.id), 150,
      "pending approval requests do not earn points");
    const approvals = createBookingApprovalService({
      gameProfile: "wos", communityId: wos.communityId,
      managerContext: { gameProfile: "wos", authorizedCommunityId: wos.communityId,
        discordUserId: "999999999999999999", displayName: "Manager" },
      repository: createProfileScopedApprovalRepository("wos", pool),
    });
    assert.equal((await approvals.approve(approvalIds[0])).outcome, "confirmed");
    assert.equal((await approvals.deny(approvalIds[1])).outcome, "denied");
    assert.equal(await points.getPlayerBalance(participant.id), 175,
      "only the confirmed pending appointment earns");
    assert.equal(await points.getCommunityBalance(wos.communityId), 50,
      "approval in the same guild and cycle does not duplicate participation");

    await points.appendPlayerEntry({
      id: randomUUID(), participantId: participant.id, communityId: wos.communityId,
      pointsDelta: -20, reason: "future_theme_purchase", idempotencyKey: "future-spend:one",
    });
    await points.appendPlayerEntry({
      id: randomUUID(), participantId: participant.id, communityId: wos.communityId,
      pointsDelta: -20, reason: "future_theme_purchase", idempotencyKey: "future-spend:one",
    });
    assert.equal(await points.getPlayerBalance(participant.id), 155);
    assert.equal(await points.getCommunityBalance(other.communityId), 0);
    assert.equal(await createProfileScopedPointsRepository("kingshot", pool)
      .getCommunityBalance(kingshot.communityId), 0);

    await assert.rejects(withProfile(pool, "wos", (client) => client.query(
      "UPDATE player_points_ledger SET points_delta=999 WHERE participant_id=$1",
      [participant.id],
    )), (error) => error.code === "55000");
    await assert.rejects(withProfile(pool, "wos", (client) => client.query(
      "DELETE FROM community_points_ledger WHERE community_id=$1",
      [wos.communityId],
    )), (error) => error.code === "55000");

    await withProfile(pool, "wos", (client) => client.query(
      `UPDATE booking_discord_guilds
          SET link_status='revoked',revoked_at=now()
        WHERE community_id=$1 AND discord_guild_id=$2`,
      [other.communityId, other.guildId],
    ));
    const otherRegistration = createRegistrationService({
      context: context("wos", other, "player-two"), repository: bookingRepository,
    });
    await otherRegistration.upsert({ playerId: "202", inGameName: "Two", alliance: "TWO" },
      "registration-player-two-0001");
    await createBookingCreationService({
      context: context("wos", other, "player-two"), repository: bookingRepository,
    }).create({ serviceCode: "construction", slotId: other.slots.construction, requirements: {} },
      "booking-player-two-0001");
    assert.equal(await points.getCommunityBalance(other.communityId), 0,
      "a revoked alliance source does not earn participation points");
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
