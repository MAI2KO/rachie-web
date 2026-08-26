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
  readonly automaticCycle: {
    readonly status: "draft" | "open" | "closed";
    readonly opensAt: string;
    readonly closesAt: string;
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
      <div><h2 id="booking-admin-automatic-cycle">Automatic booking cycle</h2>
        <p>Fixed 28-day Whiteout Survival schedule. Booking also requires the manager control above.</p></div>
      <dl className="booking-admin-cycle-summary">
        <div><dt>Schedule</dt><dd>{statusLabel(configuration.automaticCycle.status)}</dd></div>
        <div><dt>Opening</dt><dd><time dateTime={configuration.automaticCycle.opensAt}>
          {displayUtcInstant(configuration.automaticCycle.opensAt)}</time></dd></div>
        <div><dt>Closing</dt><dd><time dateTime={configuration.automaticCycle.closesAt}>
          {displayUtcInstant(configuration.automaticCycle.closesAt)}</time></dd></div>
      </dl>
      <ul className="booking-admin-cycle-appointments">
        {configuration.automaticCycle.appointments.map((appointment) => <li key={appointment.serviceCode}>
          <strong>{appointment.serviceName}</strong>
          <time dateTime={appointment.date}>{displayDate(appointment.date)}</time>
        </li>)}
      </ul>
    </section> : null}

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
