"use client";

import { useEffect, useState } from "react";

import { CommunityPageChrome } from "@/components/community-section-navigation";
import { bookingCalendarDay } from "./calendar-day.mjs";

type Requirement = { readonly code: string; readonly label: string; readonly enabled: boolean };
type Service = {
  readonly code: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly requirements: readonly Requirement[];
};
type Activity = {
  readonly id: string;
  readonly action: string;
  readonly category: "bookings" | "approvals" | "cancellations" | "manager_actions" | "configuration";
  readonly playerName: string | null;
  readonly playerId: string | null;
  readonly actorDiscordUserId: string | null;
  readonly actorDisplayName: string | null;
  readonly serviceCode: string | null;
  readonly previousState: string | null;
  readonly resultingState: string;
  readonly previousTime: string | null;
  readonly newTime: string | null;
  readonly bookingDate: string | null;
  readonly settingSection: string | null;
  readonly requirementCode: string | null;
  readonly enabled: boolean | null;
  readonly guildName: string | null;
  readonly cycleIndex: number | null;
  readonly createdAt: string;
};
type BookingAdminConfiguration = {
  readonly profile: "wos" | "kingshot";
  readonly community: {
    readonly code: string;
    readonly displayName: string;
    readonly bookingsEnabled: boolean;
  };
  readonly services: readonly Service[];
  readonly guestLink: {
    readonly status: "active" | "inactive" | "revoked";
  };
  readonly guestApproval: { readonly requireUnregistered: boolean };
  readonly discordAccess: {
    readonly stateGuildConfigured: boolean;
    readonly pendingRequests: readonly {
      readonly id: string;
      readonly guildId: string;
      readonly guildName: string;
      readonly kind: "state" | "alliance";
      readonly alliance: string | null;
      readonly requestedByDiscordUserId: string;
      readonly requestedAt: string;
      readonly canDecide: boolean;
    }[];
    readonly unclassifiedGuilds: readonly {
      readonly id: string;
      readonly displayName: string;
    }[];
    readonly guilds: readonly {
      readonly id: string;
      readonly displayName: string;
      readonly canUnlink: boolean;
    }[];
  };
  readonly bookingWindowState: {
    readonly status: "open" | "closed";
    readonly reason: "open" | "paused" | "before_open" | "after_close" | "window_not_open";
    readonly persistedWindowStatus: string;
    readonly nextTransitionAt: string | null;
    readonly nextTransitionKind: "opens" | "closes" | null;
    readonly nextScheduledOpening: string | null;
    readonly nextScheduledClosing: string | null;
  };
  readonly automaticCycle: {
    readonly cycleIndex: number;
    readonly status: "draft" | "open" | "closed";
    readonly automaticOpensAt: string;
    readonly automaticClosesAt: string;
    readonly opensAt: string;
    readonly closesAt: string;
    readonly overridden: boolean;
    readonly appointments: readonly {
      readonly serviceCode: string;
      readonly serviceName: string;
      readonly date: string;
    }[];
  } | null;
  readonly windows: readonly {
    readonly status: string;
    readonly opensAt: string | null;
    readonly closesAt: string | null;
  }[];
  readonly dates: readonly {
    readonly serviceCode: string;
    readonly serviceName: string;
    readonly date: string;
    readonly windowStatus: string;
  }[];
  readonly activity: readonly Activity[];
  readonly activityNextCursor: string | null;
};

type Change =
  | { readonly section: "booking"; readonly enabled: boolean }
  | { readonly section: "guestApproval"; readonly enabled: boolean }
  | { readonly section: "service"; readonly serviceCode: string; readonly enabled: boolean }
  | {
      readonly section: "requirement";
      readonly serviceCode: string;
      readonly requirementCode: string;
      readonly enabled: boolean;
    };

function serviceDisplayName(service: { readonly code: string; readonly displayName: string }) {
  return service.code === "troop" ? "Troop Training" : service.displayName;
}

function displayDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function BookingEventIcon({ icon }: { icon: string }) {
  const shared = { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none",
    stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const, focusable: "false" as const, "aria-hidden": true as const };
  if (icon === "hammer") return <svg {...shared}>
    <path d="M4 20 14 10M10 6l8 8M13 3l8 8-3 3-8-8z" />
  </svg>;
  if (icon === "flask") return <svg {...shared}>
    <path d="M8 2h8M10 2v7l-5 8a3 3 0 0 0 2.5 4h9a3 3 0 0 0 2.5-4l-5-8V2M7 16h10" />
  </svg>;
  if (icon === "helmet") return <svg {...shared}>
    <path d="M4 15a8 8 0 0 1 16 0M3 15h18M5 15v4h14v-4M10 19v2h4v-2" />
  </svg>;
  return <svg {...shared}><circle cx="12" cy="12" r="3" /></svg>;
}

