export const SERVICE_ORDER = Object.freeze(["construction", "research", "troop"]);

export function profileTerms(profile) {
  return profile === "kingshot"
    ? { community: "Kingdom", fc: "Truegold", rfc: "Tempered Truegold", shards: "Truegold Dust", speedups: "Speed-ups (days)" }
    : { community: "State", fc: "Fire Crystals", rfc: "Refined Fire Crystals", shards: "Fire Crystal Shards", speedups: "Speed-ups (days)" };
}

export function requirementFields(profile, serviceCode, requirements) {
  const terms = profileTerms(profile);
  const config = requirements?.[serviceCode] ?? {};
  const candidates = serviceCode === "construction"
    ? [["fc", terms.fc, config.fcRequired], ["rfc", terms.rfc, config.rfcRequired], ["speedups", terms.speedups, config.speedupsRequired]]
    : serviceCode === "research"
      ? [["shards", terms.shards, config.shardsRequired], ["speedups", terms.speedups, config.speedupsRequired]]
      : [["speedups", terms.speedups, config.speedupsRequired]];
  return candidates
    .filter(([, , enabled]) => enabled)
    .map(([code, label]) => ({ code, label, ...(code === "speedups" ? { helpText: "Enter whole days only." } : {}) }));
}

export function sortSlots(slots) {
  return [...slots].sort((left, right) => left.ordinal - right.ordinal || left.slotId.localeCompare(right.slotId));
}

export function resolveBookingUiState(session, context, me, errorCode = /** @type {string | null} */ (null)) {
  if (!session) return "loading";
  if (!session.authenticated) return "unauthenticated";
  if (!session.selectedCommunity) return "community-selection";
  if (["membership_refresh_required", "authentication_required"].includes(errorCode)) return "reauthentication-required";
  if (!context || !me) return errorCode ? "unavailable" : "loading-booking";
  if (me.registration?.status !== "registered") return "registration";
  return "dashboard";
}

export function shouldShowLogout(session) {
  return session?.authenticated === true;
}

export function signedOutBookingState(session = { authenticated: false }) {
  return {
    session,
    context: null,
    me: null,
    availability: null,
    availabilityFailed: false,
    selectedService: "construction",
    selectedSlot: "",
    requirements: {},
    mode: null,
    error: "",
    errorCode: null,
    success: "",
    confirmation: null,
  };
}

export function uiError(code, retryAfter) {
  const messages = {
    authentication_required: "Your Discord session has ended. Sign in again to continue.",
    membership_refresh_required: "Your Discord membership needs refreshing. Sign in again before making changes.",
    community_selection_required: "Choose a verified community before booking.",
    registration_required: "Register your player details before booking.",
    bookings_closed: "Bookings are currently closed. Existing appointments can still be cancelled.",
    booking_window_unavailable: "This booking window is not available.",
    slot_unavailable: "That slot was just taken or blocked. The available times have been refreshed.",
    booking_already_exists: "You already have an appointment for this service.",
    invalid_requirements: "Check the required resource values and try again.",
    csrf_invalid: "This page is out of date. Refresh it before trying again.",
    rate_limited: `Too many requests. Try again${retryAfter ? ` in ${retryAfter} seconds` : " shortly"}.`,
    service_unavailable: "The booking service is temporarily unavailable.",
    unavailable: "The booking service is temporarily unavailable.",
  };
  return messages[code] ?? "Something went wrong. Please try again.";
}

export function makeAttemptKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-booking`;
}
