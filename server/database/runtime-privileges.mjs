export const RUNTIME_READ_TABLES = Object.freeze([
  "booking_communities",
  "booking_discord_guilds",
  "booking_settings",
  "booking_windows",
  "minister_services",
  "booking_service_dates",
  "appointment_slots",
  "booking_slot_blocks",
  "booking_guest_share_links",
]);

export const RUNTIME_WRITE_TABLES = Object.freeze([
  "booking_idempotency_keys",
  "booking_participants",
  "minister_bookings",
  "booking_requirement_answers",
  "booking_change_events",
  "booking_outbox",
  "booking_approval_requests",
  "booking_approval_request_answers",
  "booking_approval_events",
  "booking_approval_discord_messages",
  "website_oauth_states",
  "website_discord_identities",
  "website_auth_sessions",
  "website_auth_session_communities",
  "website_auth_session_selection",
  "website_rate_limit_buckets",
]);

export const RUNTIME_ROW_LOCK_COLUMNS = Object.freeze({
  booking_communities: "updated_at",
  appointment_slots: "updated_at",
  booking_guest_share_links: "updated_at",
});

export const RUNTIME_DISCORD_NOTIFICATION_TABLE = "booking_discord_notifications";
export const RUNTIME_INTEGRATION_NONCE_TABLE = "booking_integration_nonces";

function quotedIdentifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError("Runtime database role name is invalid.");
  }
  return `"${value}"`;
}

export function runtimePrivilegeStatements(role, { includeRowLockPrivileges = true } = {}) {
  const grantee = quotedIdentifier(role);
  return Object.freeze([
    `GRANT SELECT ON ${RUNTIME_READ_TABLES.join(", ")} TO ${grantee}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${RUNTIME_WRITE_TABLES.join(", ")} TO ${grantee}`,
    `GRANT SELECT, INSERT, UPDATE ON ${RUNTIME_DISCORD_NOTIFICATION_TABLE} TO ${grantee}`,
    `GRANT SELECT, INSERT, DELETE ON ${RUNTIME_INTEGRATION_NONCE_TABLE} TO ${grantee}`,
    ...(includeRowLockPrivileges
      ? Object.entries(RUNTIME_ROW_LOCK_COLUMNS).map(([table, column]) => `GRANT UPDATE (${column}) ON ${table} TO ${grantee}`)
      : []),
    `REVOKE ALL ON app_schema_migrations FROM ${grantee}`,
  ]);
}
