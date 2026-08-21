const OPERATIONS = new Set([
  "booking_create_context",
  "booking_create_rate_limit",
  "booking_create_membership",
  "booking_create",
  "booking_reschedule_context",
  "booking_reschedule_rate_limit",
  "booking_reschedule_membership",
  "booking_reschedule_prepare",
  "booking_reschedule",
  "booking_cancel_context",
  "booking_cancel_rate_limit",
  "booking_cancel_membership",
  "booking_cancel_prepare",
  "booking_cancel",
  "guest_booking_submit",
]);

function errorCategory(error, sqlState) {
  if (error?.name === "BookingMembershipVerificationUnavailableError") {
    return "discord_membership_verification_unavailable";
  }
  if (sqlState === "42501") return "database_privilege";
  if (sqlState?.startsWith("23")) return "database_constraint";
  if (sqlState?.startsWith("40")) return "database_transaction";
  if (sqlState) return "database_error";
  return "internal_error";
}

function boundedRequestId(request) {
  const value = request?.headers?.get?.("x-request-id");
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

export function nativeBookingFailureDiagnostic({ operation, error, request }) {
  const sqlState = typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
  const requestId = boundedRequestId(request);
  return Object.freeze({
    event: "native_booking_operation_failed",
    operation: OPERATIONS.has(operation) ? operation : "unknown",
    category: errorCategory(error, sqlState),
    ...(sqlState ? { sqlState } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

export function logNativeBookingFailure(input, logger = console.error) {
  logger(JSON.stringify(nativeBookingFailureDiagnostic(input)));
}
