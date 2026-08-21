import { createHash, randomBytes } from "node:crypto";

import {
  validateBookingChoice,
  validateRequirementAnswers,
} from "../native-booking/booking-creation-validation.mjs";
import {
  InvalidRegistrationError,
  validateRegistrationInput,
} from "../native-booking/registration-validation.mjs";

export const DEFAULT_PENDING_HOLD_SECONDS = 30 * 60;
export const APPROVAL_POLICIES = Object.freeze({
  AUTO_APPROVE: "auto_approve",
  REQUIRE_APPROVAL: "require_approval",
});
export const APPROVAL_REQUEST_STATES = Object.freeze({
  PENDING_APPROVAL: "pending_approval",
  CONFIRMED: "confirmed",
  DENIED: "denied",
  EXPIRED: "expired",
});

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function approvalDateOnly(value) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

export class GuestBookingRequestError extends Error {
  constructor(code, message, fields = {}) {
    super(message);
    this.name = "GuestBookingRequestError";
    this.code = code;
    this.fields = Object.freeze(fields);
  }
}

export class BookingApprovalTransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BookingApprovalTransitionError";
    this.code = code;
  }
}

export function generateGuestShareToken() {
  return randomBytes(32).toString("base64url");
}

export function validateGuestShareToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  if (!TOKEN_PATTERN.test(token)) {
    throw new GuestBookingRequestError("invalid_share_link", "Guest booking link is invalid or unavailable.");
  }
  return token;
}

export function hashGuestShareToken(value) {
  return createHash("sha256").update(validateGuestShareToken(value), "utf8").digest("hex");
}

export function guestShareTokenHint(value) {
  return validateGuestShareToken(value).slice(0, 6);
}

export function validateGuestBookingInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GuestBookingRequestError("invalid_request", "Guest booking details are invalid.");
  }
  const forbidden = ["communityId", "community", "gameProfile", "profile", "discordUserId"];
  if (forbidden.some((field) => Object.hasOwn(value, field))) {
    throw new GuestBookingRequestError(
      "invalid_scope",
      "The guest booking link determines the State or Kingdom.",
    );
  }
  let player;
  try {
    player = validateRegistrationInput(value);
  } catch (error) {
    if (error instanceof InvalidRegistrationError) {
      throw new GuestBookingRequestError("invalid_player", error.message, error.fields);
    }
    throw error;
  }
  const choice = validateBookingChoice(value);
  return Object.freeze({ ...player, ...choice });
}

export function validateGuestRequirementAnswers(gameProfile, input, settings) {
  return validateRequirementAnswers(
    gameProfile,
    input.serviceCode,
    settings,
    input.requirements,
  );
}

export function publicBoardEntry(row) {
  const booked = Boolean(row.is_confirmed);
  const pending = !booked && Boolean(row.has_active_hold);
  return Object.freeze({
    time: row.display_time_label,
    state: booked ? "confirmed" : pending ? "pending" : "available",
    ...(booked ? { playerName: row.confirmed_player_name } : {}),
  });
}

export function publicAppointmentBoard(community, rows) {
  const services = [];
  for (const row of rows) {
    let service = services.find((candidate) => candidate.name === row.service_label);
    if (!service) {
      service = { name: row.service_label, date: approvalDateOnly(row.booking_date), slots: [] };
      services.push(service);
    }
    service.slots.push(publicBoardEntry(row));
  }
  return Object.freeze({
    community: Object.freeze({ code: community.location_code, displayName: community.display_name }),
    services: Object.freeze(services.map((service) => Object.freeze({
      ...service, slots: Object.freeze(service.slots),
    }))),
  });
}

const operationalPlayer = (name, id, alliance) => Object.freeze({
  inGameName: name, playerId: id, alliance,
});

const operationalRequirements = (answers) => Object.freeze((answers ?? []).map((answer) => Object.freeze({
  code: answer.code,
  label: answer.label,
  value: Number(answer.value),
  ...(answer.unit ? { unit: answer.unit } : {}),
})));

export function managerAppointmentBoard(community, rows, activity) {
  const services = [];
  for (const row of rows) {
    let service = services.find((candidate) => candidate.code === row.service_code);
    if (!service) {
      service = {
        code: row.service_code,
        name: row.service_label,
        date: approvalDateOnly(row.booking_date),
        slots: [],
      };
      services.push(service);
    }
    const confirmed = Boolean(row.confirmed_booking_id);
    const pending = !confirmed && Boolean(row.pending_request_id);
    service.slots.push(Object.freeze({
      slotId: row.slot_id,
      time: row.display_time_label,
      state: confirmed ? "confirmed" : pending ? "pending" : "available",
      ...(confirmed ? {
        bookingId: row.confirmed_booking_id,
        player: operationalPlayer(row.confirmed_player_name, row.confirmed_player_id, row.confirmed_alliance),
        requirements: operationalRequirements(row.confirmed_requirements),
      } : {}),
      ...(pending ? {
        requestId: row.pending_request_id,
        player: operationalPlayer(row.pending_player_name, row.pending_player_id, row.pending_alliance),
        requirements: operationalRequirements(row.pending_requirements),
        holdExpiresAt: row.pending_hold_expires_at,
      } : {}),
    }));
  }
  return Object.freeze({
    community: Object.freeze({ code: community.location_code, displayName: community.display_name }),
    services: Object.freeze(services.map((service) => Object.freeze({
      ...service, slots: Object.freeze(service.slots),
    }))),
    activity: Object.freeze(activity.map((event) => Object.freeze({
      action: event.action,
      playerName: event.player_name,
      managerDisplayName: event.acting_discord_display_name,
      previousState: event.previous_state,
      resultingState: event.resulting_state,
      createdAt: event.created_at,
    }))),
  });
}

export function adminApprovalRequest(row) {
  return Object.freeze({
    requestId: row.id,
    source: row.request_source,
    status: row.status,
    service: row.service_code,
    date: approvalDateOnly(row.booking_date),
    time: row.display_time_label_snapshot,
    slotId: row.slot_id,
    player: Object.freeze({
      inGameName: row.in_game_name_snapshot,
      playerId: row.player_id_snapshot,
      alliance: row.alliance_snapshot,
      ...(row.discord_user_id ? { discordUserId: row.discord_user_id } : {}),
    }),
    requirements: Object.freeze((row.requirements ?? []).map((answer) => Object.freeze({
      code: answer.code,
      label: answer.label,
      value: Number(answer.value),
      ...(answer.unit ? { unit: answer.unit } : {}),
    }))),
    holdExpiresAt: row.hold_expires_at,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decision: row.decided_by_discord_user_id ? Object.freeze({
      discordUserId: row.decided_by_discord_user_id,
      ...(row.decided_by_display_name ? { displayName: row.decided_by_display_name } : {}),
    }) : null,
    confirmedBookingId: row.confirmed_booking_id,
    audit: Object.freeze((row.audit ?? []).map((event) => Object.freeze({ ...event }))),
  });
}

export function assertTrustedManagerContext(context, gameProfile, communityId) {
  if (!context || context.gameProfile !== gameProfile
      || context.authorizedCommunityId !== communityId
      || typeof context.discordUserId !== "string" || !context.discordUserId) {
    throw new BookingApprovalTransitionError("manager_forbidden", "Manager access is not authorized for this community.");
  }
  return Object.freeze({
    discordUserId: context.discordUserId,
    displayName: typeof context.displayName === "string" && context.displayName.trim()
      ? context.displayName.trim().slice(0, 100)
      : null,
  });
}
