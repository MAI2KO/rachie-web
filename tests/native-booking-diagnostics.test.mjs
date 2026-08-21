import assert from "node:assert/strict";
import test from "node:test";

import {
  logNativeBookingFailure,
  nativeBookingFailureDiagnostic,
} from "../server/native-booking/operation-diagnostics.mjs";
import { BookingMembershipVerificationUnavailableError } from "../server/auth/authenticated-booking-context-core.mjs";

test("native booking diagnostics retain only bounded operation, SQLSTATE, category, and request ID", () => {
  const error = Object.assign(new Error("password=secret DATABASE_URL=postgresql://sensitive"), {
    code: "42501",
    query: "SELECT private_user_data FOR UPDATE",
  });
  const request = new Request("https://example.test/api/v1/bookings", {
    headers: {
      cookie: "session=secret",
      "x-request-id": "railway-request-123",
    },
  });
  assert.deepEqual(nativeBookingFailureDiagnostic({ operation: "booking_create", error, request }), {
    event: "native_booking_operation_failed",
    operation: "booking_create",
    category: "database_privilege",
    sqlState: "42501",
    requestId: "railway-request-123",
  });

  let line = "";
  logNativeBookingFailure({ operation: "booking_create", error, request }, (value) => { line = value; });
  assert.deepEqual(JSON.parse(line), nativeBookingFailureDiagnostic({ operation: "booking_create", error, request }));
  assert.doesNotMatch(line, /secret|DATABASE_URL|postgresql|cookie|SELECT|private_user_data/);
});

test("native booking diagnostics reject unbounded identifiers and raw error codes", () => {
  const diagnostic = nativeBookingFailureDiagnostic({
    operation: "hostile operation from user",
    error: { code: "not-a-sqlstate", message: "sensitive" },
    request: new Request("https://example.test", { headers: { "x-request-id": "spaces are not accepted" } }),
  });
  assert.deepEqual(diagnostic, {
    event: "native_booking_operation_failed",
    operation: "unknown",
    category: "internal_error",
  });
});

test("membership verification outages have a distinct secret-free diagnostic category", () => {
  const diagnostic = nativeBookingFailureDiagnostic({
    operation: "booking_reschedule_membership",
    error: new BookingMembershipVerificationUnavailableError(7),
    request: new Request("https://example.test", {
      headers: {
        authorization: "Bot secret-token",
        cookie: "session=secret-session",
        "x-request-id": "membership-refresh-123",
      },
    }),
  });
  assert.deepEqual(diagnostic, {
    event: "native_booking_operation_failed",
    operation: "booking_reschedule_membership",
    category: "discord_membership_verification_unavailable",
    requestId: "membership-refresh-123",
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|token|cookie|authorization/i);
});
