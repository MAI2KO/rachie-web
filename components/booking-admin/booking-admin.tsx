"use client";

import { useEffect, useState } from "react";

import { CommunitySectionNavigation } from "@/components/community-section-navigation";

type Requirement = { readonly code: string; readonly label: string; readonly enabled: boolean };
type Service = {
  readonly code: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly requirements: readonly Requirement[];
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
      setNotice(action === "revoke" ? "Guest link revoked."
        : action === "rotate" ? "Guest link rotated. Copy the new link now."
          : "Guest link generated. Copy it now.");
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
    setConfirmOpenChange(false);
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
      setNotice(action === "restore" ? "Automatic schedule restored for this cycle."
        : "Booking window override saved for this cycle.");
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
      const count = Number(payload.unlink?.affectedGrantCount ?? 0);
      setNotice(`Alliance Discord unlinked. ${count} access grant${count === 1 ? "" : "s"} revoked.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The alliance Discord could not be unlinked.");
    } finally {
      setBusy("");
    }
  }

  const controlsDisabled = !csrfToken;
  return <article className="booking-admin">
    <header>
      <p className="booking-kicker">{noun} {configuration.community.code}</p>
      <h1>{configuration.community.displayName} Booking Admin</h1>
      <p>Manage participant booking availability and requirements for this {noun.toLowerCase()}.</p>
    </header>
    <CommunitySectionNavigation communityCode={configuration.community.code} current="admin"
      profile={configuration.profile} showAdmin />
    {notice ? <p aria-live="polite" className="booking-notice" role="status">{notice}</p> : null}

    <section className="booking-admin-section" aria-labelledby="booking-admin-booking">
      <div><h2 id="booking-admin-booking">Booking system</h2>
        <p>Controls whether normal participant bookings are allowed for this community.</p></div>
      <div className="booking-admin-setting">
        <div><strong>Participant booking</strong><span>Independent of dates, windows, and slots.</span></div>
        <SettingSwitch checked={configuration.community.bookingsEnabled}
          disabled={controlsDisabled || busy === "booking"} label="Participant booking"
          onChange={() => void changeSetting("booking", {
            section: "booking", enabled: !configuration.community.bookingsEnabled,
          }, `Participant booking ${configuration.community.bookingsEnabled ? "disabled" : "enabled"}.`)} />
      </div>
    </section>

    <section className="booking-admin-section" aria-labelledby="booking-admin-guest-link">
      <div><h2 id="booking-admin-guest-link">Guest booking link</h2>
        <p>Allows in-game players to request a booking without Discord. Requests still require manager approval.</p></div>
      <div className="booking-admin-guest-link">
        <p><strong>Status:</strong> {configuration.guestLink.status === "active" ? "Active"
          : configuration.guestLink.status === "revoked" ? "Revoked" : "No active link"}</p>
        <p className="booking-admin-guest-explanation">For security, only a hash is stored. An existing link cannot be
          recovered or copied; rotate it to receive a new link.</p>
        <div className="booking-admin-actions">
          {configuration.guestLink.status === "active"
            ? <>
              <button disabled={controlsDisabled || Boolean(busy)} onClick={() => void changeGuestLink("rotate")}
                type="button">Rotate</button>
              <button disabled={controlsDisabled || Boolean(busy)} onClick={() => void changeGuestLink("revoke")}
                type="button">Revoke</button>
            </>
            : <button disabled={controlsDisabled || Boolean(busy)} onClick={() => void changeGuestLink("generate")}
              type="button">Generate</button>}
          <button disabled={!newGuestUrl || Boolean(busy)} onClick={() => void copyGuestLink()} type="button">Copy</button>
        </div>
        {newGuestUrl ? <label className="booking-admin-new-link">New link — shown for this page only
          <input onFocus={(event) => event.currentTarget.select()} readOnly value={newGuestUrl} />
        </label> : null}
      </div>
    </section>

    <section className="booking-admin-section" aria-labelledby="booking-admin-services">
      <div><h2 id="booking-admin-services">Services</h2><p>Disable a service without deleting its dates or slots.</p></div>
      <div className="booking-admin-settings-list">
        {configuration.services.map((service) => <div className="booking-admin-setting" key={service.code}>
          <div><strong>{service.displayName}</strong><span>{service.code}</span></div>
          <SettingSwitch checked={service.enabled} disabled={controlsDisabled || busy === `service:${service.code}`}
            label={`${service.displayName} service`} onChange={() => void changeSetting(
              `service:${service.code}`,
              { section: "service", serviceCode: service.code, enabled: !service.enabled },
              `${service.displayName} ${service.enabled ? "disabled" : "enabled"}.`,
            )} />
        </div>)}
      </div>
    </section>

    {configuration.automaticCycle ? <section className="booking-admin-section"
      aria-labelledby="booking-admin-automatic-cycle">
      <div><h2 id="booking-admin-automatic-cycle">Booking window</h2>
        <p>Automatic 28-day Whiteout Survival schedule. Times below are UTC; the manual booking control above remains independent.</p></div>
      <dl className="booking-admin-cycle-summary">
        <div><dt>Schedule</dt><dd>{statusLabel(configuration.automaticCycle.status)}</dd></div>
        <div><dt>Automatic opening</dt><dd>{displayUtcInstant(configuration.automaticCycle.automaticOpensAt)}</dd></div>
        <div><dt>Automatic closing</dt><dd>{displayUtcInstant(configuration.automaticCycle.automaticClosesAt)}</dd></div>
        <div><dt>Opening</dt><dd><time dateTime={configuration.automaticCycle.opensAt}>
          {displayUtcInstant(configuration.automaticCycle.opensAt)}</time></dd></div>
        <div><dt>Closing</dt><dd><time dateTime={configuration.automaticCycle.closesAt}>
          {displayUtcInstant(configuration.automaticCycle.closesAt)}</time></dd></div>
      </dl>
      <div className="booking-admin-settings-list">
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
            onClick={() => void changeCycleSchedule("override")} type="button">Save override</button>
          <button disabled={controlsDisabled || Boolean(busy) || !configuration.automaticCycle.overridden}
            onClick={() => void changeCycleSchedule("restore")} type="button">Restore automatic schedule</button>
        </div>
      </div>
      <ul className="booking-admin-cycle-appointments">
        {configuration.automaticCycle.appointments.map((appointment) => <li key={appointment.serviceCode}>
          <strong>{appointment.serviceName}</strong>
          <time dateTime={appointment.date}>{displayDate(appointment.date)}</time>
        </li>)}
      </ul>
    </section> : null}

    <section className="booking-admin-section" aria-labelledby="booking-admin-discord-access">
      <div><h2 id="booking-admin-discord-access">Discord access</h2>
        <p>Only the shared {noun} Discord owner or an alliance Discord owner can unlink that alliance.</p></div>
      {configuration.discordAccess.guilds.length ? <div className="booking-admin-settings-list">
        {configuration.discordAccess.guilds.map((guild) => <div className="booking-admin-setting" key={guild.id}>
          <div><strong>{guild.displayName}</strong>
            <span>Unlinking revokes all website access granted through this Discord, even for members of the shared {noun} Discord.</span>
            {guild.canUnlink ? <label>
              <input checked={confirmedGuildId === guild.id} type="checkbox"
                onChange={(event) => setConfirmedGuildId(event.currentTarget.checked ? guild.id : "")} />
              Confirm access revocation for this alliance Discord.
            </label> : <span>Discord ownership is required.</span>}
          </div>
          <button disabled={controlsDisabled || Boolean(busy) || !guild.canUnlink
              || confirmedGuildId !== guild.id}
            onClick={() => void unlinkGuild(guild.id)} type="button">Unlink alliance</button>
        </div>)}
      </div> : <p>No active alliance Discord links are available.</p>}
      {configuration.discordAccess.unclassifiedGuilds.length ? <div>
        <p><strong>Explicit classification required</strong></p>
        <ul>{configuration.discordAccess.unclassifiedGuilds.map((guild) => <li key={guild.id}>
          {guild.displayName} ({guild.id}) — unclassified; it cannot be unlinked as an alliance or used as the shared {noun} Discord.
        </li>)}</ul>
      </div> : null}
      <p>The shared {noun} Discord cannot be unlinked here.</p>
    </section>

    <section className="booking-admin-section" aria-labelledby="booking-admin-requirements">
      <div><h2 id="booking-admin-requirements">Booking requirements</h2>
        <p>These existing per-service fields control the participant and guest booking forms.</p></div>
      <div className="booking-admin-requirement-groups">
        {configuration.services.map((service) => <section key={service.code}>
          <h3>{service.displayName}</h3>
          {service.requirements.map((requirement) => <div className="booking-admin-setting"
            key={`${service.code}:${requirement.code}`}>
            <div><strong>{requirement.label}</strong>
              <span>{requirement.code === "speedups" ? "Speed-ups requirement" : "Resource requirement"}</span></div>
            <SettingSwitch checked={requirement.enabled}
              disabled={controlsDisabled || busy === `requirement:${service.code}:${requirement.code}`}
              label={`${service.displayName} ${requirement.label} requirement`}
              onChange={() => void changeSetting(
                `requirement:${service.code}:${requirement.code}`,
                { section: "requirement", serviceCode: service.code,
                  requirementCode: requirement.code, enabled: !requirement.enabled },
                `${service.displayName} ${requirement.label} requirement ${requirement.enabled ? "disabled" : "enabled"}.`,
              )} />
          </div>)}
        </section>)}
      </div>
    </section>

    <section className="booking-admin-section" aria-labelledby="booking-admin-dates">
      <div><h2 id="booking-admin-dates">Current booking dates and windows</h2>
        <p>Read-only in Booking Admin v1.</p></div>
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
          <span>{date.serviceName}</span><strong>{statusLabel(date.windowStatus)}</strong>
        </li>)}</ul>
        : <p>No service dates are currently configured.</p>}
    </section>
  </article>;
}
