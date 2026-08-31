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
  assert.doesNotMatch(form, /Discord (?:ID|user)|discordUserId|communityId|gameProfile/);
  assert.match(css, /@media \(max-width: 39\.99rem\)/);
  assert.match(css, /\.guest-service-options \{ grid-template-columns: 1fr/);
});

test("guest confirmation promotes the profile-correct member flow without changing guest booking", () => {
  const form = fs.readFileSync(new URL("../components/guest-booking/guest-booking-form.tsx", import.meta.url), "utf8");
  assert.match(form, /Awaiting administrator approval/);
  assert.match(form, /request is not confirmed until approved/);
  assert.match(form, /Want faster booking next time\?/);
  assert.match(form, /eligible bookings confirmed automatically without waiting for guest approval/i);
  assert.match(form, /Manage, reschedule and cancel their own appointments/);
  assert.match(form, /automatic gift-code redemption/);
  assert.match(form, /account and VIP points/);
  assert.match(form, /additional member features/);
  assert.match(form, /full \{term\} member booking system/);
  assert.match(form, /href="\/api\/v1\/auth\/login\?returnTo=%2Fbooking">Log in with Discord/);
  assert.doesNotMatch(form, /staging\.|r-a-c-h-i-e\.com|peggie\.r-a-c-h-i-e\.com/);
  assert.equal(form.match(/Submit booking request/g)?.length, 1,
    "guest booking remains one request at a time");
  assert.doesNotMatch(form, /add another appointment|multiple booking|book another service/i);
});

test("guest public API route supports read and submit without auth handlers", () => {
  const route = fs.readFileSync(new URL("../app/api/v1/guest-booking/[token]/route.ts", import.meta.url), "utf8");
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /Authenticated|Discord|session/);
});
