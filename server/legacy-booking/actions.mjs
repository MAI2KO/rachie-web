export const LEGACY_BOOKING_ACTIONS = Object.freeze([
  "admin_add_booking_for_server",
  "admin_remove_booking_for_server",
  "admin_remove_reserved_slots_for_server",
  "admin_reserve_slots_for_server",
  "book_for_server",
  "clear_bookings_for_server",
  "close_bookings_for_server",
  "delete_registered_player_for_server",
  "get_booking_config_for_server",
  "get_booking_date_for_server",
  "get_booking_link_for_server",
  "get_my_bookings_for_server",
  "get_registered_player_for_server",
  "get_reserved_times_for_server",
  "get_times_for_server",
  "open_bookings_for_server",
  "register_player_for_server",
  "remove_booking_for_server",
  "set_booking_date_for_server",
]);

const legacyBookingActionSet = new Set(LEGACY_BOOKING_ACTIONS);

export function isLegacyBookingAction(action) {
  return typeof action === "string" && legacyBookingActionSet.has(action);
}
