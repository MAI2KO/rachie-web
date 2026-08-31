import { bookingRequirementLabel } from "../native-booking/booking-creation-validation.mjs";
import { isKnownMinisterServiceCode } from "../native-booking/service-codes.mjs";
import {
  automaticWosCycleForDisplay,
  automaticWosCycleStatus,
  wosBookingCycleAtIndex,
} from "../automatic-booking-cycle/domain-core.mjs";

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

export class BookingAdminTopologyDeniedError extends Error {
  constructor(message = "Only the State/Kingdom Discord owner or this alliance Discord owner may unlink it.") {
    super(message);
    this.name = "BookingAdminTopologyDeniedError";
    this.code = "guild_unlink_forbidden";
  }
}

export class BookingAdminGuildLinkDecisionDeniedError extends Error {
  constructor(message = "Only the shared State/Kingdom Discord owner, or an existing alliance Discord owner when no shared Discord is configured, may decide this request.") {
    super(message);
    this.name = "BookingAdminGuildLinkDecisionDeniedError";
    this.code = "guild_link_decision_forbidden";
  }
}

export class BookingAdminTopologyUnavailableError extends Error {
  constructor(message = "Discord ownership could not be verified right now.") {
    super(message);
    this.name = "BookingAdminTopologyUnavailableError";
    this.code = "guild_ownership_unavailable";
  }
}

function dateOnly(value) {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

export function validateBookingAdminChange(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.section !== "string") {
    throw new BookingAdminValidationError();
  }
  if (value.section === "guestLink" && exactKeys(value, ["section", "action"])
      && ["generate", "rotate", "revoke"].includes(value.action)) {
    return Object.freeze({ section: "guestLink", action: value.action });
  }
  if (value.section === "discordAccess"
      && exactKeys(value, ["section", "action", "guildId", "confirmed"])
      && value.action === "unlink" && value.confirmed === true
      && /^\d{15,22}$/.test(String(value.guildId))) {
    return Object.freeze({ section: "discordAccess", action: "unlink", guildId: String(value.guildId) });
  }
  if (value.section === "guildLinkRequest"
      && exactKeys(value, ["section", "action", "requestId", "confirmed"])
      && ["approve", "reject"].includes(value.action) && value.confirmed === true
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value.requestId))) {
    return Object.freeze({ section: "guildLinkRequest", action: value.action,
      requestId: String(value.requestId) });
  }
  if (value.section === "cycleSchedule" && value.action === "override"
      && exactKeys(value, ["section", "action", "cycleIndex", "opensAt", "closesAt", "confirmedOpenChange"])
      && Number.isInteger(value.cycleIndex) && typeof value.confirmedOpenChange === "boolean") {
    const opensAt = new Date(value.opensAt);
    const closesAt = new Date(value.closesAt);
    if (!Number.isFinite(opensAt.getTime()) || !Number.isFinite(closesAt.getTime())) {
      throw new BookingAdminValidationError("invalid_schedule", "Open and close must be valid UTC instants.");
    }
    return Object.freeze({ section: "cycleSchedule", action: "override",
      cycleIndex: value.cycleIndex, opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString(),
      confirmedOpenChange: value.confirmedOpenChange });
  }
  if (value.section === "cycleSchedule" && value.action === "restore"
      && exactKeys(value, ["section", "action", "cycleIndex", "confirmedOpenChange"])
      && Number.isInteger(value.cycleIndex) && typeof value.confirmedOpenChange === "boolean") {
    return Object.freeze({ section: "cycleSchedule", action: "restore",
      cycleIndex: value.cycleIndex, confirmedOpenChange: value.confirmedOpenChange });
  }
  if (typeof value.enabled !== "boolean") throw new BookingAdminValidationError();
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

