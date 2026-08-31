export const RUNTIME_READ_TABLES = Object.freeze([
  "booking_communities",
  "booking_discord_guilds",
  "booking_settings",
  "booking_windows",
  "minister_services",
  "booking_service_dates",
  "booking_community_services",
  "appointment_slots",
  "booking_slot_blocks",
  "booking_guest_share_links",
  "community_access_grants",
  "booking_cycle_schedule_overrides",
  "booking_community_window_defaults",
  "player_points_ledger",
  "community_points_ledger",
  "community_guild_link_requests",
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

export const RUNTIME_ADMIN_UPDATE_COLUMNS = Object.freeze({
  booking_communities: Object.freeze(["bookings_open", "version", "updated_at"]),
  booking_windows: Object.freeze([
    "status", "opens_at", "closes_at", "opened_at", "closed_at", "version", "updated_at",
  ]),
  booking_settings: Object.freeze([
    "construction_fc_required", "construction_rfc_required",
    "construction_speedups_required", "research_shards_required",
    "research_speedups_required", "troop_speedups_required", "version", "updated_at",
  ]),
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
    `GRANT INSERT, UPDATE ON booking_community_services TO ${grantee}`,
    `GRANT INSERT ON booking_communities, booking_settings TO ${grantee}`,
    `GRANT INSERT ON booking_discord_guilds TO ${grantee}`,
    `GRANT UPDATE (discord_guild_name, linked_by_actor_id, updated_at) ON booking_discord_guilds TO ${grantee}`,
    `GRANT UPDATE (link_status, revoked_at, revoked_by_actor_id, revocation_reason, updated_at) ON booking_discord_guilds TO ${grantee}`,
    `GRANT INSERT ON community_access_grants TO ${grantee}`,
    `GRANT UPDATE (status, verified_at, revoked_at, revoked_by_actor_id, revocation_reason, updated_at) ON community_access_grants TO ${grantee}`,
    `GRANT INSERT, DELETE ON booking_cycle_schedule_overrides TO ${grantee}`,
    `GRANT UPDATE (opens_at, closes_at, updated_by_actor_id, updated_at) ON booking_cycle_schedule_overrides TO ${grantee}`,
    `GRANT INSERT ON booking_community_window_defaults TO ${grantee}`,
    `GRANT UPDATE (open_minute_utc, close_offset_minutes, updated_by_actor_id, updated_at) ON booking_community_window_defaults TO ${grantee}`,
    `GRANT SELECT, INSERT ON player_points_ledger, community_points_ledger TO ${grantee}`,
    `GRANT INSERT ON community_guild_link_requests TO ${grantee}`,
    `GRANT UPDATE (status, decided_by_discord_user_id, decided_at, updated_at) ON community_guild_link_requests TO ${grantee}`,
    `GRANT INSERT ON booking_guest_share_links TO ${grantee}`,
    `GRANT UPDATE (revoked_at, revoked_by_actor_id, updated_at) ON booking_guest_share_links TO ${grantee}`,
    `GRANT INSERT ON booking_windows, booking_service_dates, appointment_slots TO ${grantee}`,
    ...Object.entries(RUNTIME_ADMIN_UPDATE_COLUMNS).map(([table, columns]) =>
      `GRANT UPDATE (${columns.join(", ")}) ON ${table} TO ${grantee}`),
    ...(includeRowLockPrivileges
      ? Object.entries(RUNTIME_ROW_LOCK_COLUMNS).map(([table, column]) => `GRANT UPDATE (${column}) ON ${table} TO ${grantee}`)
      : []),
    `REVOKE ALL ON app_schema_migrations FROM ${grantee}`,
  ]);
}
