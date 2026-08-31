"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActiveBrand } from "@/brands/config";
import { beginRescheduleState, communityPresentation, createInFlightRequestDeduper, createLatestRequestCoordinator, makeAttemptKey, profileTerms, requirementFields, resolveBookingUiState, SERVICE_ORDER, shouldShowLogout, signedOutBookingState, sortSlots, uiError } from "./booking-ui-model.mjs";

type Community = { locationCode: string; displayName: string };
type Session = { authenticated: boolean; gameProfile?: "wos" | "kingshot"; user?: { username: string; globalName: string | null }; communities?: Community[]; selectedCommunity?: Community | null; expiresAt?: string; csrfToken?: string };
type RequirementConfig = Record<string, Record<string, boolean>>;
type Service = { code: string; displayLabel: string; appointmentLabel: string; date: string | null };
type BookingContext = { community: Community; bookingsOpen: boolean; windowState: string; requirements: RequirementConfig | null; services: Service[] };
type Registration = { status: "unregistered" } | { status: "registered"; playerId: string; inGameName: string; alliance: string };
type Booking = { bookingId: string; serviceCode: string; date: string; displayTime: string; ordinal: number };
type Me = { community: Community; registration: Registration; bookings: Booking[] };
type Slot = { slotId: string; displayTime: string; ordinal: number };
type Availability = { service: { code: string; displayLabel: string }; date: string | null; bookingsOpen: boolean; slots: Slot[] };
type ApiError = { code?: string; error?: string; fields?: Record<string, string> };
type BookingConfirmation = { serviceLabel: string; date: string; displayTime: string; playerName: string; alliance: string; requirements: { code: string; label: string; value: number; unit?: string }[] };
const REQUEST_TIMEOUT_MS = 15_000;

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (init?.signal?.aborted) abort();
  else init?.signal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { credentials: "same-origin", ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error ?? "Request failed") as Error & { response: Response; body: ApiError };
      error.response = response; error.body = body; throw error;
    }
    return body as T;
  } catch (caught) {
    if (!timedOut) throw caught;
    const error = new Error("The request took too long. Please try again.") as Error & { body: ApiError };
    error.body = { error: error.message };
    throw error;
  } finally {
    window.clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", abort);
  }
}

