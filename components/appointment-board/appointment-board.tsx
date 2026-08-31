"use client";

import { Fragment, useCallback, useEffect, useState } from "react";

import { AllianceBadge } from "./alliance-badge";
import { CommunityPageChrome } from "@/components/community-section-navigation";

type PublicSlot = { time: string; state: "available" | "pending" | "confirmed"; playerName?: string; playerAlliance?: string };
type PublicService = { name: string; date: string; slots: PublicSlot[] };
export type PublicBoard = {
  community: { code: string; displayName: string };
  services: PublicService[];
};
type Requirement = { code: string; label: string; value: number; unit?: string };
type ManagerSlot = PublicSlot & {
  slotId: string;
  date: string;
  requestId?: string;
  bookingId?: string;
  player?: { inGameName: string; playerId: string; alliance: string; isCurrentUser: boolean };
  requirements?: Requirement[];
  holdExpiresAt?: string;
};
type ManagerBoard = {
  community: PublicBoard["community"];
  services: Array<{
    code: string;
    name: string;
    date: string;
    requirementColumns: Array<{ code: string; label: string; unit?: string }>;
    slots: ManagerSlot[];
  }>;
  activity: Array<{
    action: string;
    category: "bookings" | "approvals" | "cancellations" | "manager_actions" | "configuration";
    playerName: string | null;
    playerId: string | null;
    actorDiscordUserId: string | null;
    actorDisplayName: string | null;
    serviceCode: string | null;
    previousState: string | null;
    resultingState: string;
    previousTime?: string;
    newTime?: string;
    createdAt: string;
  }>;
};

const readableDate = (value: string) => new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "long", timeZone: "UTC",
}).format(new Date(`${value}T00:00:00Z`));

function publicSlotLabel(slot: PublicSlot) {
  if (slot.state === "confirmed") return "Confirmed";
  if (slot.state === "pending") return "Pending";
  return "Available";
}

function activityLabel(action: string) {
  if (action === "manager_manual_booking") return "Manager manual booking";
  if (action === "booking_created") return "Player booking created";
  if (action === "submitted") return "Guest request submitted";
  if (action === "approved") return "Guest request approved";
  if (action === "denied") return "Guest request denied";
  if (action === "expired") return "Guest request expired";
  if (action === "manager_booking_rescheduled") return "Booking rescheduled";
  if (action === "manager_booking_cancelled") return "Booking cancelled";
  return action.replaceAll("_", " ");
}

function appointmentTypeName(value: string) {
  return value.toLowerCase() === "troop" ? "Troop Training" : value;
}

