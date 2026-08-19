export const LEGACY_BOOKING_BACKEND_ENV = Object.freeze({
  wos: "RACHIE_LEGACY_BOOKING_URL",
  kingshot: "PEGGIE_LEGACY_BOOKING_URL",
});

export function resolveLegacyBookingBackendUrl(profile, env) {
  const environmentName = LEGACY_BOOKING_BACKEND_ENV[profile];
  if (!environmentName) return null;

  const value = String(env[environmentName] ?? "").trim();
  return value || null;
}
