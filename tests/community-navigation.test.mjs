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
const admin = fs.readFileSync(
  new URL("../components/booking-admin/booking-admin.tsx", import.meta.url), "utf8",
);

test("public community header contains only return-aware Discord authentication", () => {
  assert.match(navigation, /auth\/login\?returnTo=/);
  assert.match(navigation, /Discord: \{session\.user/);
  assert.match(navigation, /\/api\/v1\/auth\/logout/);
  assert.match(navigation, /"Logging out\.\.\." : "Log out"/);
  assert.doesNotMatch(navigation, /Book Appointment \/ My Bookings|href="\/booking"/);
});

test("community navigation has one conditional Booking Admin entry on every view", () => {
  assert.equal(navigation.match(/>Booking Admin<\/Link>/g)?.length, 1);
  assert.match(navigation, /managerAuthorized\s*\?/);
  assert.match(navigation, /setAuthorizedCommunity\(communityCode\)/);
  assert.match(appointments, /resolveAdmin=\{false\}/);
  assert.match(appointments, /showAdmin=\{Boolean\(managerBoard\)\}/);
  assert.match(events, /CommunityPageChrome/);
  assert.match(admin, /CommunityPageChrome[\s\S]*showAdmin/);
  assert.doesNotMatch(navigation, /booking-button booking-button--secondary[^\n]*Booking Admin/);
});

test("all community sections share header, divider, navigation, and ordered page actions", () => {
  const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const source of [appointments, events, admin]) assert.match(source, /CommunityPageChrome/);
  assert.match(navigation, /community-page-heading[\s\S]*CommunityHeaderActions[\s\S]*CommunitySectionNavigation[\s\S]*\{children\}/);
  assert.match(css, /\.community-page-heading \{[^}]*border-bottom: 2px solid/);
  assert.ok(appointments.indexOf("manager-mode-control") > appointments.indexOf("<CommunityPageChrome"));
  assert.doesNotMatch(events, /manager-mode-control|Edit appointments|Copy mode/);
  assert.doesNotMatch(admin, /manager-mode-control|Edit appointments|Copy mode/);
});

test("selected tabs replace redundant community page headings", () => {
  assert.doesNotMatch(events, /<h2[^>]*>Alliance Events<\/h2>|Public schedules for participating alliances/);
  assert.doesNotMatch(appointments, /<h[12][^>]*>Appointments<\/h[12]>/);
  assert.doesNotMatch(admin, /displayName\} Booking Admin|Manage bookings, appointment types/);
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