export function validateCycleScheduleTiming(change, now = new Date(), existingOverride = null) {
  const defaults = wosBookingCycleAtIndex(change.cycleIndex);
  const targetEffective = existingOverride ? Object.freeze({
    ...defaults,
    opensAt: new Date(existingOverride.opens_at).toISOString(),
    closesAt: new Date(existingOverride.closes_at).toISOString(),
  }) : defaults;
  if (automaticWosCycleStatus(targetEffective, now) === "closed") {
    throw new BookingAdminValidationError("historical_cycle", "A closed historical cycle cannot be changed.");
  }
  const current = effectiveWosCycleForDisplay(now, existingOverride ? [existingOverride] : []);
  if (change.cycleIndex !== current.index) {
    throw new BookingAdminValidationError("cycle_not_current", "Only the displayed current booking cycle can be changed.");
  }
  const opensAt = change.action === "restore" ? new Date(defaults.opensAt) : new Date(change.opensAt);
  const closesAt = change.action === "restore" ? new Date(defaults.closesAt) : new Date(change.closesAt);
  const earliestOpen = new Date(new Date(defaults.opensAt).getTime() - (7 * 86_400_000));
  const firstAppointment = new Date(`${defaults.dates.construction}T00:00:00.000Z`);
  if (!(opensAt < closesAt) || opensAt < earliestOpen || closesAt >= firstAppointment) {
    throw new BookingAdminValidationError("invalid_schedule",
      "The override must open within seven days before the automatic opening and close before Construction begins.");
  }
  const currentEffective = existingOverride ? Object.freeze({
    ...current,
    opensAt: new Date(existingOverride.opens_at).toISOString(),
    closesAt: new Date(existingOverride.closes_at).toISOString(),
  }) : current;
  const currentStatus = automaticWosCycleStatus(currentEffective, now);
  if (currentStatus === "open") {
    if (!change.confirmedOpenChange) {
      throw new BookingAdminValidationError("confirmation_required",
        "Changing an already-open cycle requires explicit confirmation.");
    }
    if (now < opensAt || now >= closesAt) {
      throw new BookingAdminValidationError("unsafe_open_cycle_change",
        "An already-open cycle must remain open after the change.");
    }
  }
  return Object.freeze({ defaults, opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() });
}

export function effectiveWosCycleForDisplay(now, scheduleOverrides = []) {
  const automatic = automaticWosCycleForDisplay(now);
  const overrides = scheduleOverrides ?? [];
  const prior = automatic.index > 1 ? overrides.find(
    (override) => Number(override.cycle_index) === automatic.index - 1,
  ) : null;
  if (prior) {
    const priorDefault = wosBookingCycleAtIndex(automatic.index - 1);
    const priorEffective = Object.freeze({
      ...priorDefault,
      opensAt: new Date(prior.opens_at).toISOString(),
      closesAt: new Date(prior.closes_at).toISOString(),
    });
    if (automaticWosCycleStatus(priorEffective, now) !== "closed") return priorEffective;
  }
  const selected = overrides.find((override) => Number(override.cycle_index) === automatic.index);
  return selected ? Object.freeze({
    ...automatic,
    opensAt: new Date(selected.opens_at).toISOString(),
    closesAt: new Date(selected.closes_at).toISOString(),
  }) : automatic;
}

