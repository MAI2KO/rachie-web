import { validateIdempotencyKey } from "./registration-validation.mjs";
import { isKnownMinisterServiceCode } from "./service-codes.mjs";

export const BOOKING_REQUIREMENT_LIMITS = Object.freeze({ minimum: 1, maximum: 999999 });

export class InvalidBookingRequestError extends Error {
  constructor(code, message, fields = {}) {
    super(message);
    this.name = "InvalidBookingRequestError";
    this.code = code;
    this.fields = Object.freeze(fields);
  }
}

export function validateBookingChoice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidBookingRequestError("invalid_slot", "Booking details are invalid.");
  }
  if (!isKnownMinisterServiceCode(value.serviceCode)) {
    throw new InvalidBookingRequestError("invalid_service", "Invalid minister service code.");
  }
  const slotId = typeof value.slotId === "string" ? value.slotId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slotId)) {
    throw new InvalidBookingRequestError("invalid_slot", "Invalid appointment slot.");
  }
  const requirements = value.requirements ?? {};
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) {
    throw new InvalidBookingRequestError("invalid_requirements", "Requirement answers are invalid.");
  }
  return { serviceCode: value.serviceCode, slotId, requirements };
}

export function validateRescheduleChoice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidBookingRequestError("invalid_slot", "Reschedule details are invalid.");
  }
  const slotId = typeof value.slotId === "string" ? value.slotId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slotId)) {
    throw new InvalidBookingRequestError("invalid_slot", "Invalid appointment slot.");
  }
  const requirements = value.requirements ?? {};
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) {
    throw new InvalidBookingRequestError("invalid_requirements", "Requirement answers are invalid.");
  }
  return { slotId, requirements };
}

const LABELS = Object.freeze({
  wos: Object.freeze({ fc: "Fire Crystals", rfc: "Refined Fire Crystals", shards: "Fire Crystal Shards", speedups: "Speed-ups (days)" }),
  kingshot: Object.freeze({ fc: "Truegold", rfc: "Tempered Truegold", shards: "Truegold Dust", speedups: "Speed-ups (days)" }),
});

export function bookingRequirementLabel(gameProfile, code) {
  return LABELS[gameProfile]?.[code] ?? code;
}

function enabledCodes(serviceCode, settings) {
  if (serviceCode === "construction") return { fc: settings?.construction_fc_required, rfc: settings?.construction_rfc_required, speedups: settings?.construction_speedups_required };
  if (serviceCode === "research") return { shards: settings?.research_shards_required, speedups: settings?.research_speedups_required };
  return { speedups: settings?.troop_speedups_required };
}

export function validateRequirementAnswers(gameProfile, serviceCode, settings, supplied) {
  const enabled = enabledCodes(serviceCode, settings);
  const fields = {};
  const answers = [];
  for (const code of Object.keys(supplied)) {
    if (!(code in enabled) || !enabled[code]) fields[code] = "This requirement is not enabled for the selected service.";
  }
  for (const [code, required] of Object.entries(enabled)) {
    if (!required) continue;
    const value = supplied[code];
    const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
    if (!/^\d+$/.test(text)) {
      fields[code] = `${bookingRequirementLabel(gameProfile, code)} must be a whole number.`;
      continue;
    }
    const numericValue = Number(text);
    if (!Number.isSafeInteger(numericValue) || numericValue < BOOKING_REQUIREMENT_LIMITS.minimum || numericValue > BOOKING_REQUIREMENT_LIMITS.maximum) {
      fields[code] = `${bookingRequirementLabel(gameProfile, code)} must be between 1 and 999999.`;
      continue;
    }
    answers.push({ code, value: numericValue, displayLabel: bookingRequirementLabel(gameProfile, code), unit: code === "speedups" ? "days" : null });
  }
  if (Object.keys(fields).length) {
    throw new InvalidBookingRequestError("invalid_requirements", "Requirement answers are invalid.", fields);
  }
  return answers;
}

export { validateIdempotencyKey };