function Button({ children, secondary = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return <button className={secondary ? "booking-button booking-button--secondary" : "booking-button"} {...props}>{children}</button>;
}

function appointmentTypeLabel(code: string, label: string) {
  return code === "troop" || label.toLowerCase() === "troop" ? "Troop Training" : label;
}

function RequirementInputs({ fields, values, disabled, onChange }: { fields: { code: string; label: string; helpText?: string }[]; values: Record<string, string>; disabled: boolean; onChange: (code: string, value: string) => void }) {
  if (!fields.length) return <p className="booking-note">No resource details are required for this service.</p>;
  return <fieldset className="requirement-fields" disabled={disabled}><legend>Required resources</legend>{fields.map((field) => { const helpId = field.helpText ? `requirement-${field.code}-help` : undefined; return <label key={field.code}><span>{field.label}</span><input aria-describedby={helpId} inputMode="numeric" min="1" max="999999" name={field.code} pattern="[0-9]+" required step="1" type="number" value={values[field.code] ?? ""} onChange={(event) => onChange(field.code, event.target.value)} />{field.helpText && <small className="requirement-help" id={helpId}>{field.helpText}</small>}</label>; })}</fieldset>;
}

function StatusNotice({ message, kind = "info", noticeRef }: { message: string; kind?: "info" | "error" | "success"; noticeRef?: React.RefObject<HTMLDivElement | null> }) {
  return <div className={`booking-notice booking-notice--${kind}`} ref={noticeRef} role={kind === "error" ? "alert" : "status"} tabIndex={-1}>{message}</div>;
}

export function BookingExperience({ brand }: { brand: ActiveBrand }) {
  const profile = brand.game.profile;
  const terms = profileTerms(profile);
  const [session, setSession] = useState<Session | null>(null);
  const [context, setContext] = useState<BookingContext | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [availabilityFailed, setAvailabilityFailed] = useState(false);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [selectedService, setSelectedService] = useState("construction");
  const [selectedSlot, setSelectedSlot] = useState("");
  const [requirements, setRequirements] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<{ type: "reschedule" | "cancel"; booking: Booking } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [membershipCheckSlow, setMembershipCheckSlow] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [success, setSuccess] = useState("");
  const [confirmation, setConfirmation] = useState<BookingConfirmation | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const attempts = useRef(new Map<string, string>());
  const bootstrapRequests = useRef(createInFlightRequestDeduper());
  const availabilityRequests = useRef(createLatestRequestCoordinator());

  const explainError = useCallback((caught: unknown) => {
    const api = caught as Error & { response?: Response; body?: ApiError };
    const message = api.body?.code
      ? uiError(api.body.code, api.response?.headers.get("retry-after"))
      : api.body?.error ?? "Something went wrong. Please try again.";
    setError(message); setErrorCode(api.body?.code ?? "unknown"); setSuccess(""); setConfirmation(null);
    queueMicrotask(() => errorRef.current?.focus());
    return api.body?.code;
  }, []);

  const loadBookingData = useCallback(async () => {
    try {
      const [nextContext, nextMe] = await Promise.all([jsonRequest<BookingContext>("/api/v1/booking/context"), jsonRequest<Me>("/api/v1/booking/me")]);
      setContext(nextContext); setMe(nextMe);
      if (!nextContext.services.some((service) => service.code === selectedService)) setSelectedService(nextContext.services[0]?.code ?? "construction");
    } catch (caught) { explainError(caught); }
  }, [explainError, selectedService]);

  const loadAvailability = useCallback(async (serviceCode: string) => {
    const task = availabilityRequests.current.run(
      serviceCode,
      (signal: AbortSignal) => jsonRequest<Availability>(`/api/v1/booking/availability?service=${encodeURIComponent(serviceCode)}`, { signal }),
    );
    if (!task.started) {
      await task.promise.catch(() => undefined);
      return;
    }
    setAvailabilityLoading(true); setAvailability(null); setAvailabilityFailed(false);
    try {
      const next = await task.promise;
      if (task.isLatest()) { setAvailability(next); setAvailabilityFailed(false); setError(""); setErrorCode(null); }
    } catch (caught) {
      if (!task.isLatest() || (caught instanceof DOMException && caught.name === "AbortError")) return;
      explainError(caught); setAvailability(null); setAvailabilityFailed(true);
    } finally {
      if (task.isLatest()) setAvailabilityLoading(false);
    }
  }, [explainError]);

  useEffect(() => {
    let active = true;
    const request = bootstrapRequests.current.run("auth-session", () => jsonRequest<Session>("/api/v1/auth/session")) as Promise<Session>;
    void request
      .then((next) => { if (active) setSession(next); })
      .catch((caught) => { if (active) { explainError(caught); setSession({ authenticated: false }); } });
    return () => { active = false; };
  }, [explainError]);
  useEffect(() => {
    if (!session?.authenticated || !session.selectedCommunity) return;
    let active = true;
    const key = `booking:${session.gameProfile ?? profile}:${session.selectedCommunity.locationCode}:${session.expiresAt ?? "session"}`;
    const request = bootstrapRequests.current.run(key, () => Promise.all([jsonRequest<BookingContext>("/api/v1/booking/context"), jsonRequest<Me>("/api/v1/booking/me")])) as Promise<[BookingContext, Me]>;
    void request
      .then(([nextContext, nextMe]) => { if (active) { setContext(nextContext); setMe(nextMe); } })
      .catch((caught) => { if (active) explainError(caught); });
    return () => { active = false; };
  }, [session, profile, explainError]);
  const registrationStatus = me?.registration.status;
  const contextLocationCode = context?.community.locationCode;
  useEffect(() => {
    if (registrationStatus !== "registered" || !contextLocationCode) return;
    void loadAvailability(selectedService);
  }, [registrationStatus, contextLocationCode, selectedService, loadAvailability]);

  const service = context?.services.find((item) => item.code === selectedService) ?? null;
  const fields = useMemo(() => requirementFields(profile, selectedService, context?.requirements), [profile, selectedService, context]);
  const uiState = resolveBookingUiState(session, context, me, errorCode);
  const bookingCommunity = context?.community ?? { locationCode: "", displayName: "" };
  const bookingCommunityPresentation = communityPresentation(profile, bookingCommunity);
  const bookingsOpen = context?.bookingsOpen ?? false;
  const services = context?.services ?? [];
  const currentBookings = me?.bookings ?? [];
  const registration = me?.registration.status === "registered"
    ? me.registration
    : { status: "registered" as const, playerId: "", inGameName: "", alliance: "" };

  async function mutation<T>(attempt: string, url: string, method: string, body?: unknown): Promise<T> {
    let key = attempts.current.get(attempt);
    if (!key) { key = makeAttemptKey(); attempts.current.set(attempt, key); }
    const slowTimer = window.setTimeout(() => setMembershipCheckSlow(true), 600);
    try {
      const result = await jsonRequest<T>(url, { method, headers: { "content-type": "application/json", "idempotency-key": key, "x-csrf-token": session?.csrfToken ?? "" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      attempts.current.delete(attempt); return result;
    } catch (caught) {
      if ((caught as Error & { response?: Response }).response) attempts.current.delete(attempt);
      if ((caught as Error & { body?: ApiError }).body?.code === "community_membership_lost") {
        try {
          const nextSession = await jsonRequest<Session>("/api/v1/auth/session");
          setSession(nextSession); setContext(null); setMe(null); setAvailability(null); setMode(null);
        } catch {
          // Preserve the controlled membership-loss error from the mutation.
        }
      }
      throw caught;
    } finally {
      window.clearTimeout(slowTimer);
      setMembershipCheckSlow(false);
    }
  }

  async function selectCommunity(locationCode: string) {
    setBusy(true); setError("");
    try { setSession(await jsonRequest<Session>("/api/v1/auth/community", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session?.csrfToken ?? "" }, body: JSON.stringify({ locationCode }) })); }
    catch (caught) { explainError(caught); } finally { setBusy(false); }
  }

  async function logout() {
    setLoggingOut(true); setError("");
    try {
      const response = await jsonRequest<Session>("/api/v1/auth/logout", { method: "POST", headers: { "x-csrf-token": session?.csrfToken ?? "" } });
      const signedOut = signedOutBookingState(response);
      setSession(signedOut.session); setContext(signedOut.context); setMe(signedOut.me); setAvailability(signedOut.availability); setAvailabilityFailed(signedOut.availabilityFailed);
      setSelectedService(signedOut.selectedService); setSelectedSlot(signedOut.selectedSlot); setRequirements(signedOut.requirements); setMode(signedOut.mode);
      setError(signedOut.error); setErrorCode(signedOut.errorCode); setSuccess(signedOut.success); setConfirmation(signedOut.confirmation); attempts.current.clear();
      availabilityRequests.current.cancel(); setAvailabilityLoading(false); bootstrapRequests.current.clear();
    } catch (caught) { explainError(caught); } finally { setLoggingOut(false); }
  }

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    try {
      await mutation("registration", "/api/v1/booking/me/registration", "PUT", { playerId: data.get("playerId"), inGameName: data.get("inGameName"), alliance: data.get("alliance") });
      setSuccess("Player registration saved."); await loadBookingData(); queueMicrotask(() => successRef.current?.focus());
    } catch (caught) { explainError(caught); } finally { setBusy(false); }
  }

  async function submitBooking(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selectedSlot) return;
    setBusy(true); setError("");
    const payload = { serviceCode: selectedService, slotId: selectedSlot, requirements: Object.fromEntries(fields.map(({ code }) => [code, requirements[code]])) };
    try {
      const result = await mutation<{ booking: BookingConfirmation }>(`create:${JSON.stringify(payload)}`, "/api/v1/bookings", "POST", payload);
      setConfirmation(result.booking); setSuccess(`${appointmentTypeLabel(selectedService, result.booking.serviceLabel)} booked for ${result.booking.date} at ${result.booking.displayTime}.`); setSelectedSlot(""); setRequirements({}); await Promise.all([loadBookingData(), loadAvailability(selectedService)]); queueMicrotask(() => successRef.current?.focus());
    } catch (caught) { const code = explainError(caught); if (code === "slot_unavailable" || code === "booking_already_exists") await loadAvailability(selectedService); } finally { setBusy(false); }
  }

  async function reschedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!mode || mode.type !== "reschedule" || !selectedSlot) return;
    const payload = { slotId: selectedSlot, requirements: Object.fromEntries(fields.map(({ code }) => [code, requirements[code]])) };
    setBusy(true); setError("");
    try {
      const result = await mutation<{ booking: BookingConfirmation }>(`reschedule:${mode.booking.bookingId}:${JSON.stringify(payload)}`, `/api/v1/bookings/${mode.booking.bookingId}`, "PATCH", payload);
      setConfirmation(result.booking); setSuccess("Appointment rescheduled. Your previous appointment remained active until this change completed."); setMode(null); setSelectedSlot(""); setRequirements({}); await Promise.all([loadBookingData(), loadAvailability(selectedService)]); queueMicrotask(() => successRef.current?.focus());
    } catch (caught) { const code = explainError(caught); if (code === "slot_unavailable") await loadAvailability(selectedService); } finally { setBusy(false); }
  }

  async function cancel() {
    if (!mode || mode.type !== "cancel") return;
    setBusy(true); setError("");
    try {
      await mutation(`cancel:${mode.booking.bookingId}`, `/api/v1/bookings/${mode.booking.bookingId}`, "DELETE");
      setConfirmation(null); setSuccess("Appointment cancelled. The time is available again."); const serviceCode = mode.booking.serviceCode; setMode(null); await Promise.all([loadBookingData(), loadAvailability(serviceCode)]); queueMicrotask(() => successRef.current?.focus());
    } catch (caught) { explainError(caught); } finally { setBusy(false); }
  }

  function chooseService(serviceCode: string) {
    setSelectedService(serviceCode); setSelectedSlot(""); setRequirements({});
    void loadAvailability(serviceCode);
  }

  function beginReschedule(booking: Booking) {
    const next = beginRescheduleState(booking);
    setSelectedService(next.selectedService); setSelectedSlot(next.selectedSlot); setRequirements(next.requirements); setMode({ type: "reschedule", booking });
    setAvailability(next.availability); setAvailabilityFailed(next.availabilityFailed); setError("");
    void loadAvailability(booking.serviceCode);
  }

  if (!session) return <section className="booking-screen" aria-busy="true"><p className="booking-kicker">Booking console</p><h1>Loading your booking access</h1><div className="booking-loading" /></section>;
  return <section className="booking-screen" aria-labelledby="booking-title">
    <header className="booking-heading"><div><p className="booking-kicker">{brand.game.name} appointments</p><h1 id="booking-title">Minister booking</h1></div>{shouldShowLogout(session) && <div className="session-actions"><span className="session-mark">Discord: {session.user?.globalName ?? session.user?.username}</span><Button disabled={loggingOut} onClick={() => void logout()} secondary type="button">{loggingOut ? "Logging out..." : "Log out"}</Button></div>}</header>
    {error && <StatusNotice kind="error" message={error} noticeRef={errorRef} />}
    {membershipCheckSlow && <StatusNotice message="Checking your Discord booking access..." />}
    {success && <StatusNotice kind="success" message={success} noticeRef={successRef} />}
    {confirmation && <section className="booking-confirmation" aria-labelledby="confirmation-title"><div><p className="booking-kicker">Confirmed</p><h2 id="confirmation-title">{appointmentTypeLabel(selectedService, confirmation.serviceLabel)}</h2></div><dl><div><dt>Date</dt><dd>{confirmation.date}</dd></div><div><dt>Time</dt><dd>{confirmation.displayTime}</dd></div><div><dt>Player</dt><dd>{confirmation.playerName}</dd></div><div><dt>Alliance</dt><dd>{confirmation.alliance}</dd></div>{confirmation.requirements.map((answer) => <div key={answer.code}><dt>{answer.label}</dt><dd>{answer.value}{answer.unit ? ` ${answer.unit}` : ""}</dd></div>)}</dl></section>}
    {uiState === "unauthenticated" ? <div className="booking-gate"><p>Sign in with Discord to verify your community and manage your appointments.</p><a className="booking-button" href="/api/v1/auth/login">Sign in with Discord</a></div>
    : uiState === "community-selection" ? <div className="booking-gate"><h2>Choose your {terms.community}</h2><p>Only communities verified through your Discord membership are shown.</p><div className="community-options">{session.communities?.length ? session.communities.map((community) => <Button disabled={busy} key={community.locationCode} onClick={() => void selectCommunity(community.locationCode)} secondary><strong>{community.displayName}</strong><span>{terms.community} {community.locationCode}</span></Button>) : <p>No verified communities are available for this Discord account.</p>}</div></div>
    : uiState === "reauthentication-required" ? <div className="booking-gate"><h2>Refresh Discord access</h2><p>Your membership verification is no longer fresh enough to manage appointments.</p><a className="booking-button" href="/api/v1/auth/login">Sign in again</a></div>
    : uiState === "unavailable" ? <div className="booking-gate"><h2>Booking is temporarily unavailable</h2><Button onClick={() => void loadBookingData()} secondary>Try again</Button></div>
    : uiState === "loading-booking" ? <div className="booking-gate" aria-busy="true"><h2>Preparing your {terms.community}</h2><div className="booking-loading" /></div>
    : uiState === "registration" && context ? <form className="registration-form" onSubmit={register}><div><p className="booking-kicker">{bookingCommunityPresentation.compactLabel}</p><h2>Register your player</h2><p>Your saved identity is copied into each appointment confirmation.</p></div><label>Player ID<input autoComplete="off" inputMode="numeric" name="playerId" pattern="[0-9]+" required /></label><label>In-game name<input autoComplete="nickname" maxLength={30} name="inGameName" required /></label><label>Alliance<input autoCapitalize="characters" maxLength={3} minLength={3} name="alliance" pattern="[A-Za-z0-9]{3}" required /></label><Button disabled={busy} type="submit">{busy ? "Saving..." : "Save registration"}</Button></form>
    : <div className="booking-dashboard">
      <div className="booking-summary"><div><span>{bookingCommunityPresentation.codeLabel}</span><strong>{bookingCommunityPresentation.displayName}</strong></div><div><span>Registered player</span><strong>{registration.inGameName} · {registration.alliance}</strong><small>ID {registration.playerId}</small></div><div><span>Booking window</span><strong>{bookingsOpen ? "Open" : "Closed"}</strong></div></div>
      <section className="current-bookings" aria-labelledby="current-bookings-title"><div className="section-heading"><h2 id="current-bookings-title">Current appointments</h2><span>{currentBookings.length}</span></div>{currentBookings.length ? <div className="booking-card-list">{currentBookings.map((booking) => { const item = services.find((candidate) => candidate.code === booking.serviceCode); return <article className="booking-card" key={booking.bookingId}><div><p>{appointmentTypeLabel(booking.serviceCode, item?.displayLabel ?? booking.serviceCode)}</p><strong>{booking.date}</strong><span>{booking.displayTime}</span></div><div className="booking-card__actions"><Button disabled={mode?.type === "reschedule" && availabilityLoading} secondary onClick={() => beginReschedule(booking)}>{mode?.type === "reschedule" && mode.booking.bookingId === booking.bookingId && availabilityLoading ? "Loading times..." : "Reschedule"}</Button><Button secondary onClick={() => setMode({ type: "cancel", booking })}>Cancel</Button></div></article>; })}</div> : <p className="booking-empty">No active appointments.</p>}</section>
      {mode?.type === "cancel" && <section className="cancel-confirmation" aria-labelledby="cancel-title"><h2 id="cancel-title">Cancel this appointment?</h2><p>{mode.booking.date} at {mode.booking.displayTime}. This cannot be undone from this screen.</p><div><Button disabled={busy} onClick={() => void cancel()}>{busy ? "Cancelling..." : "Confirm cancellation"}</Button><Button disabled={busy} onClick={() => setMode(null)} secondary>Keep appointment</Button></div></section>}
      <section className="service-booking" aria-labelledby="service-title"><div className="section-heading"><div><p className="booking-kicker">Schedule</p><h2 id="service-title">{mode?.type === "reschedule" ? "Choose a replacement time" : "Book an appointment"}</h2></div><span className={bookingsOpen ? "status-open" : "status-closed"}>{bookingsOpen ? "Open" : "Closed"}</span></div>
        <div className="service-tabs" role="tablist" aria-label="Minister services">{SERVICE_ORDER.map((code) => { const item = services.find((candidate) => candidate.code === code); if (!item) return null; return <button aria-selected={selectedService === code} className="service-tab" disabled={mode?.type === "reschedule" && selectedService !== code} key={code} onClick={() => chooseService(code)} role="tab" type="button"><strong>{appointmentTypeLabel(item.code, item.displayLabel)}</strong><span>{item.date ?? "Date pending"}</span></button>; })}</div>
        {service && <div className="availability-heading"><div><span>Selected service</span><strong>{appointmentTypeLabel(service.code, service.displayLabel)}</strong></div><div><span>Service date</span><strong>{availability?.date ?? service.date ?? "Not scheduled"}</strong></div></div>}
        {!bookingsOpen && mode?.type !== "cancel" ? <p className="booking-empty">New bookings and rescheduling are unavailable while the window is closed.</p>
        : <form className="slot-form" onSubmit={mode?.type === "reschedule" ? reschedule : submitBooking}><fieldset aria-busy={availabilityLoading} disabled={busy || availabilityLoading}><legend>Available times</legend>{availabilityLoading ? <div className="availability-loading" role="status"><span aria-hidden="true" className="booking-loading" /><span>{mode?.type === "reschedule" ? "Loading replacement times..." : "Loading available times..."}</span></div> : <div className="slot-grid">{availability ? sortSlots(availability.slots).map((slot) => <label className="slot-option" key={slot.slotId}><input checked={selectedSlot === slot.slotId} name="slot" onChange={() => setSelectedSlot(slot.slotId)} required type="radio" value={slot.slotId} /><span>{slot.displayTime}</span></label>) : availabilityFailed ? <div className="availability-retry"><p className="booking-empty">Availability could not be loaded.</p><Button onClick={() => void loadAvailability(selectedService)} secondary type="button">Try again</Button></div> : null}</div>}{availability && !availability.slots.length && <p className="booking-empty">No times are currently available for this service.</p>}</fieldset><RequirementInputs disabled={busy || availabilityLoading} fields={fields} values={requirements} onChange={(code, value) => setRequirements((current) => ({ ...current, [code]: value }))} /><div className="form-actions"><Button disabled={busy || availabilityLoading || !selectedSlot || !bookingsOpen} type="submit">{busy ? "Working..." : mode?.type === "reschedule" ? "Confirm reschedule" : "Confirm booking"}</Button>{mode?.type === "reschedule" && <Button onClick={() => setMode(null)} secondary type="button">Keep current time</Button>}</div></form>}
      </section>
    </div>}
  </section>;
}
