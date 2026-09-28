import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { bookingCalendarDay } from "../components/booking-admin/calendar-day.mjs";
import { wosBookingCycleAtIndex } from "../server/automatic-booking-cycle/domain-core.mjs";

const ui = fs.readFileSync(new URL("../components/booking-admin/booking-admin.tsx", import.meta.url), "utf8");

function appointmentsFor(index) {
  const cycle = wosBookingCycleAtIndex(index);
  return {
    cycle,
    appointments: [
      { date: cycle.dates.construction, serviceCode: "construction", serviceName: "Construction" },
      { date: cycle.dates.research, serviceCode: "research", serviceName: "Research" },
      { date: cycle.dates.troop, serviceCode: "troop", serviceName: "Troop Training" },
    ],
  };
}

test("calendar markers follow resolved service dates across cycles", () => {
  for (const index of [1, 2, 5]) {
    const { cycle, appointments } = appointmentsFor(index);
    for (const [serviceCode, icon, label] of [
      ["construction", "hammer", "Construction"],
      ["research", "flask", "Research"],
      ["troop", "helmet", "Troop Training"],
    ]) {
      const day = bookingCalendarDay(cycle.dates[serviceCode], cycle.opensAt.slice(0, 10),
        cycle.closesAt.slice(0, 10), appointments);
      assert.deepEqual(day.events, [{ serviceCode, icon, label }]);
    }
    assert.deepEqual(bookingCalendarDay(cycle.opensAt.slice(0, 10), "", "", appointments).events, []);
  }
});

test("calendar endpoints, selected range, and event markers coexist", () => {
  const { cycle, appointments } = appointmentsFor(2);
  const openDate = cycle.dates.construction;
  const closeDate = cycle.dates.troop;
  const open = bookingCalendarDay(openDate, openDate, closeDate, appointments);
  const middle = bookingCalendarDay(cycle.dates.research, openDate, closeDate, appointments);
  const close = bookingCalendarDay(closeDate, openDate, closeDate, appointments);
  assert.equal(open.isOpen, true);
  assert.equal(open.inRange, false);
  assert.equal(open.events[0].icon, "hammer");
  assert.equal(middle.inRange, true);
  assert.equal(middle.events[0].icon, "flask");
  assert.equal(close.isClose, true);
  assert.equal(close.inRange, false);
  assert.equal(close.events[0].icon, "helmet");
});

test("Booking window renders calendar markers and retains schedule controls", () => {
  assert.match(ui, /bookingCalendarDay\(date, openDate, closeDate,\s*configuration\.automaticCycle!\.appointments\)/);
  assert.match(ui, /\["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"\]/);
  assert.match(ui, /booking-window-range__events[\s\S]*BookingEventIcon icon=\{event\.icon\}/);
  assert.match(ui, /booking-window-range__endpoint[\s\S]*<small>OPEN<\/small>[\s\S]*<small>CLOSE<\/small>/);
  assert.match(ui, /day\.inRange \? "is-in-range"/);
  assert.match(ui, /bookingWindowState\.status\.toUpperCase\(\)/);
  assert.match(ui, /Cycle #\{configuration\.automaticCycle\.cycleIndex\}/);
  assert.match(ui, /displayCycleRange\(/);
  assert.match(ui, /appointments\.map\(\(appointment\) => appointment\.date\)\.sort\(\)\.at\(-1\)/);
  assert.match(ui, /date\.slice\(8, 10\) === "01"/);
  assert.match(ui, /Default: Wed 00:00 UTC → Sun 12:00 UTC/);
  assert.match(ui, /checked=\{configuration\.community\.bookingsEnabled\}/);
  assert.match(ui, /section: "booking", enabled: !configuration\.community\.bookingsEnabled/);
  assert.match(ui, /Save booking window/);
  assert.match(ui, /Use default window/);
  assert.match(ui, /configuration\.automaticCycle\.status === "open" && !confirmOpenChange/g);
  assert.match(ui, /I understand this changes an already-open booking cycle/);
  for (const redundant of ["Next transition", "Next scheduled opening", "Next scheduled closing",
    "Schedule phase", "Default open", "Default close", "Effective open", "Effective close"]) {
    assert.equal(ui.includes(redundant), false, `${redundant} should not appear in the admin UI`);
  }
});
