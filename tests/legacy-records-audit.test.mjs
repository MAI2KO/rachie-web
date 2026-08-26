import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("legacy audit rejects unsafe Sheet exposure and documents the scoped import strategy", () => {
  const audit = fs.readFileSync(new URL("../docs/legacy-booking-records-audit.md", import.meta.url), "utf8");
  const adminUi = fs.readFileSync(new URL("../components/booking-admin/booking-admin.tsx", import.meta.url), "utf8");
  const adminRoute = fs.readFileSync(new URL("../server/booking-admin/route-handler.ts", import.meta.url), "utf8");
  const wosApi = fs.readFileSync(new URL(
    "../legacy-reference/rachie-apps-script/WebApi.gs", import.meta.url,
  ), "utf8");
  const kingshotApi = fs.readFileSync(new URL(
    "../legacy-reference/peggie-apps-script/WebApi.gs", import.meta.url,
  ), "utf8");

  for (const api of [wosApi, kingshotApi]) {
    assert.match(api, /action === "times"/);
    assert.match(api, /action === "get_my_bookings_for_server"/);
    assert.doesNotMatch(api, /legacy_history|historical_records|list_all_bookings/);
  }
  assert.match(audit, /No Legacy tab is enabled yet/);
  assert.match(audit, /one-time, profile-aware snapshot\/import/);
  assert.match(audit, /forced RLS/);
  assert.match(audit, /No public iframe/);
  assert.doesNotMatch(`${adminUi}\n${adminRoute}`, /iframe|script\.google|docs\.google|AppsScript/i);
});
