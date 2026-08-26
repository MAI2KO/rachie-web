import { bookingRequirementLabel } from "../native-booking/booking-creation-validation.mjs";
import { isKnownMinisterServiceCode } from "../native-booking/service-codes.mjs";

export const BOOKING_ADMIN_REQUIREMENTS = Object.freeze({
  construction: Object.freeze(["fc", "rfc", "speedups"]),
  research: Object.freeze(["shards", "speedups"]),
  troop: Object.freeze(["speedups"]),
});

export const BOOKING_ADMIN_REQUIREMENT_COLUMNS = Object.freeze({
  construction: Object.freeze({
    fc: "construction_fc_required",
    rfc: "construction_rfc_required",
    speedups: "construction_speedups_required",
  }),
  research: Object.freeze({
    shards: "research_shards_required",
    speedups: "research_speedups_required",
  }),
  troop: Object.freeze({ speedups: "troop_speedups_required" }),
});

export class BookingAdminValidationError extends Error {
  constructor(code = "invalid_configuration", message = "Booking configuration is invalid.") {
    super(message);
    this.name = "BookingAdminValidationError";
    this.code = code;
  }
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

export function validateBookingAdminChange(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.enabled !== "boolean" || typeof value.section !== "string") {
    throw new BookingAdminValidationError();
  }
  if (value.section === "booking" && exactKeys(value, ["section", "enabled"])) {
    return Object.freeze({ section: "booking", enabled: value.enabled });
  }
  if (value.section === "service" && exactKeys(value, ["section", "serviceCode", "enabled"])
      && isKnownMinisterServiceCode(value.serviceCode)) {
    return Object.freeze({ section: "service", serviceCode: value.serviceCode, enabled: value.enabled });
  }
  if (value.section === "requirement"
      && exactKeys(value, ["section", "serviceCode", "requirementCode", "enabled"])
      && isKnownMinisterServiceCode(value.serviceCode)
      && BOOKING_ADMIN_REQUIREMENTS[value.serviceCode]?.includes(value.requirementCode)) {
    return Object.freeze({
      section: "requirement",
      serviceCode: value.serviceCode,
      requirementCode: value.requirementCode,
      enabled: value.enabled,
    });
  }
  throw new BookingAdminValidationError();
}

export function bookingAdminModel(gameProfile, snapshot) {
  const settings = snapshot.settings ?? {};
  const requirementsByService = new Map(snapshot.services.map((service) => [
    service.service_code,
    Object.freeze((BOOKING_ADMIN_REQUIREMENTS[service.service_code] ?? []).map((code) => Object.freeze({
      code,
      label: bookingRequirementLabel(gameProfile, code),
      enabled: Boolean(settings[BOOKING_ADMIN_REQUIREMENT_COLUMNS[service.service_code][code]]),
    }))),
  ]));
  return Object.freeze({
    profile: gameProfile,
    community: Object.freeze({
      code: snapshot.community.location_code,
      displayName: snapshot.community.display_name,
      bookingsEnabled: Boolean(snapshot.community.bookings_open),
    }),
    services: Object.freeze(snapshot.services.map((service) => Object.freeze({
      code: service.service_code,
      displayName: service.display_label,
      enabled: Boolean(service.enabled),
      requirements: requirementsByService.get(service.service_code) ?? Object.freeze([]),
    }))),
    windows: Object.freeze(snapshot.windows.map((window) => Object.freeze({
      status: window.status,
      opensAt: window.opens_at ?? null,
      closesAt: window.closes_at ?? null,
    }))),
    dates: Object.freeze(snapshot.dates.map((date) => Object.freeze({
      serviceCode: date.service_code,
      serviceName: date.display_label,
      date: String(date.booking_date).slice(0, 10),
      windowStatus: date.window_status,
    }))),
  });
}
