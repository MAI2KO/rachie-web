import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticBookingUuid,
  automaticWosCycleForDisplay,
  automaticWosCyclesToReconcile,
  automaticWosCycleStatus,
  resolveWosBookingCycleWindow,
  wosBookingCycleAtIndex,
  wosBookingCycleIndexAtOrBefore,
} from "../server/automatic-booking-cycle/domain-core.mjs";
import {
  automaticWindowGuestToken,
  automaticWindowGuestTokenRecord,
} from "../server/automatic-booking-cycle/announcement-core.mjs";

test("historical anchor derives the fixed September WOS booking cycle", () => {
  const cycle = wosBookingCycleAtIndex(1);
  assert.equal(cycle.opensAt, "2026-09-02T00:00:00.000Z");
  assert.equal(cycle.closesAt, "2026-09-06T12:00:00.000Z");
  assert.deepEqual(cycle.dates, {
    construction: "2026-09-07",
    research: "2026-09-08",
    troop: "2026-09-10",
  });
  assert.equal(new Date(cycle.opensAt).getUTCDay(), 3);
  assert.equal(new Date(cycle.closesAt).getUTCDay(), 0);
  assert.equal(new Date(cycle.closesAt).getUTCHours(), 12);
});

test("cycles advance exactly 28 days across month and year boundaries", () => {
  assert.equal(wosBookingCycleAtIndex(2).opensAt, "2026-09-30T00:00:00.000Z");
  assert.deepEqual(wosBookingCycleAtIndex(2).dates, {
    construction: "2026-10-05", research: "2026-10-06", troop: "2026-10-08",
  });
  assert.equal(wosBookingCycleAtIndex(3).opensAt, "2026-10-28T00:00:00.000Z");
  assert.equal(wosBookingCycleAtIndex(3).closesAt, "2026-11-01T12:00:00.000Z");
  assert.deepEqual(wosBookingCycleAtIndex(6).dates, {
    construction: "2027-01-25", research: "2027-01-26", troop: "2027-01-28",
  });
  assert.equal(wosBookingCycleIndexAtOrBefore(new Date("2026-09-29T23:59:59.999Z")), 1);
  assert.equal(wosBookingCycleIndexAtOrBefore(new Date("2026-09-30T00:00:00.000Z")), 2);
});

test("community defaults repeat every 28 days without moving Minister service days", () => {
  const recurring = { openMinuteUtc: 0, closeOffsetMinutes: (5 * 1440) + 1439 };
  const first = resolveWosBookingCycleWindow(wosBookingCycleAtIndex(1), recurring);
  const second = resolveWosBookingCycleWindow(wosBookingCycleAtIndex(2), recurring);
  assert.equal(first.opensAt, "2026-09-02T00:00:00.000Z");
  assert.equal(first.closesAt, "2026-09-07T23:59:00.000Z");
  assert.equal(second.opensAt, "2026-09-30T00:00:00.000Z");
  assert.equal(second.closesAt, "2026-10-05T23:59:00.000Z");
  assert.deepEqual(first.dates, {
    construction: "2026-09-07", research: "2026-09-08", troop: "2026-09-10",
  });
  assert.deepEqual(second.dates, {
    construction: "2026-10-05", research: "2026-10-06", troop: "2026-10-08",
  });
  assert.equal(automaticWosCycleForDisplay(
    new Date("2026-09-07T12:00:00.000Z"), recurring,
  ).index, 1);
});

test("community default resolver rejects closed, inverted, and over-14-day windows", () => {
  const cycle = wosBookingCycleAtIndex(1);
  assert.throws(() => resolveWosBookingCycleWindow(cycle,
    { openMinuteUtc: 60, closeOffsetMinutes: 60 }), /invalid/);
  assert.throws(() => resolveWosBookingCycleWindow(cycle,
    { openMinuteUtc: 60, closeOffsetMinutes: 60 + (14 * 1440) + 1 }), /invalid/);
  assert.equal(resolveWosBookingCycleWindow(cycle,
    { openMinuteUtc: 60, closeOffsetMinutes: 60 + (14 * 1440) }).closesAt,
  "2026-09-16T01:00:00.000Z");
});

test("reconciliation candidates are deterministic current and future cycles", () => {
  assert.deepEqual(
    automaticWosCyclesToReconcile(new Date("2026-08-26T12:00:00.000Z")).map(({ opensAt }) => opensAt),
    ["2026-09-02T00:00:00.000Z", "2026-09-30T00:00:00.000Z"],
  );
  assert.equal(automaticWosCycleForDisplay(new Date("2026-09-04T00:00:00.000Z")).index, 1);
  assert.equal(automaticWosCycleForDisplay(new Date("2026-09-06T12:00:00.000Z")).index, 2);
  assert.equal(automaticBookingUuid("community", "cycle"), automaticBookingUuid("community", "cycle"));
});

test("scheduled availability boundaries are inclusive at open and exclusive at close", () => {
  const cycle = wosBookingCycleAtIndex(1);
  assert.equal(automaticWosCycleStatus(cycle, new Date("2026-09-01T23:59:59.999Z")), "draft");
  assert.equal(automaticWosCycleStatus(cycle, new Date(cycle.opensAt)), "open");
  assert.equal(automaticWosCycleStatus(cycle, new Date("2026-09-06T11:59:59.999Z")), "open");
  assert.equal(automaticWosCycleStatus(cycle, new Date(cycle.closesAt)), "closed");
});

test("automatic guest tokens are opaque, window-specific, and only hash and hint are persisted", () => {
  const secret = "test-booking-integration-secret-value-123456";
  const first = automaticWindowGuestToken(secret, "wos", "community", "window-one");
  const retry = automaticWindowGuestToken(secret, "wos", "community", "window-one");
  const next = automaticWindowGuestToken(secret, "wos", "community", "window-two");
  assert.equal(first, retry);
  assert.notEqual(first, next);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  const persisted = automaticWindowGuestTokenRecord(
    secret, "wos", "community", "window-one",
  );
  assert.deepEqual(Object.keys(persisted).sort(), ["tokenHash", "tokenHint"]);
  assert.equal(persisted.tokenHash.length, 64);
  assert.equal(persisted.tokenHint, first.slice(0, 6));
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(first));
});
