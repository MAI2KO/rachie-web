import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("guest page is anonymous, token-scoped, mobile-first, and dynamically renders requirements", () => {
  const form = fs.readFileSync(new URL("../components/guest-booking/guest-booking-form.tsx", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../app/book/[token]/page.tsx", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(page, /GuestBookingLoader/);
  assert.match(page, /brand\.game\.profile/);
  assert.match(form, /fetch\(`\/api\/v1\/guest-booking\/\$\{encodeURIComponent\(token\)\}`/);
  assert.match(form, /service\?\.requirements\.map/);
  assert.match(form, /inputMode="numeric"/);
  assert.match(form, /Submit booking request/);
  assert.match(form, /not confirmed until approved/);
  assert.doesNotMatch(form, /Discord (?:ID|user|login)|discordUserId|communityId|gameProfile/);
  assert.match(css, /@media \(max-width: 39\.99rem\)/);
  assert.match(css, /\.guest-service-options \{ grid-template-columns: 1fr/);
});

test("guest public API route supports read and submit without auth handlers", () => {
  const route = fs.readFileSync(new URL("../app/api/v1/guest-booking/[token]/route.ts", import.meta.url), "utf8");
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /Authenticated|Discord|session/);
});