export function bookingAdminModel(gameProfile, snapshot, now = new Date(), ownership = new Map()) {
  const guilds = snapshot.guilds ?? [];
  const scheduleOverrides = snapshot.scheduleOverrides ?? [];
  const settings = snapshot.settings ?? {};
  const requirementsByService = new Map(snapshot.services.map((service) => [
    service.service_code,
    Object.freeze((BOOKING_ADMIN_REQUIREMENTS[service.service_code] ?? []).map((code) => Object.freeze({
      code,
      label: bookingRequirementLabel(gameProfile, code),
      enabled: Boolean(settings[BOOKING_ADMIN_REQUIREMENT_COLUMNS[service.service_code][code]]),
    }))),
  ]));
  const automaticCycle = gameProfile === "wos" ? effectiveWosCycleForDisplay(now, scheduleOverrides) : null;
  const automaticDefaults = automaticCycle ? wosBookingCycleAtIndex(automaticCycle.index) : null;
  const scheduleOverride = automaticCycle ? scheduleOverrides.find(
    (override) => Number(override.cycle_index) === automaticCycle.index,
  ) : null;
  const effectiveCycle = automaticCycle;
  const guestLink = snapshot.guestLink ?? null;
  const guestLinkActive = Boolean(guestLink && !guestLink.revoked_at
    && (!guestLink.expires_at || new Date(guestLink.expires_at) > now));
  const activeGuilds = guilds.filter((guild) => guild.link_status === "active");
  const stateGuildConfigured = activeGuilds.some((guild) => guild.guild_kind === "state");
  const canDecideGuildLinks = stateGuildConfigured ? ownership.get("state") === true
    : activeGuilds.some((guild) => guild.guild_kind === "alliance"
      && ownership.get(guild.discord_guild_id) === true);
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
    guestLink: Object.freeze({
      status: guestLinkActive ? "active" : guestLink?.revoked_at ? "revoked" : "inactive",
    }),
    discordAccess: Object.freeze({
      stateGuildConfigured,
      pendingRequests: Object.freeze((snapshot.guildLinkRequests ?? []).map((request) => Object.freeze({
        id: request.id,
        guildId: request.requesting_discord_guild_id,
        guildName: request.requesting_discord_guild_name,
        kind: request.requested_guild_kind,
        alliance: request.alliance_abbreviation,
        requestedByDiscordUserId: request.requested_by_discord_user_id,
        requestedAt: new Date(request.requested_at).toISOString(),
        canDecide: canDecideGuildLinks,
      }))),
      unclassifiedGuilds: Object.freeze(guilds.filter((guild) => guild.guild_kind === "unclassified"
        && guild.link_status === "active").map((guild) => Object.freeze({
        id: guild.discord_guild_id,
        displayName: guild.discord_guild_name,
      }))),
      guilds: Object.freeze(guilds.filter((guild) => guild.guild_kind === "alliance"
        && guild.link_status === "active").map((guild) => Object.freeze({
        id: guild.discord_guild_id,
        displayName: guild.discord_guild_name,
        canUnlink: ownership.get(guild.discord_guild_id) === true
          || ownership.get("state") === true,
      }))),
    }),
    automaticCycle: effectiveCycle ? Object.freeze({
      cycleIndex: effectiveCycle.index,
      status: automaticWosCycleStatus(effectiveCycle, now),
      automaticOpensAt: automaticDefaults.opensAt,
      automaticClosesAt: automaticDefaults.closesAt,
      opensAt: effectiveCycle.opensAt,
      closesAt: effectiveCycle.closesAt,
      overridden: Boolean(scheduleOverride),
      appointments: Object.freeze(snapshot.services
        .filter((service) => effectiveCycle.dates[service.service_code])
        .map((service) => Object.freeze({
          serviceCode: service.service_code,
          serviceName: service.display_label,
          date: effectiveCycle.dates[service.service_code],
        }))),
    }) : null,
    windows: Object.freeze(snapshot.windows.map((window) => Object.freeze({
      status: window.status,
      opensAt: window.opens_at ?? null,
      closesAt: window.closes_at ?? null,
    }))),
    dates: Object.freeze(snapshot.dates.map((date) => Object.freeze({
      serviceCode: date.service_code,
      serviceName: date.display_label,
      date: dateOnly(date.booking_date),
      windowStatus: date.window_status,
    }))),
    activity: Object.freeze((snapshot.activity ?? []).map((event) => Object.freeze({
      action: event.action,
      category: event.category,
      playerName: event.player_name,
      playerId: event.player_id,
      actorDiscordUserId: event.actor_discord_user_id,
      actorDisplayName: event.actor_display_name,
      serviceCode: event.service_code,
      previousState: event.previous_state,
      resultingState: event.resulting_state,
      previousTime: event.previous_time,
      newTime: event.new_time,
      bookingDate: event.booking_date ? dateOnly(event.booking_date) : null,
      settingSection: event.setting_section,
      requirementCode: event.requirement_code,
      enabled: event.enabled === "true" ? true : event.enabled === "false" ? false : null,
      guildName: event.guild_name,
      cycleIndex: event.cycle_index === null ? null : Number(event.cycle_index),
      createdAt: event.created_at instanceof Date
        ? event.created_at.toISOString() : String(event.created_at),
    }))),
  });
}