function displayCycleRange(opening: string, lastEvent: string) {
  const start = new Date(opening);
  const end = new Date(`${lastEvent}T00:00:00.000Z`);
  const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const year = new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: "UTC" });
  return `${dayMonth.format(start)}${year.format(start) === year.format(end) ? "" : ` ${year.format(start)}`}–${dayMonth.format(end)} ${year.format(end)}`;
}

function displayUtcInstant(instant: string) {
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZone: "UTC",
  }).format(new Date(instant))} UTC`;
}

function utcDate(instant: string) {
  return new Date(instant).toISOString().slice(0, 10);
}

function utcTime(instant: string) {
  return new Date(instant).toISOString().slice(11, 16);
}

function bookingCalendarDays(cycleOpensAt: string) {
  const opening = Date.parse(cycleOpensAt);
  const firstAllowed = opening - (7 * 86_400_000);
  const lastAllowed = opening + (14 * 86_400_000);
  const weekday = (new Date(firstAllowed).getUTCDay() + 6) % 7;
  const firstVisible = firstAllowed - (weekday * 86_400_000);
  const count = Math.ceil(((lastAllowed - firstVisible) / 86_400_000 + 1) / 7) * 7;
  return Array.from({ length: count }, (_, index) => {
    const at = firstVisible + index * 86_400_000;
    return { date: new Date(at).toISOString().slice(0, 10),
      enabled: at >= firstAllowed && at <= lastAllowed };
  });
}

function activityActionLabel(activity: Activity) {
  if (activity.action === "booking_created") return "Booked appointment";
  if (activity.action === "guest_registered_booking_confirmed") return "Booking confirmed";
  if (activity.action === "guest_unregistered_booking_confirmed") return "Guest booking confirmed";
  if (activity.action === "manager_manual_booking") return "Added booking manually";
  if (["booking_rescheduled", "manager_booking_rescheduled"].includes(activity.action)) {
    return "Rescheduled booking";
  }
  if (["booking_cancelled", "manager_booking_cancelled"].includes(activity.action)) {
    return "Cancelled booking";
  }
  if (activity.action === "submitted") return "Submitted guest request";
  if (activity.action === "approved") return "Approved guest booking";
  if (activity.action === "denied") return "Denied guest booking";
  if (activity.action === "expired") return "Guest request expired";
  if (activity.action === "booking_admin_updated") return "Changed booking settings";
  if (activity.action === "guest_link_generate") return "Created guest booking link";
  if (activity.action === "guest_link_rotate") return "Replaced guest booking link";
  if (activity.action === "guest_link_revoke") return "Disabled guest booking link";
  if (activity.action === "alliance_discord_unlinked") return "Removed alliance Discord";
  if (activity.action === "alliance_guild_link_approved") return "Approved alliance Discord";
  if (activity.action === "alliance_guild_link_rejected") return "Rejected alliance Discord";
  if (activity.action.startsWith("booking_cycle_override_")) return "Changed booking window";
  if (activity.action.startsWith("booking_recurring_window_default_")) {
    return "Changed default booking window";
  }
  return activity.action.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function activityActorLabel(activity: Activity) {
  if (activity.actorDisplayName) return activity.actorDisplayName;
  if (activity.actorDiscordUserId) return "Discord member";
  if (activity.action === "submitted") return "Guest player";
  if (activity.action === "expired") return "System";
  if (activity.action === "booking_created") return "Player";
  return "System";
}

function ActivityActor({ activity }: { readonly activity: Activity }) {
  return <>{activityActorLabel(activity)}
    {activity.actorDiscordUserId ? <small className="manager-audit-id">
      Discord ID: {activity.actorDiscordUserId}</small> : null}</>;
}

function readableSetting(value: string | null) {
  if (!value) return "Booking settings";
  if (value === "booking") return "Member bookings";
  if (value === "service") return "Appointment type";
  if (value === "requirement") return "Booking requirement";
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function activityDetails(activity: Activity) {
  if (activity.action === "guest_registered_booking_confirmed") {
    return "Registered player via guest link";
  }
  if (activity.action === "guest_unregistered_booking_confirmed") {
    return "Unregistered guest — approval disabled";
  }
  if (activity.action === "booking_admin_updated") {
    const service = activity.serviceCode ? serviceDisplayName({ code: activity.serviceCode,
      displayName: activity.serviceCode.replace(/^./, (letter) => letter.toUpperCase()) }) : null;
    let target = readableSetting(activity.settingSection);
    if (activity.settingSection === "service" && service) target = `${service} appointment type`;
    if (activity.settingSection === "requirement" && activity.requirementCode) {
      target = [service, `${activity.requirementCode.replaceAll("_", " ")} requirement`]
        .filter(Boolean).join(" — ");
    }
    return activity.enabled === null ? target : `${target} — ${activity.enabled ? "Enabled" : "Disabled"}`;
  }
  if (activity.serviceCode) {
    const service = serviceDisplayName({ code: activity.serviceCode,
      displayName: activity.serviceCode.replace(/^./, (letter) => letter.toUpperCase()) });
    const times = activity.previousTime && activity.newTime
      ? `${activity.previousTime} → ${activity.newTime}`
      : activity.newTime ?? activity.previousTime;
    return [service, times].filter(Boolean).join(" — ");
  }
  if (activity.guildName) return activity.guildName;
  if (activity.cycleIndex !== null) return `Booking cycle ${activity.cycleIndex}`;
  return activity.resultingState.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function SettingSwitch({ checked, disabled, label, onChange }: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: () => void;
}) {
  return <button aria-checked={checked} aria-label={`${label}: ${checked ? "enabled" : "disabled"}`}
    className="booking-admin-switch" disabled={disabled} onClick={onChange} role="switch" type="button">
    <span aria-hidden="true" />
    {checked ? "Enabled" : "Disabled"}
  </button>;
}

export function BookingAdmin({ initialConfiguration }: {
  readonly initialConfiguration: BookingAdminConfiguration;
}) {
  const [configuration, setConfiguration] = useState(initialConfiguration);
  const [csrfToken, setCsrfToken] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [newGuestUrl, setNewGuestUrl] = useState("");
  const [openDate, setOpenDate] = useState(
    initialConfiguration.automaticCycle ? utcDate(initialConfiguration.automaticCycle.opensAt) : "",
  );
  const [openTime, setOpenTime] = useState(
    initialConfiguration.automaticCycle ? utcTime(initialConfiguration.automaticCycle.opensAt) : "00:00",
  );
  const [closeDate, setCloseDate] = useState(
    initialConfiguration.automaticCycle ? utcDate(initialConfiguration.automaticCycle.closesAt) : "",
  );
  const [closeTime, setCloseTime] = useState(
    initialConfiguration.automaticCycle ? utcTime(initialConfiguration.automaticCycle.closesAt) : "12:00",
  );
  const [calendarEndpoint, setCalendarEndpoint] = useState<"open" | "close">("open");
  const [confirmOpenChange, setConfirmOpenChange] = useState(false);
  const [confirmedGuildId, setConfirmedGuildId] = useState("");
  const noun = configuration.profile === "kingshot" ? "Kingdom" : "State";
  const endpoint = `/api/v1/booking-admin/${encodeURIComponent(configuration.community.code)}`;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/v1/auth/session", { cache: "no-store" })
        .then((response) => response.json())
        .then((payload) => {
          if (payload.authenticated && typeof payload.csrfToken === "string") {
            setCsrfToken(payload.csrfToken);
          } else {
            setNotice("Secure manager controls are unavailable. Refresh and sign in again.");
          }
        })
        .catch(() => setNotice("Secure manager controls could not be prepared."));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function changeSetting(key: string, change: Change, success: string) {
    setBusy(key);
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(change),
      });
      const payload = await response.json();
      if (!response.ok || !payload.configuration) {
        throw new Error(payload.error ?? "The setting could not be changed.");
      }
      setConfiguration(payload.configuration);
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The setting could not be changed.");
    } finally {
      setBusy("");
    }
  }

  async function changeGuestLink(action: "generate" | "rotate" | "revoke") {
    setBusy(`guest:${action}`);
    setNotice("");
    setNewGuestUrl("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ section: "guestLink", action }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.configuration) {
        throw new Error(payload.error ?? "The guest link could not be changed.");
      }
      setConfiguration(payload.configuration);
      if (typeof payload.guestLinkPath === "string") {
        setNewGuestUrl(new URL(payload.guestLinkPath, window.location.origin).toString());
      }
      setNotice(action === "revoke" ? "Guest link disabled."
        : action === "rotate" ? "Guest link replaced. Copy the new link now."
          : "New guest link generated. Copy it now.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The guest link could not be changed.");
    } finally {
      setBusy("");
    }
  }

  async function copyGuestLink() {
    if (!newGuestUrl) return;
    try {
      await navigator.clipboard.writeText(newGuestUrl);
      setNotice("Guest link copied.");
    } catch {
      setNotice("The link could not be copied automatically. Select and copy it below.");
    }
  }

  function adoptConfiguration(next: BookingAdminConfiguration) {
    setConfiguration(next);
    if (next.automaticCycle) {
      setOpenDate(utcDate(next.automaticCycle.opensAt));
      setOpenTime(utcTime(next.automaticCycle.opensAt));
      setCloseDate(utcDate(next.automaticCycle.closesAt));
      setCloseTime(utcTime(next.automaticCycle.closesAt));
      setCalendarEndpoint("open");
    }
    setConfirmOpenChange(false);
  }

  async function refreshBookingStatus() {
    setBusy("refresh-status");
    setNotice("");
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.configuration) {
        throw new Error(payload.error ?? "Booking status could not be refreshed.");
      }
      adoptConfiguration(payload.configuration);
      setNotice("Booking status refreshed.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Booking status could not be refreshed.");
    } finally {
      setBusy("");
    }
  }

  async function loadMoreActivity() {
    if (!configuration.activityNextCursor) return;
    setBusy("activity");
    setNotice("");
    try {
      const response = await fetch(`${endpoint}?activityCursor=${encodeURIComponent(
        configuration.activityNextCursor,
      )}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.activity)) {
        throw new Error(payload.error ?? "Older activity could not be loaded.");
      }
      setConfiguration((current) => {
        const existingIds = new Set(current.activity.map((activity) => activity.id));
        const additional = (payload.activity as Activity[]).filter(
          (activity) => !existingIds.has(activity.id),
        );
        return { ...current, activity: [...current.activity, ...additional],
          activityNextCursor: payload.activityNextCursor ?? null };
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Older activity could not be loaded.");
    } finally {
      setBusy("");
    }
  }

  async function changeCycleSchedule(action: "override" | "restore") {
    const cycle = configuration.automaticCycle;
    if (!cycle) return;
    setBusy(`cycle:${action}`);
    setNotice("");
    try {
      const body = action === "restore"
        ? { section: "cycleSchedule", action, cycleIndex: cycle.cycleIndex,
            confirmedOpenChange: confirmOpenChange }
        : { section: "cycleSchedule", action, cycleIndex: cycle.cycleIndex,
            opensAt: `${openDate}T${openTime}:00.000Z`,
            closesAt: `${closeDate}T${closeTime}:00.000Z`,
            confirmedOpenChange: confirmOpenChange };
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok || !payload.configuration) {
        throw new Error(payload.error ?? "The booking window could not be changed.");
      }
      adoptConfiguration(payload.configuration);
      setNotice(action === "restore" ? "Default booking times restored for this cycle."
        : "Booking window times saved for this cycle.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The booking window could not be changed.");
    } finally {
      setBusy("");
    }
  }

  async function unlinkGuild(guildId: string) {
    setBusy(`guild:${guildId}`);
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ section: "discordAccess", action: "unlink", guildId, confirmed: true }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.configuration) {
        throw new Error(payload.error ?? "The alliance Discord could not be unlinked.");
      }
      adoptConfiguration(payload.configuration);
      setConfirmedGuildId("");
      setNotice("Alliance Discord removed. Members who relied on it must use another connected Discord.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The alliance Discord could not be unlinked.");
    } finally {
      setBusy("");
    }
  }

  async function decideGuildLinkRequest(requestId: string, action: "approve" | "reject") {
    setBusy(`guild-request:${requestId}`);
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ section: "guildLinkRequest", action, requestId, confirmed: true }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.configuration) {
        throw new Error(payload.error ?? "The alliance Discord request could not be decided.");
      }
      adoptConfiguration(payload.configuration);
      setNotice(action === "approve" ? "Alliance Discord approved and linked."
        : "Alliance Discord request rejected.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The alliance Discord request could not be decided.");
    } finally {
      setBusy("");
    }
  }

  const controlsDisabled = !csrfToken;
  const cycle = configuration.automaticCycle;
  const firstAllowed = cycle ? Date.parse(cycle.automaticOpensAt) - 7 * 86_400_000 : 0;
  const lastAllowed = cycle ? Date.parse(cycle.automaticOpensAt) + 14 * 86_400_000 : 0;
  const proposedOpen = Date.parse(`${openDate}T${openTime}:00.000Z`);
  const proposedClose = Date.parse(`${closeDate}T${closeTime}:00.000Z`);
  const validRange = Boolean(cycle) && Number.isFinite(proposedOpen) && Number.isFinite(proposedClose)
    && proposedOpen >= firstAllowed && proposedOpen < proposedClose
    && proposedClose <= lastAllowed;
  const calendarDays = cycle ? bookingCalendarDays(cycle.automaticOpensAt) : [];
  function selectCalendarDate(date: string) {
    if (calendarEndpoint === "open") {
      setOpenDate(date);
      setCalendarEndpoint("close");
    } else {
      setCloseDate(date);
      setCalendarEndpoint("open");
    }
  }
  return <article className="booking-admin">
    <CommunityPageChrome communityCode={configuration.community.code} current="admin"
      displayName={configuration.community.displayName} profile={configuration.profile} showAdmin />
    {notice ? <p aria-live="polite" className="booking-notice" role="status">{notice}</p> : null}

    {configuration.profile === "kingshot" ? <section className="booking-admin-section" aria-labelledby="booking-admin-booking">
      <div><h2 id="booking-admin-booking">Member bookings</h2>
        <p>Turn normal player bookings on or off for this {noun}.</p>
        <p role="status"><strong>Player bookings: {configuration.bookingWindowState.status.toUpperCase()}</strong>
          {configuration.bookingWindowState.reason === "paused" ? " — access paused"
            : configuration.bookingWindowState.reason === "open" ? " — persisted window open"
              : " — persisted window closed"}</p></div>
      <div className="booking-admin-setting">
        <div><strong>Booking enabled</strong>
          <span>Players can book only while this is enabled and the booking window is open.</span></div>
        <SettingSwitch checked={configuration.community.bookingsEnabled}
          disabled={controlsDisabled || busy === "booking"} label="Member booking"
          onChange={() => void changeSetting("booking", {
            section: "booking", enabled: !configuration.community.bookingsEnabled,
          }, `Member booking ${configuration.community.bookingsEnabled ? "disabled" : "enabled"}.`)} />
      </div>
    </section> : null}

    <section className="booking-admin-section" aria-labelledby="booking-admin-guest-link">
      <div><h2 id="booking-admin-guest-link">Guest booking link</h2>
        <p>Create a link for players who cannot use the normal Discord login.</p></div>
      <div className="booking-admin-setting">
        <div><strong>Guest booking approval</strong>
          <span>Require approval for unregistered guest players. Registered Player IDs are always confirmed immediately.</span></div>
        <SettingSwitch checked={configuration.guestApproval.requireUnregistered}
          disabled={controlsDisabled || busy === "guestApproval"}
          label="Require approval for unregistered guest players"
          onChange={() => void changeSetting("guestApproval", {
            section: "guestApproval", enabled: !configuration.guestApproval.requireUnregistered,
          }, `Approval for unregistered guest players ${configuration.guestApproval.requireUnregistered ? "disabled" : "enabled"}.`)} />
      </div>
      <div className="booking-admin-guest-link">
        <p><strong>Status:</strong> {configuration.guestLink.status === "active" ? "Link active"
          : "No active link"}</p>
        <p className="booking-admin-guest-explanation">For security, the current link cannot be shown again.
          Generate a new link if you need another copy.</p>
        <div className="booking-admin-actions">
          {configuration.guestLink.status === "active"
            ? <>
              <button disabled={controlsDisabled || Boolean(busy)} onClick={() => void changeGuestLink("rotate")}
                type="button">Replace link</button>
              <button disabled={controlsDisabled || Boolean(busy)} onClick={() => void changeGuestLink("revoke")}
                type="button">Disable link</button>
            </>
            : <button disabled={controlsDisabled || Boolean(busy)} onClick={() => void changeGuestLink("generate")}
              type="button">Generate new link</button>}
          <button disabled={!newGuestUrl || Boolean(busy)} onClick={() => void copyGuestLink()} type="button">Copy</button>
        </div>
        {newGuestUrl ? <label className="booking-admin-new-link">New link — shown for this page only
          <input onFocus={(event) => event.currentTarget.select()} readOnly value={newGuestUrl} />
        </label> : null}
      </div>
    </section>

    <section className="booking-admin-section" aria-labelledby="booking-admin-services">
      <div><h2 id="booking-admin-services">Appointment types</h2>
        <p>Turn individual appointment types on or off.</p></div>
      <div className="booking-admin-settings-list">
        {configuration.services.map((service) => <div className="booking-admin-setting" key={service.code}>
          <div><strong>{serviceDisplayName(service)}</strong></div>
          <SettingSwitch checked={service.enabled} disabled={controlsDisabled || busy === `service:${service.code}`}
            label={`${serviceDisplayName(service)} appointment type`} onChange={() => void changeSetting(
              `service:${service.code}`,
              { section: "service", serviceCode: service.code, enabled: !service.enabled },
              `${serviceDisplayName(service)} ${service.enabled ? "disabled" : "enabled"}.`,
            )} />
        </div>)}
      </div>
    </section>

    {configuration.automaticCycle ? <section className="booking-admin-section booking-admin-booking-window"
      aria-labelledby="booking-admin-automatic-cycle">
      <div className="booking-window-heading">
        <h2 id="booking-admin-automatic-cycle">Booking window</h2>
        <div className="booking-window-heading__status">
          <strong className={`booking-window-status booking-window-status--${configuration.bookingWindowState.status}`}
            role="status">{configuration.bookingWindowState.status.toUpperCase()}</strong>
          <button disabled={Boolean(busy)} onClick={() => void refreshBookingStatus()}
            type="button">Refresh</button>
        </div>
      </div>
      {configuration.bookingWindowState.reason === "paused"
        ? <p className="booking-window-reason">State-wide player booking access is paused.</p>
        : configuration.bookingWindowState.reason === "window_not_open"
          && configuration.automaticCycle.status === "open"
          ? <p className="booking-window-reason">Waiting for the booking window to activate.</p>
          : null}
      <div className="booking-admin-setting booking-admin-setting--compact">
        <div><strong>Player booking access</strong>
          <span>Pausing blocks booking actions until resumed. Resuming still follows the window dates.</span></div>
        <SettingSwitch checked={configuration.community.bookingsEnabled}
          disabled={controlsDisabled || Boolean(busy)} label="Player booking access"
          onChange={() => void changeSetting("booking", {
            section: "booking", enabled: !configuration.community.bookingsEnabled,
          }, `Player booking access ${configuration.community.bookingsEnabled ? "paused" : "resumed"}.`)} />
      </div>
      <div className="booking-window-cycle">
        <p><strong>Cycle #{configuration.automaticCycle.cycleIndex}</strong> · {displayCycleRange(
          configuration.automaticCycle.automaticOpensAt,
          configuration.automaticCycle.appointments.map((appointment) => appointment.date).sort().at(-1)
            ?? configuration.automaticCycle.automaticClosesAt.slice(0, 10),
        )}{configuration.automaticCycle.overridden ? <span className="booking-window-override">Cycle override</span> : null}</p>
        <p>Default: Wed 00:00 UTC → Sun 12:00 UTC</p>
      </div>
      <div className="booking-window-range" aria-label={`Booking range for cycle ${configuration.automaticCycle.cycleIndex}`}>
        <div className="booking-window-range__calendar" role="group" aria-label="Choose opening and closing dates in UTC">
          <p>{displayDate(new Date(firstAllowed).toISOString().slice(0, 10))} – {displayDate(new Date(lastAllowed).toISOString().slice(0, 10))}</p>
          <p>Select {calendarEndpoint === "open" ? "OPEN" : "CLOSE"} date</p>
          <div className="booking-window-range__grid">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) =>
              <strong aria-hidden="true" key={day}>{day}</strong>)}
            {calendarDays.map(({ date, enabled }) => {
              const day = bookingCalendarDay(date, openDate, closeDate,
                configuration.automaticCycle!.appointments);
              return <button aria-label={`${displayDate(date)}${day.isOpen ? ", OPEN" : ""}${day.isClose ? ", CLOSE" : ""}${day.events.length ? `, ${day.events.map((event) => event.label).join(", ")}` : ""}`}
                aria-pressed={day.isOpen || day.isClose}
                className={`${day.isOpen ? "is-open " : ""}${day.isClose ? "is-close " : ""}${day.inRange ? "is-in-range" : ""}`}
                disabled={!enabled || Boolean(busy)} key={date}
                onClick={() => selectCalendarDate(date)} type="button">
                <span className="booking-window-range__day-number">{Number(date.slice(8, 10))}</span>
                {date.slice(8, 10) === "01"
                  ? <small className="booking-window-range__month">{new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" })
                    .format(new Date(`${date}T00:00:00.000Z`))}</small> : null}
                {day.events.length ? <span className="booking-window-range__events" aria-hidden="true">
                  {day.events.map((event) => <small key={event.serviceCode} title={event.label}>
                    <BookingEventIcon icon={event.icon} /></small>)}
                </span> : null}
                {day.isOpen || day.isClose ? <span className="booking-window-range__endpoint">
                  {day.isOpen ? <small>OPEN</small> : null}{day.isClose ? <small>CLOSE</small> : null}
                </span> : null}
              </button>;
            })}
          </div>
        </div>
        <div className="booking-window-range__endpoints">
          <div className={calendarEndpoint === "open" ? "is-selecting" : ""}>
            <button aria-pressed={calendarEndpoint === "open"} onClick={() => setCalendarEndpoint("open")}
              type="button">OPEN</button>
            <label>Opening date (UTC)
              <input max={new Date(lastAllowed).toISOString().slice(0, 10)}
                min={new Date(firstAllowed).toISOString().slice(0, 10)}
                onChange={(event) => setOpenDate(event.currentTarget.value)} type="date" value={openDate} />
            </label>
            <label>Opening time (UTC)
              <input onChange={(event) => setOpenTime(event.currentTarget.value)} type="time" value={openTime} />
            </label>
          </div>
          <div className={calendarEndpoint === "close" ? "is-selecting" : ""}>
            <button aria-pressed={calendarEndpoint === "close"} onClick={() => setCalendarEndpoint("close")}
              type="button">CLOSE</button>
            <label>Closing date (UTC)
              <input max={new Date(lastAllowed).toISOString().slice(0, 10)}
                min={new Date(firstAllowed).toISOString().slice(0, 10)}
                onChange={(event) => setCloseDate(event.currentTarget.value)} type="date" value={closeDate} />
            </label>
            <label>Closing time (UTC)
              <input onChange={(event) => setCloseTime(event.currentTarget.value)} type="time" value={closeTime} />
            </label>
          </div>
        </div>
        {!validRange ? <p role="alert">Choose an opening before closing within this cycle&apos;s allowed range.</p> : null}
        {configuration.automaticCycle.status === "open" ? <label className="booking-window-confirmation">
          <input checked={confirmOpenChange} type="checkbox"
            onChange={(event) => setConfirmOpenChange(event.currentTarget.checked)} />
          I understand this changes an already-open booking cycle.
        </label> : null}
        <div className="booking-admin-actions">
          <button disabled={controlsDisabled || Boolean(busy) || !validRange
              || (configuration.automaticCycle.status === "open" && !confirmOpenChange)}
            onClick={() => void changeCycleSchedule("override")} type="button">Save booking window</button>
          <button disabled={controlsDisabled || Boolean(busy) || !configuration.automaticCycle.overridden
              || (configuration.automaticCycle.status === "open" && !confirmOpenChange)}
            onClick={() => void changeCycleSchedule("restore")} type="button">Use default window</button>
        </div>
      </div>
    </section> : null}

    <section className="booking-admin-section" aria-labelledby="booking-admin-discord-access">
      <div><h2 id="booking-admin-discord-access">Discord access</h2>
        <p>Manage which alliance Discords are connected to this {noun}. Only the {noun} Discord owner
          or the owner of an alliance Discord can remove an alliance.</p></div>
      {configuration.discordAccess.guilds.length ? <div className="booking-admin-settings-list">
        {configuration.discordAccess.guilds.map((guild) => <div className="booking-admin-setting" key={guild.id}>
          <div><strong>{guild.displayName}</strong>
            <span>Removing this alliance disconnects members who get website access through its Discord.
              Access through other alliance Discords is not affected.</span>
            {guild.canUnlink ? <label>
              <input checked={confirmedGuildId === guild.id} type="checkbox"
                onChange={(event) => setConfirmedGuildId(event.currentTarget.checked ? guild.id : "")} />
              I understand that members may lose website access.
            </label> : <span>The Discord owner must remove this alliance.</span>}
          </div>
          <button disabled={controlsDisabled || Boolean(busy) || !guild.canUnlink
              || confirmedGuildId !== guild.id}
            onClick={() => void unlinkGuild(guild.id)} type="button">Unlink alliance</button>
        </div>)}
      </div> : <p>No alliance Discords are currently connected.</p>}
      {configuration.discordAccess.pendingRequests.length ? <div>
        <p><strong>Requests to join this {noun}</strong></p>
        <div className="booking-admin-settings-list">
          {configuration.discordAccess.pendingRequests.map((request) =>
            <div className="booking-admin-setting" key={request.id}>
              <div><strong>{request.kind === "state"
                ? `${request.guildName} wants to become the shared ${noun} Discord for ${noun} ${configuration.community.code}.`
                : `${request.alliance} alliance wants to connect ${request.guildName} to ${noun} ${configuration.community.code}.`}</strong>
                <span>Requested type: {request.kind === "state" ? `${noun} Discord` : "Alliance Discord"}.</span>
                <span>Requested by Discord user {request.requestedByDiscordUserId} on {displayUtcInstant(request.requestedAt)}.</span>
                <span>{request.kind === "state"
                  ? `Approval links only this server as the shared ${noun} Discord.`
                  : "Approval links only this server as an alliance Discord."}</span>
                {!request.canDecide ? <span>Only an eligible Discord owner can decide this request.</span> : null}
              </div>
              <div className="booking-admin-actions">
                <button disabled={controlsDisabled || Boolean(busy) || !request.canDecide}
                  onClick={() => void decideGuildLinkRequest(request.id, "approve")} type="button">Approve</button>
                <button disabled={controlsDisabled || Boolean(busy) || !request.canDecide}
                  onClick={() => void decideGuildLinkRequest(request.id, "reject")} type="button">Reject</button>
              </div>
            </div>)}
        </div>
      </div> : null}
      {configuration.discordAccess.unclassifiedGuilds.length ? <div>
        <p><strong>Discord type not set</strong></p>
        <ul>{configuration.discordAccess.unclassifiedGuilds.map((guild) => <li key={guild.id}>
          {guild.displayName} has not yet been marked as either the {noun} Discord or an alliance Discord.
          Its connection will continue to work, but ownership controls are unavailable until its type is set.
        </li>)}</ul>
      </div> : null}
      <p>The shared {noun} Discord cannot be unlinked here.</p>
    </section>

    <section className="booking-admin-section" aria-labelledby="booking-admin-requirements">
      <div><h2 id="booking-admin-requirements">Booking requirements</h2>
        <p>Choose what information players must provide when booking each appointment type.</p></div>
      <div className="booking-admin-requirement-groups">
        {configuration.services.map((service) => <section key={service.code}>
          <h3>{serviceDisplayName(service)}</h3>
          {service.requirements.map((requirement) => <div className="booking-admin-setting"
            key={`${service.code}:${requirement.code}`}>
            <div><strong>{requirement.label}</strong></div>
            <SettingSwitch checked={requirement.enabled}
              disabled={controlsDisabled || busy === `requirement:${service.code}:${requirement.code}`}
              label={`${serviceDisplayName(service)} ${requirement.label} requirement`}
              onChange={() => void changeSetting(
                `requirement:${service.code}:${requirement.code}`,
                { section: "requirement", serviceCode: service.code,
                  requirementCode: requirement.code, enabled: !requirement.enabled },
                `${serviceDisplayName(service)} ${requirement.label} ${requirement.enabled ? "no longer required" : "now required"}.`,
              )} />
          </div>)}
        </section>)}
      </div>
    </section>

    <section className="booking-admin-section" aria-labelledby="booking-admin-dates">
      <div><h2 id="booking-admin-dates">Upcoming appointment dates</h2>
        <p>These dates are created automatically from the booking schedule. They can remain visible after player bookings close.</p></div>
      {configuration.dates.length
        ? <ul className="booking-admin-dates">{configuration.dates.map((date) => <li
          key={`${date.date}:${date.serviceCode}:${date.windowStatus}`}>
          <time dateTime={date.date}>{displayDate(date.date)}</time>
          <span>{serviceDisplayName({ code: date.serviceCode, displayName: date.serviceName })}</span>
        </li>)}</ul>
        : <p>No service dates are currently configured.</p>}
    </section>

    <section className="booking-admin-section booking-admin-activity" aria-labelledby="booking-admin-activity">
      <div><h2 id="booking-admin-activity">Recent activity</h2>
        <p>The latest booking and configuration changes for this {noun}.</p></div>
      {configuration.activity.length === 0
        ? <p>No recent booking activity yet.</p>
        : <div className="booking-admin-activity-viewport" role="region" tabIndex={0}>
          <div className="manager-table-scroll booking-admin-activity-table">
            <table className="manager-table">
              <thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Player</th><th>Details</th></tr></thead>
              <tbody>{configuration.activity.map((activity) => <tr key={activity.id}>
                <td><time dateTime={activity.createdAt}>{displayUtcInstant(activity.createdAt)}</time></td>
                <td><ActivityActor activity={activity} /></td>
                <td>{activityActionLabel(activity)}</td>
                <td>{activity.playerName ?? "—"}
                  {activity.playerId ? <small className="manager-audit-id">
                    Player ID: {activity.playerId}</small> : null}</td>
                <td>{activityDetails(activity)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <ol className="booking-admin-activity-cards">
            {configuration.activity.map((activity) => <li key={activity.id}>
              <dl>
                <div><dt>Time</dt><dd><time dateTime={activity.createdAt}>
                  {displayUtcInstant(activity.createdAt)}</time></dd></div>
                <div><dt>Who</dt><dd><ActivityActor activity={activity} /></dd></div>
                <div><dt>Action</dt><dd>{activityActionLabel(activity)}</dd></div>
                <div><dt>Player</dt><dd>{activity.playerName ?? "—"}
                  {activity.playerId ? <small className="manager-audit-id">
                    Player ID: {activity.playerId}</small> : null}</dd></div>
                <div><dt>Details</dt><dd>{activityDetails(activity)}</dd></div>
              </dl>
            </li>)}
          </ol>
          {configuration.activityNextCursor ? <div className="booking-admin-activity-more">
            <button disabled={busy === "activity"} onClick={() => void loadMoreActivity()} type="button">
              {busy === "activity" ? "Loading…" : "Load more"}
            </button>
          </div> : null}
        </div>}
    </section>
  </article>;
}
