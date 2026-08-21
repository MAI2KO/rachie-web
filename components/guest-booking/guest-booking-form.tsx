"use client";

import { useEffect, useMemo, useState } from "react";

export interface GuestBookingPageModel {
  community: { code: string; displayName: string };
  holdDurationSeconds: number;
  services: Array<{
    code: string; name: string; date: string;
    requirements: Array<{ code: string; label: string; unit?: string }>;
    slots: Array<{ slotId: string; time: string; state: "available" | "unavailable" }>;
  }>;
}

const dateLabel = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

export function GuestBookingLoader({ token, profile }: { token: string; profile: "wos" | "kingshot" }) {
  const [page, setPage] = useState<GuestBookingPageModel | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/v1/guest-booking/${encodeURIComponent(token)}`, {
          cache: "no-store", signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok || !body.page) throw new Error("unavailable");
        setPage(body.page);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setUnavailable(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [token]);

  if (unavailable) return <section className="guest-link-unavailable"><h1>Booking link unavailable</h1><p>This booking link is invalid, expired, or has been revoked. Ask your State or Kingdom administrator for a current link.</p></section>;
  if (!page) return <section className="guest-link-unavailable" aria-live="polite"><h1>Loading booking link…</h1></section>;
  return <GuestBookingForm page={page} profile={profile} token={token} />;
}

export function GuestBookingForm({ token, profile, page }: { token: string; profile: "wos" | "kingshot"; page: GuestBookingPageModel }) {
  const [serviceCode, setServiceCode] = useState(page.services[0]?.code ?? "");
  const [slotId, setSlotId] = useState("");
  const [requirements, setRequirements] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{ service: string; date: string; time: string } | null>(null);
  const service = useMemo(() => page.services.find((item) => item.code === serviceCode), [page.services, serviceCode]);
  const term = profile === "kingshot" ? "Kingdom" : "State";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/v1/guest-booking/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          inGameName: form.get("inGameName"), playerId: form.get("playerId"), alliance: form.get("alliance"),
          serviceCode, slotId, requirements,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Booking request could not be submitted.");
      setSuccess({ service: service?.name ?? body.request.service, date: body.request.date, time: body.request.time });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Booking request could not be submitted."); }
    finally { setSubmitting(false); }
  }

  if (success) return <section className="guest-success">
    <p className="booking-kicker">Booking request submitted</p><h1>Awaiting administrator approval</h1>
    <p>Your slot is being held temporarily while a {term} administrator reviews it.</p>
    <dl><div><dt>{term}</dt><dd>{page.community.code}</dd></div><div><dt>Service</dt><dd>{success.service}</dd></div><div><dt>Date</dt><dd>{dateLabel(success.date)}</dd></div><div><dt>Time</dt><dd>{success.time}</dd></div></dl>
    <p><strong>The request is not confirmed until approved.</strong></p>
  </section>;

  return <article className="guest-booking">
    <header><p className="booking-kicker">{term} {page.community.code}</p><h1>{page.community.displayName}</h1><p>Request an appointment without signing in to Discord.</p></header>
    <form onSubmit={submit}>
      <fieldset><legend>1. Choose a service</legend><div className="guest-service-options">
        {page.services.map((item) => <button aria-pressed={serviceCode === item.code} key={item.code} onClick={() => { setServiceCode(item.code); setSlotId(""); setRequirements({}); }} type="button"><strong>{item.name}</strong><span>{dateLabel(item.date)}</span></button>)}
      </div></fieldset>
      {service ? <fieldset><legend>2. Choose an available time</legend><div className="guest-slot-options">
        {service.slots.map((slot) => <label key={slot.slotId}><input checked={slotId === slot.slotId} disabled={slot.state !== "available"} name="slot" onChange={() => setSlotId(slot.slotId)} type="radio" value={slot.slotId} /><span>{slot.time}<small>{slot.state === "available" ? "Available" : "Pending or booked"}</small></span></label>)}
      </div></fieldset> : null}
      <fieldset className="guest-details"><legend>3. Your player details</legend>
        <label>In-game player name<input maxLength={30} name="inGameName" required /></label>
        <label>Player ID<input inputMode="numeric" maxLength={20} name="playerId" pattern="[0-9]+" required /></label>
        <label>Alliance abbreviation<input autoCapitalize="characters" maxLength={3} minLength={3} name="alliance" required /></label>
        {service?.requirements.map((field) => <label key={field.code}>{field.label}<input inputMode="numeric" min="1" onChange={(event) => setRequirements((values) => ({ ...values, [field.code]: event.target.value }))} pattern="[0-9]+" required type="number" value={requirements[field.code] ?? ""} /></label>)}
      </fieldset>
      {error ? <p className="booking-notice booking-notice--error" role="alert">{error}</p> : null}
      <button className="booking-button" disabled={!slotId || submitting} type="submit">{submitting ? "Submitting…" : "Submit booking request"}</button>
      <p className="booking-note">A temporary hold is created. An administrator must approve your request before it is confirmed.</p>
    </form>
  </article>;
}
