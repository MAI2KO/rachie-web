import {
  automaticBookingUuid,
  automaticWosCyclesToReconcile,
  automaticWosCycleStatus,
  resolveWosBookingCycleWindow,
} from "./domain-core.mjs";
import { automaticWindowGuestTokenRecord } from "./announcement-core.mjs";

const PROFILE = "wos";
const ACTOR_ID = "automatic-wos-28-day-cycle-v1";
const SERVICE_CODES = Object.freeze(["construction", "research", "troop"]);

function defaultSlotTemplate() {
  return Array.from({ length: 48 }, (_, ordinal) => {
    const hour = String(Math.floor(ordinal / 2)).padStart(2, "0");
    const minute = ordinal % 2 ? "30" : "00";
    const time = `${hour}:${minute}`;
    return Object.freeze({ ordinal, display_time_label: time,
      local_start_time: time, time_zone: "UTC", status: "available" });
  });
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile',$1,true)", [PROFILE]);
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

async function listCommunities(pool) {
  return transaction(pool, async (client) => (await client.query(
    `SELECT community.id,community.location_code,
            defaults.open_minute_utc,defaults.close_offset_minutes
       FROM booking_communities AS community
       LEFT JOIN booking_community_window_defaults AS defaults
         ON defaults.game_profile=community.game_profile
        AND defaults.community_id=community.id
      WHERE community.game_profile=$1 AND community.status='active'
      ORDER BY community.id`,
    [PROFILE],
  )).rows);
}

async function findCycleWindow(client, communityId, cycle) {
  const result = await client.query(
    `SELECT booking_window.id
       FROM booking_windows AS booking_window
      WHERE booking_window.game_profile=$1 AND booking_window.community_id=$2
        AND ((booking_window.opens_at=$3 AND booking_window.closes_at=$4)
          OR (EXISTS (SELECT 1 FROM booking_service_dates AS date
                WHERE date.game_profile=$1 AND date.window_id=booking_window.id
                  AND date.service_code='construction' AND date.booking_date=$5)
            AND EXISTS (SELECT 1 FROM booking_service_dates AS date
                WHERE date.game_profile=$1 AND date.window_id=booking_window.id
                  AND date.service_code='research' AND date.booking_date=$6)
            AND EXISTS (SELECT 1 FROM booking_service_dates AS date
                WHERE date.game_profile=$1 AND date.window_id=booking_window.id
                  AND date.service_code='troop' AND date.booking_date=$7)))
      ORDER BY CASE WHEN booking_window.opens_at=$3 AND booking_window.closes_at=$4 THEN 0 ELSE 1 END,
               booking_window.created_at,booking_window.id
      LIMIT 1 FOR UPDATE OF booking_window`,
    [PROFILE, communityId, cycle.opensAt, cycle.closesAt,
     cycle.dates.construction, cycle.dates.research, cycle.dates.troop],
  );
  return result.rows[0]?.id ?? null;
}

async function effectiveCycleForCommunity(client, community, cycle) {
  const recurring = community.open_minute_utc == null ? null : {
    openMinuteUtc: Number(community.open_minute_utc),
    closeOffsetMinutes: Number(community.close_offset_minutes),
  };
  const recurringCycle = resolveWosBookingCycleWindow(cycle, recurring);
  const override = (await client.query(
    `SELECT opens_at,closes_at
       FROM booking_cycle_schedule_overrides
      WHERE game_profile=$1 AND community_id=$2 AND cycle_index=$3`,
    [PROFILE, community.id, cycle.index],
  )).rows[0];
  return override ? Object.freeze({
    ...recurringCycle,
    opensAt: new Date(override.opens_at).toISOString(),
    closesAt: new Date(override.closes_at).toISOString(),
  }) : recurringCycle;
}

async function latestSlotTemplate(client, communityId, serviceCode, beforeDate) {
  const date = (await client.query(
    `SELECT service_date.id
       FROM booking_service_dates AS service_date
      WHERE service_date.game_profile=$1 AND service_date.community_id=$2
        AND service_date.service_code=$3 AND service_date.booking_date<$4
        AND EXISTS (SELECT 1 FROM appointment_slots AS slot
          WHERE slot.game_profile=service_date.game_profile AND slot.service_date_id=service_date.id)
      ORDER BY service_date.booking_date DESC,service_date.created_at DESC,service_date.id DESC
      LIMIT 1`,
    [PROFILE, communityId, serviceCode, beforeDate],
  )).rows[0];
  if (!date) return defaultSlotTemplate();
  return (await client.query(
    `SELECT ordinal,display_time_label,local_start_time::text AS local_start_time,
            time_zone,status
       FROM appointment_slots
      WHERE game_profile=$1 AND service_date_id=$2
      ORDER BY ordinal,id`,
    [PROFILE, date.id],
  )).rows;
}

async function reconcileWindowAnnouncement(client, community, windowId, cycle, at, guestTokenSecret) {
  if (at < new Date(cycle.opensAt) || at >= new Date(cycle.closesAt)) return 0;
  const token = automaticWindowGuestTokenRecord(
    guestTokenSecret, PROFILE, community.id, windowId,
  );
  if (!token) return 0;

  const current = (await client.query(
    `SELECT id FROM booking_guest_share_links
      WHERE game_profile=$1 AND community_id=$2 AND revoked_at IS NULL
      ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
    [PROFILE, community.id],
  )).rows[0] ?? null;
  const linkId = automaticBookingUuid(community.id, windowId, "automatic-guest-link");
  if (current?.id !== linkId) {
    if (current) await client.query(
      `UPDATE booking_guest_share_links
          SET revoked_at=$3,revoked_by_actor_id=$4,updated_at=$3
        WHERE game_profile=$1 AND id=$2 AND revoked_at IS NULL`,
      [PROFILE, current.id, at, ACTOR_ID],
    );
    await client.query(
      `INSERT INTO booking_guest_share_links
         (game_profile,id,community_id,token_hash,token_hint,label,created_by_actor_id,
          expires_at,rotated_from_link_id,booking_window_id)
       VALUES ($1,$2,$3,$4,$5,'Automatic booking window',$6,$7,$8,$9)
       ON CONFLICT (game_profile,id) DO NOTHING`,
      [PROFILE, linkId, community.id, token.tokenHash, token.tokenHint, ACTOR_ID,
       cycle.closesAt, current?.id ?? null, windowId],
    );
  }
  await client.query(
    `UPDATE booking_guest_share_links
        SET expires_at=$3,updated_at=CASE WHEN expires_at IS DISTINCT FROM $3::timestamptz
                                          THEN now() ELSE updated_at END
      WHERE game_profile=$1 AND id=$2 AND revoked_at IS NULL`,
    [PROFILE, linkId, cycle.closesAt],
  );
  const inserted = await client.query(
    `INSERT INTO booking_discord_notifications
       (game_profile,id,community_id,notification_type,booking_window_id,
        guest_share_link_id,due_at,idempotency_key)
     VALUES ($1,$2,$3,'booking_window_open',$4,$5,$6,$7)
     ON CONFLICT (game_profile,community_id,idempotency_key) DO NOTHING`,
    [PROFILE, automaticBookingUuid(windowId, "booking-open-notification"), community.id,
     windowId, linkId, cycle.opensAt, `booking-window-open:${windowId}`],
  );
  return inserted.rowCount;
}

async function reconcileCycle(client, community, cycle, at, guestTokenSecret) {
  const templates = new Map();
  for (const serviceCode of SERVICE_CODES) {
    templates.set(serviceCode, await latestSlotTemplate(
      client, community.id, serviceCode, cycle.dates[serviceCode],
    ));
  }
  if (SERVICE_CODES.some((serviceCode) => templates.get(serviceCode).length === 0)) {
    return { cycleIndex: cycle.index, status: "missing_slot_template", windowsCreated: 0,
      datesCreated: 0, slotsCreated: 0 };
  }

  const desiredStatus = automaticWosCycleStatus(cycle, at);
  let windowId = await findCycleWindow(client, community.id, cycle);
  let windowsCreated = 0;
  if (!windowId) {
    windowId = automaticBookingUuid(community.id, cycle.index, "window");
    const inserted = await client.query(
      `INSERT INTO booking_windows
         (game_profile,id,community_id,status,opens_at,closes_at,opened_at,closed_at,
          created_by_actor_type,created_by_actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,
          CASE WHEN $4 IN ('open','closed') THEN $5::timestamptz END,
          CASE WHEN $4='closed' THEN $6::timestamptz END,'service',$7)
       ON CONFLICT (game_profile,id) DO NOTHING`,
      [PROFILE, windowId, community.id, desiredStatus, cycle.opensAt, cycle.closesAt, ACTOR_ID],
    );
    windowsCreated = inserted.rowCount;
  }
  await client.query(
    `UPDATE booking_windows
        SET status=$4,opens_at=$5,closes_at=$6,
            opened_at=CASE WHEN $4 IN ('open','closed') THEN COALESCE(opened_at,$5::timestamptz) ELSE opened_at END,
            closed_at=CASE WHEN $4='closed' THEN COALESCE(closed_at,$6::timestamptz) ELSE NULL END,
            version=CASE WHEN status<>$4 OR opens_at IS DISTINCT FROM $5::timestamptz
                         OR closes_at IS DISTINCT FROM $6::timestamptz THEN version+1 ELSE version END,
            updated_at=CASE WHEN status<>$4 OR opens_at IS DISTINCT FROM $5::timestamptz
                            OR closes_at IS DISTINCT FROM $6::timestamptz THEN now() ELSE updated_at END
      WHERE game_profile=$1 AND id=$2 AND community_id=$3`,
    [PROFILE, windowId, community.id, desiredStatus, cycle.opensAt, cycle.closesAt],
  );

  let datesCreated = 0;
  let slotsCreated = 0;
  for (const serviceCode of SERVICE_CODES) {
    let serviceDateId = (await client.query(
      `SELECT id FROM booking_service_dates
        WHERE game_profile=$1 AND window_id=$2 AND service_code=$3`,
      [PROFILE, windowId, serviceCode],
    )).rows[0]?.id;
    if (!serviceDateId) {
      serviceDateId = automaticBookingUuid(community.id, cycle.opensAt, serviceCode, "date");
      const inserted = await client.query(
        `INSERT INTO booking_service_dates
           (game_profile,id,community_id,window_id,service_code,booking_date)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [PROFILE, serviceDateId, community.id, windowId, serviceCode, cycle.dates[serviceCode]],
      );
      datesCreated += inserted.rowCount;
      if (inserted.rowCount === 0) {
        serviceDateId = (await client.query(
          `SELECT id FROM booking_service_dates
            WHERE game_profile=$1 AND window_id=$2 AND service_code=$3`,
          [PROFILE, windowId, serviceCode],
        )).rows[0]?.id;
      }
    }
    for (const slot of templates.get(serviceCode)) {
      const slotId = automaticBookingUuid(
        community.id, cycle.opensAt, serviceCode, String(slot.ordinal), "slot",
      );
      const inserted = await client.query(
        `INSERT INTO appointment_slots
           (game_profile,id,community_id,window_id,service_date_id,service_code,booking_date,
            ordinal,display_time_label,local_start_time,time_zone,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING`,
        [PROFILE, slotId, community.id, windowId, serviceDateId, serviceCode,
         cycle.dates[serviceCode], slot.ordinal, slot.display_time_label,
         slot.local_start_time, slot.time_zone, slot.status],
      );
      slotsCreated += inserted.rowCount;
    }
  }
  const announcementsCreated = desiredStatus === "open"
    ? await reconcileWindowAnnouncement(
      client, community, windowId, cycle, at, guestTokenSecret,
    ) : 0;
  return { cycleIndex: cycle.index, status: desiredStatus, windowsCreated, datesCreated,
    slotsCreated, announcementsCreated };
}

