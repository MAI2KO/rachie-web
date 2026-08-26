import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticBookingUuid,
  automaticWosCycleForDisplay,
  automaticWosCyclesToReconcile,
  automaticWosCycleStatus,
  wosBookingCycleAtIndex,
  wosBookingCycleIndexAtOrBefore,
} from "../server/automatic-booking-cycle/domain-core.mjs";

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
