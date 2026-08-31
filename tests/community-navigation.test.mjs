import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const navigation = fs.readFileSync(
  new URL("../components/community-section-navigation.tsx", import.meta.url), "utf8",
);
const appointments = fs.readFileSync(
  new URL("../components/appointment-board/appointment-board.tsx", import.meta.url), "utf8",
);
const events = fs.readFileSync(
  new URL("../components/alliance-events/alliance-events.tsx", import.meta.url), "utf8",
);

test("public community header keeps direct Discord auth separate from booking", () => {
  assert.match(navigation, /href="\/api\/v1\/auth\/login">Log in<\/a>/);
  assert.match(navigation, /Discord: \{session\.user/);
  assert.match(navigation, /\/api\/v1\/auth\/logout/);
  assert.match(navigation, /"Logging out\.\.\." : "Log out"/);
  assert.match(navigation, /href="\/booking">Book Appointment \/ My Bookings<\/Link>/);
  assert.doesNotMatch(navigation, /Log in \/ Book Appointment/);
});

test("community navigation has one conditional Booking Admin entry on every view", () => {
  assert.equal(navigation.match(/>Booking Admin<\/Link>/g)?.length, 1);
  assert.match(navigation, /managerAuthorized\s*\?/);
  assert.match(navigation, /setManagerAuthorized\(true\)/);
  assert.match(appointments, /showAdmin=\{Boolean\(managerBoard\)\}/);
  assert.match(appointments, /CommunityHeaderActions/);
  assert.match(events, /CommunityHeaderActions/);
  assert.doesNotMatch(navigation, /booking-button booking-button--secondary[^\n]*Booking Admin/);
});

test("public State and Kingdom community routes share the same navigation", () => {
  for (const route of [
    "../app/state/[communityCode]/page.tsx",
    "../app/state/[communityCode]/events/page.tsx",
    "../app/state/[communityCode]/admin/page.tsx",
    "../app/kingdom/[communityCode]/page.tsx",
    "../app/kingdom/[communityCode]/events/page.tsx",
    "../app/kingdom/[communityCode]/admin/page.tsx",
  ]) {
    const source = fs.readFileSync(new URL(route, import.meta.url), "utf8");
    assert.match(source, /requiredProfile="(?:wos|kingshot)"/);
  }
});