export async function reconcileAutomaticWosBookingCycles({
  pool, now = new Date(), futureCycles = 1, guestTokenSecret,
}) {
  const cycles = automaticWosCyclesToReconcile(now, futureCycles);
  const communities = await listCommunities(pool);
  const results = [];
  for (const community of communities) {
    const communityResults = await transaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `automatic-booking-cycle:${PROFILE}:${community.id}`,
      ]);
      await client.query(
        `UPDATE booking_windows
            SET status='closed',closed_at=COALESCE(closed_at,closes_at),version=version+1,updated_at=now()
          WHERE game_profile=$1 AND community_id=$2 AND status='open'
            AND closes_at IS NOT NULL AND closes_at<=$3`,
        [PROFILE, community.id, now],
      );
      await client.query(
        `UPDATE booking_guest_share_links AS link
            SET revoked_at=$3,revoked_by_actor_id=$4,updated_at=$3
          FROM booking_windows AS booking_window
         WHERE link.game_profile=$1 AND link.community_id=$2 AND link.revoked_at IS NULL
           AND link.booking_window_id=booking_window.id
           AND booking_window.game_profile=link.game_profile
           AND booking_window.community_id=link.community_id
           AND booking_window.closes_at<=$3`,
        [PROFILE, community.id, now, ACTOR_ID],
      );
      const reconciled = [];
      for (const cycle of cycles) {
        const effectiveCycle = await effectiveCycleForCommunity(client, community, cycle);
        reconciled.push(await reconcileCycle(
          client, community, effectiveCycle, now, guestTokenSecret,
        ));
      }
      return reconciled;
    });
    results.push({ communityId: community.id, communityCode: community.location_code, cycles: communityResults });
  }
  return Object.freeze({ profile: PROFILE, at: now.toISOString(), communities: Object.freeze(results) });
}