function activityStateLabel(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1).replaceAll("_", " ")}` : value;
}

function PublicPanels({ services }: { services: PublicService[] }) {
  return (
    <div aria-label="Appointment services" className="appointment-panels">
      {services.map((service) => (
        <section className="appointment-panel" key={`${service.name}:${service.date}`}>
          <header>
            <h2>{appointmentTypeName(service.name)}</h2>
            <p>{readableDate(service.date)}</p>
          </header>
          <ol className="appointment-timeline">
            {service.slots.map((slot) => (
              <li className={`appointment-slot appointment-slot--${slot.state}`} key={slot.time}>
                <time>{slot.time}</time>
                {slot.state === "confirmed" && slot.playerName && slot.playerAlliance
                  ? <span className="public-confirmed-player"><AllianceBadge abbreviation={slot.playerAlliance} /><span>{slot.playerName}</span></span>
                  : <span>{publicSlotLabel(slot)}</span>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function CopyButton({ value, label, copied, onCopy, alliance = false }: {
  value: string; label: string; copied: boolean; alliance?: boolean; onCopy(value: string, label: string): void;
}) {
  return (
    <button
      className={`copy-field${copied ? " copy-field--copied" : ""}`}
      aria-label={`Copy ${label.toLowerCase()} ${value}`}
      onClick={() => onCopy(value, label)}
      type="button"
    >
      {alliance ? <AllianceBadge abbreviation={value} /> : <><span className="visually-hidden">{label}: </span><strong>{value}</strong></>}
      {copied ? <small role="status">Copied</small> : null}
    </button>
  );
}

function ManagerPanels({ board, editMode, copiedKey, onCopy, onApprovalAction,
  onBookingAction, busyRequest, busyBooking, cancellingBooking, reschedulingBooking,
  rescheduleSlot, onCancelChoice, onRescheduleChoice, manualSlot, busyManual,
  onManualChoice, onManualSubmit }: {
  board: ManagerBoard;
  editMode: boolean;
  copiedKey: string;
  onCopy(value: string, key: string): void;
  onApprovalAction(requestId: string, action: "approve" | "deny"): void;
  onBookingAction(bookingId: string, action: "reschedule" | "cancel", slotId?: string): void;
  busyRequest: string;
  busyBooking: string;
  cancellingBooking: string;
  reschedulingBooking: string;
  rescheduleSlot: string;
  onCancelChoice(bookingId: string): void;
  onRescheduleChoice(bookingId: string, slotId?: string): void;
  manualSlot: string;
  busyManual: string;
  onManualChoice(slotId: string): void;
  onManualSubmit(service: ManagerBoard["services"][number], slot: ManagerSlot,
    form: FormData): void;
}) {
  return (
    <div aria-label="Manager appointment services" className="appointment-panels">
      {board.services.map((service) => (
        <section className="appointment-panel appointment-panel--manager" key={service.code}>
          <header><h2>{appointmentTypeName(service.name)}</h2><p>{readableDate(service.date)}</p></header>
          <div aria-label={`${appointmentTypeName(service.name)} manager appointments`}
            className="manager-table-scroll" role="region" tabIndex={0}>
            <table className="manager-table">
              <thead><tr>
                <th scope="col">Time</th>
                <th scope="col">Alliance</th>
                <th scope="col">Player</th>
                <th scope="col">Player ID</th>
                {service.requirementColumns.map((column) => <th key={column.code} scope="col">{column.label}</th>)}
                {editMode ? <th scope="col">Actions</th> : null}
              </tr></thead>
              <tbody>{service.slots.map((slot) => {
                const key = slot.requestId ?? slot.bookingId ?? slot.slotId;
                if (!slot.player) {
                  return <Fragment key={slot.slotId}><tr className="manager-row manager-row--available">
                    <th scope="row"><time>{slot.time}</time></th>
                    <td colSpan={3 + service.requirementColumns.length}>Available</td>
                    {editMode ? <td><div className="manager-row__actions"><button className="booking-button"
                      onClick={() => onManualChoice(slot.slotId)} type="button">Book this slot</button></div></td> : null}
                  </tr>{editMode && manualSlot === slot.slotId ? <tr className="manager-manual-booking-row">
                    <td colSpan={5 + service.requirementColumns.length}>
                      <form className="manager-manual-booking-form" onSubmit={(event) => {
                        event.preventDefault();
                        onManualSubmit(service, slot, new FormData(event.currentTarget));
                      }}>
                        <p><strong>{appointmentTypeName(service.name)}</strong> · {readableDate(slot.date)} · {slot.time}</p>
                        <label>Player ID<input maxLength={32} name="playerId" required /></label>
                        <label>In-game name<input maxLength={100} name="inGameName" required /></label>
                        <label>Alliance<input maxLength={16} name="alliance" required /></label>
                        {service.requirementColumns.map((requirement) => <label key={requirement.code}>
                          {requirement.label}{requirement.unit ? ` (${requirement.unit})` : ""}
                          <input max={999999} min={1} name={`requirement:${requirement.code}`}
                            required type="number" />
                        </label>)}
                        <div className="manager-row__actions">
                          <button className="booking-button" disabled={busyManual === slot.slotId}
                            type="submit">Confirm booking</button>
                          <button className="booking-button booking-button--secondary"
                            onClick={() => onManualChoice("")} type="button">Back</button>
                        </div>
                      </form>
                    </td>
                  </tr> : null}</Fragment>;
                }
                return <tr className={`manager-row manager-row--${slot.state}`} key={slot.slotId}>
                  <th scope="row"><time>{slot.time}</time></th>
                  <td><CopyButton alliance copied={copiedKey === `${key}:alliance`} label="Alliance" onCopy={(value) => onCopy(value, `${key}:alliance`)} value={slot.player.alliance} /></td>
                  <td className="manager-player-cell">
                    <CopyButton copied={copiedKey === `${key}:name`} label="Player name" onCopy={(value) => onCopy(value, `${key}:name`)} value={slot.player.inGameName} />
                    {slot.state === "pending" ? <span className="manager-state-badge">Pending</span> : null}
                  </td>
                  <td><CopyButton copied={copiedKey === `${key}:id`} label="Player ID" onCopy={(value) => onCopy(value, `${key}:id`)} value={slot.player.playerId} /></td>
                  {service.requirementColumns.map((column) => {
                    const answer = slot.requirements?.find((candidate) => candidate.code === column.code);
                    return <td key={column.code}>{answer ? <>{answer.value}{answer.unit ? ` ${answer.unit}` : ""}</> : <span aria-label="No answer">—</span>}</td>;
                  })}
                  {editMode ? <td>{slot.state === "pending" && slot.requestId ? <div className="manager-row__actions">
                    <button className="booking-button" disabled={busyRequest === slot.requestId} onClick={() => onApprovalAction(slot.requestId!, "approve")} type="button">Approve</button>
                    <button className="booking-button booking-button--secondary" disabled={busyRequest === slot.requestId} onClick={() => onApprovalAction(slot.requestId!, "deny")} type="button">Deny</button>
                  </div> : slot.state === "confirmed" && slot.bookingId ? <div className="manager-row__actions">
                    {reschedulingBooking === slot.bookingId ? <>
                      <label className="visually-hidden" htmlFor={`reschedule-${slot.bookingId}`}>New appointment time</label>
                      <select id={`reschedule-${slot.bookingId}`} onChange={(event) => onRescheduleChoice(slot.bookingId!, event.target.value)} value={rescheduleSlot}>
                        <option value="">Select time</option>
                        {service.slots.filter((candidate) => candidate.state === "available" && candidate.date === slot.date)
                          .map((candidate) => <option key={candidate.slotId} value={candidate.slotId}>{candidate.time}</option>)}
                      </select>
                      <button className="booking-button" disabled={!rescheduleSlot || busyBooking === slot.bookingId} onClick={() => onBookingAction(slot.bookingId!, "reschedule", rescheduleSlot)} type="button">Confirm move</button>
                      <button className="booking-button booking-button--secondary" onClick={() => onRescheduleChoice("")} type="button">Back</button>
                    </> : cancellingBooking === slot.bookingId ? <>
                      <span>Cancel this appointment?</span>
                      <button className="booking-button" disabled={busyBooking === slot.bookingId} onClick={() => onBookingAction(slot.bookingId!, "cancel")} type="button">Confirm cancel</button>
                      <button className="booking-button booking-button--secondary" onClick={() => onCancelChoice("")} type="button">Keep</button>
                    </> : <>
                      <button className="booking-button" onClick={() => onRescheduleChoice(slot.bookingId!)} type="button">Reschedule</button>
                      <button className="booking-button booking-button--secondary" onClick={() => onCancelChoice(slot.bookingId!)} type="button">Cancel</button>
                    </>}
                  </div> : null}</td> : null}
                </tr>;
              })}</tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

export function AppointmentBoard({ profile, initialBoard }: {
  profile: "wos" | "kingshot";
  initialBoard: PublicBoard;
}) {
  const [managerBoard, setManagerBoard] = useState<ManagerBoard | null>(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");
  const [busyRequest, setBusyRequest] = useState("");
  const [busyBooking, setBusyBooking] = useState("");
  const [cancellingBooking, setCancellingBooking] = useState("");
  const [reschedulingBooking, setReschedulingBooking] = useState("");
  const [rescheduleSlot, setRescheduleSlot] = useState("");
  const [manualSlot, setManualSlot] = useState("");
  const [busyManual, setBusyManual] = useState("");
  const [notice, setNotice] = useState("");
  const [activityFilter, setActivityFilter] = useState("all");
  const endpoint = `/api/v1/appointment-board/${encodeURIComponent(initialBoard.community.code)}/manager`;

  const loadManagerBoard = useCallback(async () => {
    const [sessionResponse, boardResponse] = await Promise.all([
      fetch("/api/v1/auth/session", { cache: "no-store" }),
      fetch(endpoint, { cache: "no-store" }),
    ]);
    if (!boardResponse.ok) return;
    const [sessionPayload, boardPayload] = await Promise.all([sessionResponse.json(), boardResponse.json()]);
    if (sessionPayload.authenticated && typeof sessionPayload.csrfToken === "string") {
      setCsrfToken(sessionPayload.csrfToken);
    }
    if (boardPayload.ok) setManagerBoard(boardPayload.board);
  }, [endpoint]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadManagerBoard(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadManagerBoard]);

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      const label = key.endsWith(":id") ? "Player ID" : key.endsWith(":alliance") ? "Alliance" : "Player name";
      setNotice(`${label} copied.`);
    } catch {
      setNotice("Copy failed. Select and copy the value manually.");
    }
  }

  async function approvalAction(requestId: string, action: "approve" | "deny") {
    setBusyRequest(requestId);
    setNotice("");
    try {
      const response = await fetch(`${endpoint.replace(/\/manager$/, "")}/requests/${encodeURIComponent(requestId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "The action could not be completed.");
      setNotice(action === "approve" ? "Appointment approved." : "Request denied.");
      await loadManagerBoard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The action could not be completed.");
    } finally {
      setBusyRequest("");
    }
  }

  function cancelChoice(bookingId: string) {
    setCancellingBooking(bookingId);
    setReschedulingBooking("");
    setRescheduleSlot("");
    setManualSlot("");
  }

  function rescheduleChoice(bookingId: string, slotId = "") {
    setReschedulingBooking(bookingId);
    setRescheduleSlot(slotId);
    setCancellingBooking("");
    setManualSlot("");
  }

  function manualChoice(slotId: string) {
    setManualSlot(slotId);
    setCancellingBooking("");
    setReschedulingBooking("");
    setRescheduleSlot("");
  }

  async function manualBookingAction(
    service: ManagerBoard["services"][number], slot: ManagerSlot, form: FormData,
  ) {
    setBusyManual(slot.slotId);
    setNotice("");
    const requirements = Object.fromEntries(service.requirementColumns.map((requirement) => [
      requirement.code, String(form.get(`requirement:${requirement.code}`) ?? ""),
    ]));
    try {
      const response = await fetch(`${endpoint.replace(/\/manager$/, "")}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken,
          "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          playerId: String(form.get("playerId") ?? ""),
          inGameName: String(form.get("inGameName") ?? ""),
          alliance: String(form.get("alliance") ?? ""),
          serviceCode: service.code, slotId: slot.slotId, requirements,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "The appointment could not be created.");
      setNotice("Appointment created by manager.");
      setManualSlot("");
      await loadManagerBoard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The appointment could not be created.");
    } finally {
      setBusyManual("");
    }
  }

  async function bookingAction(bookingId: string, action: "reschedule" | "cancel", slotId?: string) {
    setBusyBooking(bookingId);
    setNotice("");
    try {
      const response = await fetch(`${endpoint.replace(/\/manager$/, "")}/bookings/${encodeURIComponent(bookingId)}`, {
        method: action === "cancel" ? "DELETE" : "PATCH",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
          "idempotency-key": crypto.randomUUID(),
        },
        ...(action === "reschedule" ? { body: JSON.stringify({ slotId }) } : {}),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "The appointment could not be changed.");
      setNotice(action === "cancel" ? "Appointment cancelled." : "Appointment rescheduled.");
      setCancellingBooking("");
      setReschedulingBooking("");
      setRescheduleSlot("");
      await loadManagerBoard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The appointment could not be changed.");
    } finally {
      setBusyBooking("");
    }
  }

  return (
    <article className="appointment-board">
      <CommunityPageChrome communityCode={initialBoard.community.code} current="appointments"
        displayName={initialBoard.community.displayName} profile={profile} resolveAdmin={false}
        showAdmin={Boolean(managerBoard)}>
        {managerBoard ? <div aria-label="Appointment manager mode" className="manager-mode-control">
          <button aria-pressed={editMode} className="booking-button" onClick={() => setEditMode(true)}
            type="button">Edit appointments</button>
          <button aria-pressed={!editMode} className="booking-button booking-button--secondary"
            onClick={() => setEditMode(false)} type="button">Copy mode</button>
        </div> : null}
      </CommunityPageChrome>
      {notice ? <p aria-live="polite" className="booking-notice">{notice}</p> : null}
      {managerBoard
        ? <ManagerPanels board={managerBoard} busyBooking={busyBooking} busyRequest={busyRequest}
          busyManual={busyManual} cancellingBooking={cancellingBooking} copiedKey={copiedKey}
          editMode={editMode} manualSlot={manualSlot}
          onApprovalAction={approvalAction} onBookingAction={bookingAction} onCancelChoice={cancelChoice}
          onCopy={copy} onManualChoice={manualChoice} onManualSubmit={manualBookingAction}
          onRescheduleChoice={rescheduleChoice} rescheduleSlot={rescheduleSlot}
          reschedulingBooking={reschedulingBooking} />
        : <PublicPanels services={initialBoard.services} />}
      {managerBoard ? <details className="manager-activity" open>
        <summary>Recent activity</summary>
        <label>Filter activity <select onChange={(event) => setActivityFilter(event.target.value)}
          value={activityFilter}>
          <option value="all">All</option><option value="bookings">Bookings</option>
          <option value="approvals">Approvals</option><option value="cancellations">Cancellations</option>
          <option value="manager_actions">Manager actions</option>
          <option value="configuration">Configuration</option>
        </select></label>
        {managerBoard.activity.some((event) => activityFilter === "all" || event.category === activityFilter)
          ? <div className="manager-table-scroll" role="region" tabIndex={0}><table className="manager-table">
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Player</th><th>Details</th></tr></thead>
            <tbody>{managerBoard.activity.filter((event) => activityFilter === "all"
              || event.category === activityFilter).map((event, index) => <tr key={`${event.createdAt}:${index}`}>
              <td><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></td>
              <td>{event.actorDisplayName ?? "System"}</td>
              <td>{activityLabel(event.action)}</td>
              <td>{event.playerName ?? "—"}{event.playerId
                ? <small className="manager-audit-id">Player ID: {event.playerId}</small> : null}</td>
              <td>{event.serviceCode ? `${appointmentTypeName(event.serviceCode)} · ` : ""}
                {event.previousState ? `${activityStateLabel(event.previousState)} → ${activityStateLabel(event.resultingState)}`
                  : activityStateLabel(event.resultingState)}
                {event.previousTime ? ` · ${event.previousTime}${event.newTime ? ` → ${event.newTime}` : ""}` : ""}</td>
            </tr>)}</tbody>
          </table></div> : <p>No matching activity.</p>}
      </details> : null}
    </article>
  );
}
