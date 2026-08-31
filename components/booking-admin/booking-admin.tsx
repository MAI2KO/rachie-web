"use client";

import { useEffect, useState } from "react";

import { CommunityPageChrome } from "@/components/community-section-navigation";

type Requirement = { readonly code: string; readonly label: string; readonly enabled: boolean };
type Service = {
  readonly code: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly requirements: readonly Requirement[];
};
type Activity = {
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
  readonly defaultWindow: {
    readonly openMinuteUtc: number;
    readonly closeOffsetMinutes: number;
    readonly source: "community" | "system";
  } | null;
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
};

type Change =
  | { readonly section: "booking"; readonly enabled: boolean }
  | { readonly section: "service"; readonly serviceCode: string; readonly enabled: boolean }
  | {
      readonly section: "requirement";
      readonly serviceCode: string;
      readonly requirementCode: string;
      readonly enabled: boolean;
    };

function statusLabel(status: string) {
  return status ? `${status[0].toUpperCase()}${status.slice(1)}` : "Unavailable";
}

function cycleStatusLabel(status: "draft" | "open" | "closed") {
  if (status === "draft") return "Upcoming";
  if (status === "open") return "Open now";
  return "Closed";
}

function serviceDisplayName(service: { readonly code: string; readonly displayName: string }) {
  return service.code === "troop" ? "Troop Training" : service.displayName;
}

function displayDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function displayUtcInstant(instant: string) {
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZone: "UTC",
  }).format(new Date(instant))} UTC`;
}

function utcInputValue(instant: string) {
  return new Date(instant).toISOString().slice(0, 16);
}

function minuteOfDayValue(minutes: number) {
  const normalized = Math.max(0, Math.min(1439, minutes));
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function parseMinuteOfDay(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours * 60) + minutes;
}

const CLOSE_DAY_LABELS = Object.freeze([
  "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday",
  "Wednesday (+1 week)", "Thursday (+1 week)", "Friday (+1 week)",
  "Saturday (+1 week)", "Sunday (+1 week)", "Monday (+1 week)", "Tuesday (+1 week)",
  "Wednesday (+2 weeks)",
]);

function activityActionLabel(activity: Activity) {
  if (activity.action === "booking_created") return "Booked appointment";
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
  if (activity.action === "submitted") return "Guest player";
  if (activity.action === "expired") return "System";
  if (activity.action === "booking_created") return "Player";
  return activity.actorDiscordUserId ? "Discord member" : "System";
}

function readableSetting(value: string | null) {
  if (!value) return "Booking settings";
  if (value === "booking") return "Member bookings";
  if (value === "service") return "Appointment type";
  if (value === "requirement") return "Booking requirement";
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function activityDetails(activity: Activity) {
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
  const [cycleOpensAt, setCycleOpensAt] = useState(
    initialConfiguration.automaticCycle ? utcInputValue(initialConfiguration.automaticCycle.opensAt) : "",
  );
  const [cycleClosesAt, setCycleClosesAt] = useState(
    initialConfiguration.automaticCycle ? utcInputValue(initialConfiguration.automaticCycle.closesAt) : "",
  );
  const [confirmOpenChange, setConfirmOpenChange] = useState(false);
  const [defaultOpenTime, setDefaultOpenTime] = useState(
    initialConfiguration.defaultWindow
      ? minuteOfDayValue(initialConfiguration.defaultWindow.openMinuteUtc) : "00:00",
  );
  const [defaultCloseDay, setDefaultCloseDay] = useState(
    initialConfiguration.defaultWindow
      ? String(Math.floor(initialConfiguration.defaultWindow.closeOffsetMinutes / 1440)) : "4",
  );
  const [defaultCloseTime, setDefaultCloseTime] = useState(
    initialConfiguration.defaultWindow
      ? minuteOfDayValue(initialConfiguration.defaultWindow.closeOffsetMinutes % 1440) : "12:00",
  );
  const [confirmedGuildId, setConfirmedGuildId] = useState("");
  const [activityFilter, setActivityFilter] = useState<Activity["category"] | "all">("all");
  const noun = configuration.profile === "kingshot" ? "Kingdom" : "State";
  const endpoint = `/api/v1/booking-admin/${encodeURIComponent(configuration.community.code)}`;
  const visibleActivity = configuration.activity.filter(
    (activity) => activityFilter === "all" || activity.category === activityFilter,
  );

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
      setCycleOpensAt(utcInputValue(next.automaticCycle.opensAt));
      setCycleClosesAt(utcInputValue(next.automaticCycle.closesAt));
    }
    if (next.defaultWindow) {
      setDefaultOpenTime(minuteOfDayValue(next.defaultWindow.openMinuteUtc));
      setDefaultCloseDay(String(Math.floor(next.defaultWindow.closeOffsetMinutes / 1440)));
      setDefaultCloseTime(minuteOfDayValue(next.defaultWindow.closeOffsetMinutes % 1440));
    }
    setConfirmOpenChange(false);
  }

  async function saveDefaultWindow() {
    if (!configuration.defaultWindow) return;
    setBusy("default-window");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ section: "recurringWindowDefault",
          openMinuteUtc: parseMinuteOfDay(defaultOpenTime),
          closeOffsetMinutes: (Number(defaultCloseDay) * 1440)
            + parseMinuteOfDay(defaultCloseTime) }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.configuration) {
        throw new Error(payload.error ?? "The default booking window could not be changed.");
      }
      adoptConfiguration(payload.configuration);
      setNotice("Default booking window saved for future cycles.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message
        : "The default booking window could not be changed.");
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
            opensAt: `${cycleOpensAt}:00.000Z`, closesAt: `${cycleClosesAt}:00.000Z`,
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
  return <article className="booking-admin">
    <CommunityPageChrome communityCode={configuration.community.code} current="admin"
      displayName={configuration.community.displayName} profile={configuration.profile} showAdmin />
    {notice ? <p aria-live="polite" className="booking-notice" role="status">{notice}</p> : null}

    <section className="booking-admin-section" aria-labelledby="booking-admin-booking">
      <div><h2 id="booking-admin-booking">Member bookings</h2>
        <p>Turn normal player bookings on or off for this {noun}.</p></div>
      <div className="booking-admin-setting">
        <div><strong>Booking enabled</strong>
          <span>Players can book only while this is enabled and the booking window is open.</span></div>
        <SettingSwitch checked={configuration.community.bookingsEnabled}
          disabled={controlsDisabled || busy === "booking"} label="Member booking"
          onChange={() => void changeSetting("booking", {
            section: "booking", enabled: !configuration.community.bookingsEnabled,
          }, `Member booking ${configuration.community.bookingsEnabled ? "disabled" : "enabled"}.`)} />
      </div>
    </section>

    <section className="booking-admin-section" aria-labelledby="booking-admin-guest-link">
      <div><h2 id="booking-admin-guest-link">Guest booking link</h2>
        <p>Create a link for players who cannot use the normal Discord login. Guest bookings still require manager approval.</p></div>
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

    {configuration.automaticCycle ? <section className="booking-admin-section"
      aria-labelledby="booking-admin-automatic-cycle">
      <div><h2 id="booking-admin-automatic-cycle">Booking window</h2>
        <p>Choose when players can sign up for each appointment cycle. Times are shown in UTC.
          The {noun}&apos;s main booking switch above can still close bookings at any time.</p></div>
      {configuration.defaultWindow ? <div className="booking-admin-settings-list">
        <div><h3>Default booking window</h3>
          <p>This repeats automatically every 28 days. Closing can be no more than 14 days after opening.</p></div>
        <label>Opens Wednesday
          <input type="time" value={defaultOpenTime}
            onChange={(event) => setDefaultOpenTime(event.currentTarget.value)} />
          <span>UTC</span>
        </label>
        <label>Closes
          <select value={defaultCloseDay}
            onChange={(event) => setDefaultCloseDay(event.currentTarget.value)}>
            {CLOSE_DAY_LABELS.map((label, offset) => <option key={label} value={offset}>{label}</option>)}
          </select>
        </label>
        <label>Closing time
          <input type="time" value={defaultCloseTime}
            onChange={(event) => setDefaultCloseTime(event.currentTarget.value)} />
          <span>UTC</span>
        </label>
        <div className="booking-admin-actions">
          <button disabled={controlsDisabled || Boolean(busy)}
            onClick={() => void saveDefaultWindow()} type="button">Save default window</button>
        </div>
      </div> : null}
      <div><h3>Current booking window</h3>
        <p>{configuration.automaticCycle.overridden
          ? "Using an explicit override for this cycle."
          : configuration.defaultWindow?.source === "community"
            ? `Using this ${noun}'s default window.` : "Using the platform default window."}</p></div>
      <dl className="booking-admin-cycle-summary">
        <div><dt>Cycle</dt><dd>{cycleStatusLabel(configuration.automaticCycle.status)}</dd></div>
        <div><dt>Default opening</dt><dd>{displayUtcInstant(configuration.automaticCycle.automaticOpensAt)}</dd></div>
        <div><dt>Default closing</dt><dd>{displayUtcInstant(configuration.automaticCycle.automaticClosesAt)}</dd></div>
        <div><dt>Opens</dt><dd><time dateTime={configuration.automaticCycle.opensAt}>
          {displayUtcInstant(configuration.automaticCycle.opensAt)}</time></dd></div>
        <div><dt>Closes</dt><dd><time dateTime={configuration.automaticCycle.closesAt}>
          {displayUtcInstant(configuration.automaticCycle.closesAt)}</time></dd></div>
      </dl>
      <div className="booking-admin-settings-list">
        <div><h3>Override this cycle</h3>
          <p>These dates affect only the cycle shown above and take priority over the recurring default.</p></div>
        <label>Open (UTC)
          <input type="datetime-local" value={cycleOpensAt}
            onChange={(event) => setCycleOpensAt(event.currentTarget.value)} />
        </label>
        <label>Close (UTC)
          <input type="datetime-local" value={cycleClosesAt}
            onChange={(event) => setCycleClosesAt(event.currentTarget.value)} />
        </label>
        {configuration.automaticCycle.status === "open" ? <label>
          <input checked={confirmOpenChange} type="checkbox"
            onChange={(event) => setConfirmOpenChange(event.currentTarget.checked)} />
          I understand this changes an already-open booking cycle.
        </label> : null}
        <div className="booking-admin-actions">
          <button disabled={controlsDisabled || Boolean(busy)}
            onClick={() => void changeCycleSchedule("override")} type="button">Save times</button>
          <button disabled={controlsDisabled || Boolean(busy) || !configuration.automaticCycle.overridden}
            onClick={() => void changeCycleSchedule("restore")} type="button">Use default times</button>
        </div>
      </div>
      <ul className="booking-admin-cycle-appointments">
        {configuration.automaticCycle.appointments.map((appointment) => <li key={appointment.serviceCode}>
          <strong>{serviceDisplayName({ code: appointment.serviceCode,
            displayName: appointment.serviceName })}</strong>
          <time dateTime={appointment.date}>{displayDate(appointment.date)}</time>
        </li>)}
      </ul>
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
        <p>These dates are created automatically from the booking schedule.</p></div>
      <div className="booking-admin-window-status">
        {configuration.windows.length
          ? configuration.windows.map((window, index) => <p key={`${window.status}:${window.opensAt}:${index}`}>
            <strong>Booking window:</strong> {statusLabel(window.status)}
          </p>)
          : <p>No booking window is currently configured.</p>}
      </div>
      {configuration.dates.length
        ? <ul className="booking-admin-dates">{configuration.dates.map((date) => <li
          key={`${date.date}:${date.serviceCode}:${date.windowStatus}`}>
          <time dateTime={date.date}>{displayDate(date.date)}</time>
          <span>{serviceDisplayName({ code: date.serviceCode, displayName: date.serviceName })}</span>
          <strong>{statusLabel(date.windowStatus)}</strong>
        </li>)}</ul>
        : <p>No service dates are currently configured.</p>}
    </section>

    <section className="booking-admin-section booking-admin-activity" aria-labelledby="booking-admin-activity">
      <div><h2 id="booking-admin-activity">Recent activity</h2>
        <p>The latest booking and configuration changes for this {noun}.</p></div>
      <label>Show
        <select onChange={(event) => setActivityFilter(event.currentTarget.value as typeof activityFilter)}
          value={activityFilter}>
          <option value="all">All</option>
          <option value="bookings">Bookings</option>
          <option value="approvals">Approvals</option>
          <option value="cancellations">Cancellations</option>
          <option value="manager_actions">Manager actions</option>
          <option value="configuration">Settings</option>
        </select>
      </label>
      {configuration.activity.length === 0
        ? <p>No recent booking activity yet.</p>
        : visibleActivity.length === 0
          ? <p>No recent activity matches this filter.</p>
          : <div className="manager-table-scroll" role="region" tabIndex={0}>
            <table className="manager-table">
              <thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Player</th><th>Details</th></tr></thead>
              <tbody>{visibleActivity.map((activity, index) => <tr
                key={`${activity.createdAt}:${activity.action}:${index}`}>
                <td><time dateTime={activity.createdAt}>{displayUtcInstant(activity.createdAt)}</time></td>
                <td>{activityActorLabel(activity)}
                  {activity.actorDiscordUserId ? <small className="manager-audit-id">
                    Discord ID: {activity.actorDiscordUserId}</small> : null}</td>
                <td>{activityActionLabel(activity)}</td>
                <td>{activity.playerName ?? "—"}
                  {activity.playerId ? <small className="manager-audit-id">
                    Player ID: {activity.playerId}</small> : null}</td>
                <td>{activityDetails(activity)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
    </section>
  </article>;
}
