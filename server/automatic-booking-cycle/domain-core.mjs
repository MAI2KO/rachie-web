import { createHash } from "node:crypto";

export const WOS_BOOKING_CYCLE_ANCHOR = "2026-08-05T00:00:00.000Z";
export const WOS_AUTOMATIC_CYCLE_FIRST_OPENING = "2026-09-02T00:00:00.000Z";
export const WOS_BOOKING_CYCLE_DAYS = 28;

const DAY_MS = 86_400_000;
const CYCLE_MS = WOS_BOOKING_CYCLE_DAYS * DAY_MS;
const ANCHOR_MS = Date.parse(WOS_BOOKING_CYCLE_ANCHOR);
const FIRST_AUTOMATIC_INDEX = 1;
const SERVICE_OFFSETS = Object.freeze({ construction: 5, research: 6, troop: 8 });
export const WOS_DEFAULT_WINDOW = Object.freeze({
  openMinuteUtc: 0,
  closeOffsetMinutes: (4 * 24 * 60) + (12 * 60),
});

function validInstant(value, label = "Instant") {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date.`);
  }
  return value.getTime();
}

function cycle(index) {
  if (!Number.isInteger(index)) throw new TypeError("Cycle index must be an integer.");
  const opensAt = new Date(ANCHOR_MS + (index * CYCLE_MS));
  const closesAt = new Date(opensAt.getTime() + (4 * DAY_MS) + (12 * 60 * 60 * 1000));
  const dates = Object.fromEntries(Object.entries(SERVICE_OFFSETS).map(([serviceCode, offset]) => [
    serviceCode,
    new Date(opensAt.getTime() + (offset * DAY_MS)).toISOString().slice(0, 10),
  ]));
  return Object.freeze({
    index,
    opensAt: opensAt.toISOString(),
    closesAt: closesAt.toISOString(),
    dates: Object.freeze(dates),
  });
}

export function resolveWosBookingCycleWindow(cycleDefinition, recurringDefault = null) {
  const openMinuteUtc = recurringDefault?.openMinuteUtc ?? WOS_DEFAULT_WINDOW.openMinuteUtc;
  const closeOffsetMinutes = recurringDefault?.closeOffsetMinutes
    ?? WOS_DEFAULT_WINDOW.closeOffsetMinutes;
  if (!Number.isInteger(openMinuteUtc) || openMinuteUtc < 0 || openMinuteUtc > 1439
      || !Number.isInteger(closeOffsetMinutes) || closeOffsetMinutes <= openMinuteUtc
      || closeOffsetMinutes > openMinuteUtc + (14 * 24 * 60)) {
    throw new TypeError("Recurring booking window offsets are invalid.");
  }
  const anchor = Date.parse(wosBookingCycleAtIndex(cycleDefinition.index).opensAt);
  return Object.freeze({
    ...cycleDefinition,
    opensAt: new Date(anchor + (openMinuteUtc * 60_000)).toISOString(),
    closesAt: new Date(anchor + (closeOffsetMinutes * 60_000)).toISOString(),
  });
}

export function wosBookingCycleAtIndex(index) {
  return cycle(index);
}

export function wosBookingCycleIndexAtOrBefore(at) {
  return Math.floor((validInstant(at) - ANCHOR_MS) / CYCLE_MS);
}

export function automaticWosCyclesToReconcile(at, futureCycles = 1) {
  const atMs = validInstant(at);
  if (!Number.isInteger(futureCycles) || futureCycles < 0 || futureCycles > 12) {
    throw new TypeError("Future cycle count must be an integer from 0 to 12.");
  }
  const first = Math.max(FIRST_AUTOMATIC_INDEX, Math.floor((atMs - ANCHOR_MS) / CYCLE_MS));
  return Object.freeze(Array.from({ length: futureCycles + 1 }, (_, offset) => cycle(first + offset)));
}

export function automaticWosCycleForDisplay(at, recurringDefault = null) {
  const atMs = validInstant(at);
  const currentIndex = Math.floor((atMs - ANCHOR_MS) / CYCLE_MS);
  const current = resolveWosBookingCycleWindow(
    cycle(Math.max(FIRST_AUTOMATIC_INDEX, currentIndex)), recurringDefault,
  );
  if (atMs < Date.parse(current.closesAt)) return current;
  return resolveWosBookingCycleWindow(cycle(current.index + 1), recurringDefault);
}

export function automaticWosCycleStatus(cycleDefinition, at) {
  const atMs = validInstant(at);
  if (atMs < Date.parse(cycleDefinition.opensAt)) return "draft";
  if (atMs < Date.parse(cycleDefinition.closesAt)) return "open";
  return "closed";
}

export function automaticBookingUuid(...parts) {
  const hex = createHash("sha256")
    .update(["automatic-wos-booking-cycle-v1", ...parts].join("\0"))
    .digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
