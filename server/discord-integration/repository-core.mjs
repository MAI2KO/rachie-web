import { randomUUID } from "node:crypto";

import { automaticWindowGuestToken } from "../automatic-booking-cycle/announcement-core.mjs";

const PROFILES = new Set(["wos", "kingshot"]);
const RETRY_MINUTES = [1, 5, 15, 30, 60];

function validId(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

async function appointmentInstant(client, profile, bookingId) {
  const result = await client.query(
    `SELECT COALESCE(slot.starts_at,
              (slot.booking_date + slot.local_start_time) AT TIME ZONE slot.time_zone) AS appointment_at
       FROM minister_bookings AS booking
       JOIN appointment_slots AS slot
         ON slot.game_profile=booking.game_profile AND slot.id=booking.slot_id
      WHERE booking.game_profile=$1 AND booking.id=$2
        AND slot.local_start_time IS NOT NULL AND slot.time_zone IS NOT NULL`,
    [profile, bookingId],
  );
  return result.rows[0]?.appointment_at ?? null;
}

async function insertNotification(client, profile, input) {
  await client.query(
    `INSERT INTO booking_discord_notifications
       (game_profile,id,community_id,notification_type,request_id,booking_id,
        related_booking_id,approval_message_id,recipient_discord_user_id,
        source_discord_guild_id,attribution_display_name,due_at,idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,now()),$13)
     ON CONFLICT (game_profile,community_id,idempotency_key) DO NOTHING`,
    [profile, randomUUID(), input.communityId, input.type, input.requestId ?? null,
     input.bookingId ?? null, input.relatedBookingId ?? null,
     input.approvalMessageId ?? null, input.recipientId ?? null,
     input.sourceGuildId ?? null, input.attributionDisplayName ?? null,
     input.dueAt ?? null, input.key],
  );
}

async function scheduleBookingMessages(client, profile, event, type) {
  const bookingId = event.payload.bookingId;
  if (!validId(bookingId)) return;
  const booking = await client.query(
    `SELECT community_id,discord_user_id,status FROM minister_bookings
      WHERE game_profile=$1 AND id=$2`,
    [profile, bookingId],
  );
  const row = booking.rows[0];
  if (!row?.discord_user_id) return;
  await insertNotification(client, profile, {
    communityId: row.community_id, type, bookingId,
    relatedBookingId: validId(event.payload.replacesBookingId) ? event.payload.replacesBookingId : null,
    recipientId: row.discord_user_id, key: `${event.idempotency_key}:player`,
    attributionDisplayName: event.payload.actorDisplayName ?? null,
  });
  if (row.status !== "confirmed") return;
  const appointmentAt = await appointmentInstant(client, profile, bookingId);
  if (!appointmentAt || appointmentAt <= new Date()) return;
  await insertNotification(client, profile, {
    communityId: row.community_id, type: "appointment_reminder", bookingId,
    recipientId: row.discord_user_id,
    dueAt: new Date(Math.max(Date.now(), appointmentAt.getTime() - 30 * 60_000)),
    key: `appointment-reminder:${bookingId}`,
  });
}

async function scheduleManagerUpdates(client, profile, event) {
  const requestId = event.payload.requestId;
  if (!validId(requestId)) return;
  const messages = await client.query(
    `SELECT id,community_id,recipient_discord_user_id,discord_guild_id
       FROM booking_approval_discord_messages
      WHERE game_profile=$1 AND request_id=$2 AND discord_message_id IS NOT NULL
        AND delivery_status IN ('sent','update_pending','updated')`,
    [profile, requestId],
  );
  for (const message of messages.rows) {
    await insertNotification(client, profile, {
      communityId: message.community_id, type: "manager_update", requestId,
      approvalMessageId: message.id, recipientId: message.recipient_discord_user_id,
      sourceGuildId: message.discord_guild_id,
      key: `${event.idempotency_key}:manager:${message.id}`,
    });
  }
}

async function materializeEvent(client, profile, event) {
  switch (event.event_type) {
    case "booking.created":
      await scheduleBookingMessages(client, profile, event, "player_confirmed");
      break;
    case "booking.rescheduled": {
      const oldId = event.payload.replacesBookingId;
      if (validId(oldId)) {
        await client.query(
          `UPDATE booking_discord_notifications SET status='superseded',updated_at=now()
            WHERE game_profile=$1 AND booking_id=$2 AND notification_type='appointment_reminder'
              AND status IN ('pending','retry','claimed')`, [profile, oldId],
        );
      }
      await scheduleBookingMessages(client, profile, event, "player_rescheduled");
      break;
    }
    case "booking.cancelled": {
      const bookingId = event.payload.bookingId;
      if (validId(bookingId)) {
        await client.query(
          `UPDATE booking_discord_notifications SET status='superseded',updated_at=now()
            WHERE game_profile=$1 AND booking_id=$2 AND notification_type='appointment_reminder'
              AND status IN ('pending','retry','claimed')`, [profile, bookingId],
        );
        await scheduleBookingMessages(client, profile, event, "player_cancelled");
      }
      break;
    }
    case "booking.approval.requested":
      if (validId(event.payload.requestId)) await insertNotification(client, profile, {
        communityId: event.community_id, type: "manager_discovery",
        requestId: event.payload.requestId, key: event.idempotency_key,
      });
      break;
    case "booking.approval.confirmed":
      await scheduleManagerUpdates(client, profile, event);
      await scheduleBookingMessages(client, profile, event, "player_approved");
      break;
    case "booking.approval.denied":
    case "booking.approval.expired":
      await scheduleManagerUpdates(client, profile, event);
      break;
    default:
      return;
  }
  await client.query(
    `UPDATE booking_outbox SET status='delivered',attempts=attempts+1,
       delivered_at=now(),updated_at=now(),last_error_code=NULL
      WHERE game_profile=$1 AND id=$2`, [profile, event.id],
  );
}

async function materializePending(client, profile, limit = 100) {
  const result = await client.query(
    `SELECT * FROM booking_outbox
      WHERE game_profile=$1 AND status IN ('pending','failed') AND available_at<=now()
      ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT $2`, [profile, limit],
  );
  for (const event of result.rows) await materializeEvent(client, profile, event);
}

async function workPayload(client, profile, row, deliveryContext = {}) {
  const base = {
    workId: row.id, claimToken: row.claim_token, profile,
    type: row.notification_type, recipientDiscordUserId: row.recipient_discord_user_id,
    sourceDiscordGuildId: row.source_discord_guild_id,
    attributionDisplayName: row.attribution_display_name,
  };
  if (row.notification_type === "booking_window_open") {
    const result = await client.query(
      `SELECT community.location_code AS "communityCode",
              booking_window.opens_at AS "opensAt",booking_window.closes_at AS "closesAt",
              array_agg(guild.discord_guild_id ORDER BY guild.discord_guild_id)
                FILTER (WHERE guild.discord_guild_id IS NOT NULL) AS guilds
         FROM booking_windows AS booking_window
         JOIN booking_communities AS community
           ON community.game_profile=booking_window.game_profile
          AND community.id=booking_window.community_id
         LEFT JOIN booking_discord_guilds AS guild
           ON guild.game_profile=booking_window.game_profile
          AND guild.community_id=booking_window.community_id
          AND guild.link_status='active'
        WHERE booking_window.game_profile=$1 AND booking_window.id=$2
        GROUP BY community.location_code,booking_window.opens_at,booking_window.closes_at`,
      [profile, row.booking_window_id],
    );
    const details = result.rows[0];
    const guestToken = automaticWindowGuestToken(
      deliveryContext.guestTokenSecret, profile, row.community_id, row.booking_window_id,
    );
    if (!details || !guestToken || !deliveryContext.publicBaseUrl) {
      throw new Error("booking_window_announcement_configuration");
    }
    return {
      ...base,
      ...details,
      guilds: details.guilds ?? [],
      memberUrl: `${deliveryContext.publicBaseUrl}/booking`,
      guestUrl: `${deliveryContext.publicBaseUrl}/book/${guestToken}`,
    };
  }
  if (row.notification_type === "manager_discovery") {
    const guilds = await client.query(
      `SELECT discord_guild_id AS "guildId",bot_manager_role_id AS "managerRoleId"
         FROM booking_discord_guilds WHERE game_profile=$1 AND community_id=$2
           AND link_status='active'
         ORDER BY discord_guild_id`, [profile, row.community_id],
    );
    return { ...base, requestId: row.request_id, guilds: guilds.rows };
  }
  if (row.notification_type === "manager_update") {
    const result = await client.query(
      `SELECT message.discord_channel_id AS "discordChannelId",
              message.discord_message_id AS "discordMessageId",request.status,
              request.decided_by_display_name AS "decidedByDisplayName"
         FROM booking_approval_discord_messages AS message
         JOIN booking_approval_requests AS request
           ON request.game_profile=message.game_profile AND request.id=message.request_id
        WHERE message.game_profile=$1 AND message.id=$2`, [profile, row.approval_message_id],
    );
    return { ...base, requestId: row.request_id, ...result.rows[0] };
  }
  if (row.request_id && !row.booking_id) {
    const result = await client.query(
      `SELECT request.id AS "requestId",request.in_game_name_snapshot AS "playerName",
              request.player_id_snapshot AS "playerId",request.alliance_snapshot AS alliance,
              request.booking_date AS date,request.display_time_label_snapshot AS time,
              request.hold_expires_at AS "holdExpiresAt",service.display_label AS "serviceLabel",
              community.location_code AS "communityCode",community.display_name AS "communityName",
              COALESCE(jsonb_agg(jsonb_build_object('label',answer.display_label,'value',answer.numeric_value,'unit',answer.unit)
                ORDER BY answer.requirement_code) FILTER (WHERE answer.requirement_code IS NOT NULL),'[]') AS requirements
         FROM booking_approval_requests AS request
         JOIN booking_communities AS community ON community.game_profile=request.game_profile AND community.id=request.community_id
         JOIN minister_services AS service ON service.game_profile=request.game_profile AND service.service_code=request.service_code
         LEFT JOIN booking_approval_request_answers AS answer ON answer.game_profile=request.game_profile AND answer.request_id=request.id
        WHERE request.game_profile=$1 AND request.id=$2
        GROUP BY request.id,request.game_profile,request.in_game_name_snapshot,
          request.player_id_snapshot,request.alliance_snapshot,request.booking_date,
          request.display_time_label_snapshot,request.hold_expires_at,
          service.display_label,community.location_code,community.display_name`, [profile, row.request_id],
    );
    return { ...base, ...result.rows[0] };
  }
  const result = await client.query(
    `SELECT booking.id AS "bookingId",booking.in_game_name_snapshot AS "playerName",
            booking.alliance_snapshot AS alliance,booking.booking_date AS date,
            booking.display_time_label_snapshot AS time,booking.status,
            COALESCE(slot.starts_at,
              (slot.booking_date + slot.local_start_time) AT TIME ZONE slot.time_zone) AS "appointmentAt",
            service.display_label AS "serviceLabel",community.location_code AS "communityCode",
            community.display_name AS "communityName",request.decided_by_display_name AS "decidedByDisplayName",
            old.booking_date AS "previousDate",old.display_time_label_snapshot AS "previousTime",
            COALESCE(old_slot.starts_at,
              (old_slot.booking_date + old_slot.local_start_time) AT TIME ZONE old_slot.time_zone) AS "previousAppointmentAt"
       FROM minister_bookings AS booking
       JOIN booking_communities AS community ON community.game_profile=booking.game_profile AND community.id=booking.community_id
       JOIN minister_services AS service ON service.game_profile=booking.game_profile AND service.service_code=booking.service_code
       JOIN appointment_slots AS slot ON slot.game_profile=booking.game_profile AND slot.id=booking.slot_id
       LEFT JOIN booking_approval_requests AS request ON request.game_profile=booking.game_profile AND request.confirmed_booking_id=booking.id
       LEFT JOIN minister_bookings AS old ON old.game_profile=booking.game_profile AND old.id=$3
       LEFT JOIN appointment_slots AS old_slot ON old_slot.game_profile=old.game_profile AND old_slot.id=old.slot_id
      WHERE booking.game_profile=$1 AND booking.id=$2`, [profile, row.booking_id, row.related_booking_id],
  );
  return { ...base, ...result.rows[0] };
}

class DiscordIntegrationSession {
  constructor(client, profile) { this.client = client; this.profile = profile; }

  async consumeNonce(nonce, expiresAt) {
    await this.client.query("DELETE FROM booking_integration_nonces WHERE game_profile=$1 AND expires_at<=now()", [this.profile]);
    const result = await this.client.query(
      `INSERT INTO booking_integration_nonces (game_profile,nonce,expires_at)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce`, [this.profile, nonce, expiresAt],
    );
    return result.rowCount === 1;
  }

  async claim(limit = 10, deliveryContext = {}) {
    await materializePending(this.client, this.profile);
    await this.client.query(
      `UPDATE booking_discord_notifications AS work
          SET status='superseded',updated_at=now(),claim_token=NULL,
              claimed_at=NULL,claimed_until=NULL
         FROM booking_windows AS booking_window
        WHERE work.game_profile=$1 AND work.notification_type='booking_window_open'
          AND work.booking_window_id=booking_window.id
          AND booking_window.game_profile=work.game_profile
          AND booking_window.closes_at<=clock_timestamp()
          AND work.status IN ('pending','retry','claimed')`,
      [this.profile],
    );
    const bounded = Math.max(1, Math.min(Number(limit) || 10, 25));
    const token = randomUUID();
    const result = await this.client.query(
      `WITH candidates AS (
         SELECT id FROM booking_discord_notifications
          WHERE game_profile=$1
            AND ((status IN ('pending','retry') AND due_at<=clock_timestamp() AND COALESCE(next_attempt_at,due_at)<=clock_timestamp())
              OR (status='claimed' AND claimed_until<=clock_timestamp()))
          ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT $2
       ) UPDATE booking_discord_notifications AS work
          SET status='claimed',claim_token=$3,claimed_at=now(),claimed_until=now()+interval '90 seconds',
              attempts=attempts+1,updated_at=now()
         FROM candidates WHERE work.game_profile=$1 AND work.id=candidates.id RETURNING work.*`,
      [this.profile, bounded, token],
    );
    const work = [];
    for (const row of result.rows) work.push(await workPayload(
      this.client, this.profile, row, deliveryContext,
    ));
    return work;
  }

  async registerRecipients(workId, claimToken, recipients) {
    const claimed = await this.client.query(
      `SELECT * FROM booking_discord_notifications WHERE game_profile=$1 AND id=$2
        AND claim_token=$3 AND status='claimed' FOR UPDATE`, [this.profile, workId, claimToken],
    );
    const work = claimed.rows[0];
    if (!work || work.notification_type !== "manager_discovery") return false;
    const request = await this.client.query(
      "SELECT status,hold_expires_at FROM booking_approval_requests WHERE game_profile=$1 AND id=$2",
      [this.profile, work.request_id],
    );
    if (request.rows[0]?.status !== "pending_approval"
        || new Date(request.rows[0].hold_expires_at) <= new Date()) {
      await this.client.query(
        `UPDATE booking_discord_notifications SET status='superseded',claim_token=NULL,
          claimed_at=NULL,claimed_until=NULL,updated_at=now() WHERE game_profile=$1 AND id=$2`,
        [this.profile, workId],
      );
      return true;
    }
    const guilds = await this.client.query(
      `SELECT discord_guild_id FROM booking_discord_guilds
        WHERE game_profile=$1 AND community_id=$2 AND link_status='active'`,
      [this.profile, work.community_id],
    );
    const allowed = new Set(guilds.rows.map((row) => row.discord_guild_id));
    const unique = new Map();
    for (const recipient of Array.isArray(recipients) ? recipients : []) {
      if (/^\d{1,20}$/.test(recipient?.discordUserId) && allowed.has(recipient?.sourceGuildId)
          && !unique.has(recipient.discordUserId)) unique.set(recipient.discordUserId, recipient.sourceGuildId);
    }
    for (const [recipientId, guildId] of unique) await insertNotification(this.client, this.profile, {
      communityId: work.community_id, type: "manager_request", requestId: work.request_id,
      recipientId, sourceGuildId: guildId, key: `manager-request:${work.request_id}:${recipientId}`,
    });
    await this.client.query(
      `UPDATE booking_discord_notifications SET status='sent',sent_at=now(),claim_token=NULL,
        claimed_at=NULL,claimed_until=NULL,updated_at=now() WHERE game_profile=$1 AND id=$2`,
      [this.profile, workId],
    );
    return true;
  }

  async finish(workId, claimToken, outcome) {
    const claimed = await this.client.query(
      `SELECT * FROM booking_discord_notifications WHERE game_profile=$1 AND id=$2
        AND claim_token=$3 AND status='claimed' FOR UPDATE`, [this.profile, workId, claimToken],
    );
    const work = claimed.rows[0];
    if (!work) return false;
    const state = outcome?.status;
    if (state === "sent") {
      if (work.notification_type === "manager_request") {
        const messageResult = await this.client.query(
          `INSERT INTO booking_approval_discord_messages
             (game_profile,id,community_id,request_id,discord_guild_id,discord_channel_id,
              discord_message_id,recipient_discord_user_id,delivery_status,attempts,sent_at)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,'sent',$9,now()
           WHERE NOT EXISTS (
             SELECT 1 FROM booking_approval_discord_messages
              WHERE game_profile=$1 AND request_id=$4 AND recipient_discord_user_id=$8
           )
           RETURNING id`,
          [this.profile, randomUUID(), work.community_id, work.request_id, work.source_discord_guild_id,
           outcome.discordChannelId, outcome.discordMessageId, work.recipient_discord_user_id, work.attempts],
        );
        let messageId = messageResult.rows[0]?.id;
        if (!messageId) {
          const existing = await this.client.query(
            `UPDATE booking_approval_discord_messages
                SET discord_channel_id=$4,discord_message_id=$5,delivery_status='sent',
                    attempts=$6,sent_at=now(),updated_at=now()
              WHERE game_profile=$1 AND request_id=$2 AND recipient_discord_user_id=$3
              RETURNING id`,
            [this.profile, work.request_id, work.recipient_discord_user_id,
             outcome.discordChannelId, outcome.discordMessageId, work.attempts],
          );
          messageId = existing.rows[0]?.id;
        }
        const current = await this.client.query(
          "SELECT status FROM booking_approval_requests WHERE game_profile=$1 AND id=$2",
          [this.profile, work.request_id],
        );
        if (current.rows[0]?.status !== "pending_approval") {
          await this.client.query(
            "UPDATE booking_approval_discord_messages SET delivery_status='update_pending',updated_at=now() WHERE game_profile=$1 AND id=$2",
            [this.profile, messageId],
          );
          await insertNotification(this.client, this.profile, {
            communityId: work.community_id, type: "manager_update", requestId: work.request_id,
            approvalMessageId: messageId, recipientId: work.recipient_discord_user_id,
            sourceGuildId: work.source_discord_guild_id,
            key: `late-manager-update:${work.request_id}:${messageId}:${current.rows[0].status}`,
          });
        }
      } else if (work.notification_type === "manager_update") {
        await this.client.query(
          `UPDATE booking_approval_discord_messages SET delivery_status='updated',updated_message_at=now(),updated_at=now()
            WHERE game_profile=$1 AND id=$2`, [this.profile, work.approval_message_id],
        );
      }
      await this.client.query(
        `UPDATE booking_discord_notifications SET status='sent',sent_at=now(),discord_channel_id=$3,
          discord_message_id=$4,last_error_code=NULL,claim_token=NULL,claimed_at=NULL,claimed_until=NULL,updated_at=now()
          WHERE game_profile=$1 AND id=$2`, [this.profile, workId, outcome.discordChannelId ?? null, outcome.discordMessageId ?? null],
      );
      return true;
    }
    const permanent = state === "permanent_failure" || work.attempts >= RETRY_MINUTES.length;
    const delay = RETRY_MINUTES[Math.min(work.attempts - 1, RETRY_MINUTES.length - 1)];
    await this.client.query(
      `UPDATE booking_discord_notifications SET status=$3,next_attempt_at=$4,last_error_code=$5,
        claim_token=NULL,claimed_at=NULL,claimed_until=NULL,updated_at=now() WHERE game_profile=$1 AND id=$2`,
      [this.profile, workId, permanent ? "permanent_failure" : "retry",
       permanent ? null : new Date(Date.now() + delay * 60_000), String(outcome?.errorCode ?? "delivery_failed").slice(0, 80)],
    );
    return true;
  }
}

export function createDiscordIntegrationRepository(profile, pool) {
  if (!PROFILES.has(profile)) throw new TypeError("Unsupported Discord integration profile.");
  return Object.freeze({
    gameProfile: profile,
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.game_profile',$1,true)", [profile]);
        const result = await work(new DiscordIntegrationSession(client, profile));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
  });
}
