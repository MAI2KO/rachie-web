import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { reconcileAutomaticWosBookingCycles } from "../server/automatic-booking-cycle/repository-core.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { createNativeBookingReadService } from "../server/native-booking/read-service-core.mjs";
import { createProfileScopedBookingRepository } from "../server/native-booking/repository-core.mjs";

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

test("automatic WOS cycle reconciliation is isolated, idempotent, and respects manager enablement", {
  skip: !databaseUrl && "TEST_DATABASE_URL is not configured",
}, async () => {
  const schema = `automatic_booking_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const wosCommunityId = randomUUID();
  const kingshotCommunityId = randomUUID();
  const legacyWindowId = randomUUID();
  const bookingId = randomUUID();
  const guestTokenSecret = "integration-booking-secret-value-123456789";
  try {
    await runMigrations(pool, await loadMigrations(
      fileURLToPath(new URL("../db/migrations/", import.meta.url)),
    ));
    await withProfile(pool, "wos", async (client) => {
      await client.query(
        `INSERT INTO booking_communities
           (game_profile,id,location_code,display_name,status,bookings_open)
         VALUES ('wos',$1,'9999','State 9999','active',true)`,
        [wosCommunityId],
      );
      await client.query(
        `INSERT INTO booking_windows
           (game_profile,id,community_id,status,opens_at,closes_at,opened_at,closed_at,
            created_by_actor_type,created_by_actor_id)
         VALUES ('wos',$1,$2,'closed','2026-08-05T00:00:00Z','2026-08-09T12:00:00Z',
                 '2026-08-05T00:00:00Z','2026-08-09T12:00:00Z','system','legacy-template')`,
        [legacyWindowId, wosCommunityId],
      );
      await client.query(
        `INSERT INTO booking_discord_guilds
           (game_profile,discord_guild_id,community_id,discord_guild_name,guild_kind)
         VALUES ('wos','777777777777777777',$1,'Test Guild','alliance')`,
        [wosCommunityId],
      );
      await client.query(
        `INSERT INTO booking_cycle_schedule_overrides
           (game_profile,community_id,cycle_index,opens_at,closes_at,
            created_by_actor_id,updated_by_actor_id)
         VALUES ('wos',$1,1,'2026-09-01T18:00:00Z','2026-09-06T18:00:00Z','manager','manager')`,
        [wosCommunityId],
      );
      await client.query(
        `INSERT INTO booking_community_window_defaults
           (game_profile,community_id,open_minute_utc,close_offset_minutes,
            created_by_actor_id,updated_by_actor_id)
         VALUES ('wos',$1,0,$2,'manager','manager')`,
        [wosCommunityId, (5 * 1440) + 1439],
      );
      for (const [serviceCode, bookingDate] of [
        ["construction", "2026-08-10"], ["research", "2026-08-11"], ["troop", "2026-08-13"],
      ]) {
        const dateId = randomUUID();
        const slotId = randomUUID();
        await client.query(
          `INSERT INTO booking_service_dates
             (game_profile,id,community_id,window_id,service_code,booking_date)
           VALUES ('wos',$1,$2,$3,$4,$5)`,
          [dateId, wosCommunityId, legacyWindowId, serviceCode, bookingDate],
        );
        await client.query(
          `INSERT INTO appointment_slots
             (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,
              ordinal,display_time_label,local_start_time,time_zone,status)
           VALUES ('wos',$1,$2,$3,$4,$5,$6,0,'10:00','10:00','UTC','available')`,
          [slotId, wosCommunityId, legacyWindowId, dateId, serviceCode, bookingDate],
        );
        if (serviceCode === "construction") {
          const idempotencyKey = "existing-booking-fixture";
          await client.query(
            `INSERT INTO booking_idempotency_keys
               (game_profile,community_id,idempotency_key,operation,request_hash,correlation_id,status)
             VALUES ('wos',$1,$2,'fixture',$3,'fixture-correlation','completed')`,
            [wosCommunityId, idempotencyKey, "a".repeat(64)],
          );
          await client.query(
            `INSERT INTO minister_bookings
               (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,
                slot_id,player_id_snapshot,in_game_name_snapshot,alliance_snapshot,
                display_time_label_snapshot,source,actor_type,idempotency_key,correlation_id)
             VALUES ('wos',$1,$2,$3,$4,$5,$6,$7,'1','Existing Player','OLD','10:00',
                     'legacy_import','system',$8,'fixture-correlation')`,
            [bookingId, wosCommunityId, legacyWindowId, dateId, serviceCode,
             bookingDate, slotId, idempotencyKey],
          );
        }
      }
    });
    await withProfile(pool, "kingshot", async (client) => {
      await client.query(
        `INSERT INTO booking_communities
           (game_profile,id,location_code,display_name,status,bookings_open)
         VALUES ('kingshot',$1,'9999','Kingdom 9999','active',true)`,
        [kingshotCommunityId],
      );
      await client.query(
        `INSERT INTO booking_windows
           (game_profile,id,community_id,status,created_by_actor_type)
         VALUES ('kingshot',$1,$2,'closed','system')`,
        [randomUUID(), kingshotCommunityId],
      );
    });

    const beforeOpen = new Date("2026-09-01T17:59:59.999Z");
    await reconcileAutomaticWosBookingCycles({ pool, now: beforeOpen, guestTokenSecret });
    const repository = createProfileScopedBookingRepository("wos", pool);
    const read = createNativeBookingReadService({
      gameProfile: "wos", communityId: wosCommunityId, repository,
    });
    assert.equal((await read.getContext()).bookingsOpen, false);

    const countsAfterFirst = await withProfile(pool, "wos", (client) => client.query(
      `SELECT
         (SELECT count(*)::int FROM booking_windows WHERE community_id=$1) AS windows,
         (SELECT count(*)::int FROM booking_service_dates WHERE community_id=$1) AS dates,
         (SELECT count(*)::int FROM appointment_slots WHERE community_id=$1) AS slots`,
      [wosCommunityId],
    ));
    await reconcileAutomaticWosBookingCycles({ pool, now: beforeOpen, guestTokenSecret });
    const countsAfterSecond = await withProfile(pool, "wos", (client) => client.query(
      `SELECT
         (SELECT count(*)::int FROM booking_windows WHERE community_id=$1) AS windows,
         (SELECT count(*)::int FROM booking_service_dates WHERE community_id=$1) AS dates,
         (SELECT count(*)::int FROM appointment_slots WHERE community_id=$1) AS slots`,
      [wosCommunityId],
    ));
    assert.deepEqual(countsAfterSecond.rows[0], countsAfterFirst.rows[0]);
    assert.deepEqual(countsAfterFirst.rows[0], { windows: 3, dates: 9, slots: 9 });

    await reconcileAutomaticWosBookingCycles({ pool, now: new Date("2026-09-01T18:00:00.000Z"), guestTokenSecret });
    assert.equal((await read.getContext()).bookingsOpen, true);
    const openLifecycle = await withProfile(pool, "wos", (client) => client.query(
      `SELECT
         (SELECT count(*)::int FROM booking_guest_share_links
           WHERE community_id=$1 AND revoked_at IS NULL) AS active_links,
         (SELECT count(*)::int FROM booking_discord_notifications
           WHERE community_id=$1 AND notification_type='booking_window_open') AS announcements,
         (SELECT count(*)::int FROM booking_discord_notifications
           WHERE community_id=$1 AND notification_type='manager_guest_link') AS manual_announcements,
         (SELECT bool_and(token_hash ~ '^[0-9a-f]{64}$') FROM booking_guest_share_links
           WHERE community_id=$1) AS hashes_only,
         (SELECT min(expires_at) FROM booking_guest_share_links
           WHERE community_id=$1 AND revoked_at IS NULL) AS expires_at,
         (SELECT min(due_at) FROM booking_discord_notifications
           WHERE community_id=$1 AND notification_type='booking_window_open') AS due_at`,
      [wosCommunityId],
    ));
    assert.deepEqual(openLifecycle.rows[0], {
      active_links: 1, announcements: 1, manual_announcements: 0, hashes_only: true,
      expires_at: new Date("2026-09-06T18:00:00.000Z"),
      due_at: new Date("2026-09-01T18:00:00.000Z"),
    });
    await withProfile(pool, "wos", (client) => client.query(
      `UPDATE booking_cycle_schedule_overrides
          SET closes_at='2026-09-06T19:00:00Z',updated_at=now()
        WHERE community_id=$1 AND cycle_index=1`,
      [wosCommunityId],
    ));
    await reconcileAutomaticWosBookingCycles({
      pool, now: new Date("2026-09-03T00:00:00.000Z"), guestTokenSecret,
    });
    const restartCount = await withProfile(pool, "wos", (client) => client.query(
      `SELECT count(*)::int AS count FROM booking_discord_notifications
        WHERE community_id=$1 AND notification_type='booking_window_open'`,
      [wosCommunityId],
    ));
    assert.equal(restartCount.rows[0].count, 1);
    const changedLifecycle = await withProfile(pool, "wos", (client) => client.query(
      `SELECT booking_window.closes_at,link.expires_at
         FROM booking_windows AS booking_window
         JOIN booking_guest_share_links AS link ON link.booking_window_id=booking_window.id
        WHERE booking_window.community_id=$1 AND link.revoked_at IS NULL`, [wosCommunityId],
    ));
    assert.deepEqual(changedLifecycle.rows, [{
      closes_at: new Date("2026-09-06T19:00:00.000Z"),
      expires_at: new Date("2026-09-06T19:00:00.000Z"),
    }], "changing an announced cycle updates lifecycle times without another announcement");
    await reconcileAutomaticWosBookingCycles({ pool, now: new Date("2026-09-06T12:00:00.000Z"), guestTokenSecret });
    assert.equal((await read.getContext()).bookingsOpen, true,
      "the override, not the default close, controls availability");
    await reconcileAutomaticWosBookingCycles({ pool, now: new Date("2026-09-06T18:00:00.000Z"), guestTokenSecret });
    assert.equal((await read.getContext()).bookingsOpen, true);
    await reconcileAutomaticWosBookingCycles({ pool, now: new Date("2026-09-06T19:00:00.000Z"), guestTokenSecret });
    assert.equal((await read.getContext()).bookingsOpen, false);
    const closedLinks = await withProfile(pool, "wos", (client) => client.query(
      `SELECT count(*)::int AS count FROM booking_guest_share_links
        WHERE community_id=$1 AND revoked_at IS NULL`, [wosCommunityId],
    ));
    assert.equal(closedLinks.rows[0].count, 0);

    const nextCycle = await withProfile(pool, "wos", (client) => client.query(
      `SELECT opens_at,closes_at FROM booking_windows AS booking_window
        WHERE community_id=$1 AND EXISTS (
          SELECT 1 FROM booking_service_dates AS date
           WHERE date.window_id=booking_window.id AND date.service_code='construction'
             AND date.booking_date='2026-10-05')`,
      [wosCommunityId],
    ));
    assert.deepEqual(nextCycle.rows, [{
      opens_at: new Date("2026-09-30T00:00:00.000Z"),
      closes_at: new Date("2026-10-05T23:59:00.000Z"),
    }], "the following cycle uses the community recurring default");

    await withProfile(pool, "wos", (client) => client.query(
      "UPDATE booking_communities SET bookings_open=false WHERE id=$1", [wosCommunityId],
    ));
    await reconcileAutomaticWosBookingCycles({ pool, now: new Date("2026-09-30T00:00:00.000Z"), guestTokenSecret });
    assert.equal((await read.getContext()).bookingsOpen, false);

    await reconcileAutomaticWosBookingCycles({ pool, now: new Date("2026-10-28T01:00:00.000Z") });
    const finalState = await withProfile(pool, "wos", (client) => client.query(
      `SELECT
         (SELECT count(*)::int FROM booking_windows WHERE community_id=$1) AS windows,
         (SELECT count(*)::int FROM minister_bookings WHERE id=$2) AS existing_bookings`,
      [wosCommunityId, bookingId],
    ));
    assert.equal(finalState.rows[0].windows, 5);
    assert.equal(finalState.rows[0].existing_bookings, 1);
    const repeatedDefault = await withProfile(pool, "wos", (client) => client.query(
      `SELECT opens_at,closes_at FROM booking_windows AS booking_window
        WHERE community_id=$1 AND EXISTS (
          SELECT 1 FROM booking_service_dates AS date
           WHERE date.window_id=booking_window.id AND date.service_code='construction'
             AND date.booking_date='2026-11-02')`, [wosCommunityId],
    ));
    assert.deepEqual(repeatedDefault.rows, [{
      opens_at: new Date("2026-10-28T00:00:00.000Z"),
      closes_at: new Date("2026-11-02T23:59:00.000Z"),
    }]);
    const kingshotWindows = await withProfile(pool, "kingshot", (client) => client.query(
      "SELECT count(*)::int AS count FROM booking_windows WHERE community_id=$1",
      [kingshotCommunityId],
    ));
    assert.equal(kingshotWindows.rows[0].count, 1);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
