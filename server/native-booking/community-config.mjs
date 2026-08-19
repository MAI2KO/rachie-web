export const NATIVE_BOOKING_COMMUNITY_ENV = Object.freeze({
  wos: "WOS_NATIVE_BOOKING_COMMUNITY_CODE",
  kingshot: "KINGSHOT_NATIVE_BOOKING_COMMUNITY_CODE",
});

export function resolveNativeBookingCommunityCode(gameProfile, environment) {
  const environmentName = NATIVE_BOOKING_COMMUNITY_ENV[gameProfile];
  if (!environmentName) return null;

  const value = String(environment[environmentName] ?? "").trim();
  return value || null;
}
