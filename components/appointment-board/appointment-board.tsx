"use client";

import { useCallback, useEffect, useState } from "react";

type PublicSlot = { time: string; state: "available" | "pending" | "confirmed"; playerName?: string; playerAlliance?: string };
type PublicService = { name: string; date: string; slots: PublicSlot[] };
export type PublicBoard = {
  community: { code: string; displayName: string };
  services: PublicService[];
};
type Requirement = { code: string; label: string; value: number; unit?: string };
type ManagerSlot = PublicSlot & {
  slotId: string;
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
    playerName: string;
    managerDisplayName: string | null;
    previousState: string | null;
    resultingState: string;
    createdAt: string;
  }>;
};

const terms = {
  wos: { community: "State" },
  kingshot: { community: "Kingdom" },
} as const;

const readableDate = (value: string) => new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "long", timeZone: "UTC",
}).format(new Date(`${value}T00:00:00Z`));

function publicSlotLabel(slot: PublicSlot) {
  if (slot.state === "confirmed") return "Confirmed";
  if (slot.state === "pending") return "Pending";
  return "Available";
}

function AllianceBadge({ value }: { value: string }) {
  return <span aria-label={`Alliance ${value}`} className="alliance-badge">[{value}]</span>;
}

function PublicPanels({ services }: { services: PublicService[] }) {
  return (
    <div aria-label="Appointment services" className="appointment-panels">
      {services.map((service) => (
        <section className="appointment-panel" key={`${service.name}:${service.date}`}>
          <header>
            <h2>{service.name}</h2>
            <p>{readableDate(service.date)}</p>
          </header>
          <ol className="appointment-timeline">
            {service.slots.map((slot) => (
              <li className={`appointment-slot appointment-slot--${slot.state}`} key={slot.time}>
                <time>{slot.time}</time>
                {slot.state === "confirmed" && slot.playerName && slot.playerAlliance
                  ? <span className="public-confirmed-player"><AllianceBadge value={slot.playerAlliance} /><span>{slot.playerName}</span></span>
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
      {alliance ? <AllianceBadge value={value} /> : <><span className="visually-hidden">{label}: </span><strong>{value}</strong></>}
      {copied ? <small role="status">Copied</small> : null}
    </button>
  );
}

function ManagerPanels({ board, editMode, copiedKey, onCopy, onAction, busyRequest }: {
  board: ManagerBoard;
  editMode: boolean;
  copiedKey: string;
  onCopy(value: string, key: string): void;
  onAction(requestId: string, action: "approve" | "deny"): void;
  busyRequest: string;
}) {
  return (
    <div aria-label="Manager appointment services" className="appointment-panels">
      {board.services.map((service) => (
        <section className="appointment-panel appointment-panel--manager" key={service.code}>
          <header><h2>{service.name}</h2><p>{readableDate(service.date)}</p></header>
          <div aria-label={`${service.name} operator appointments`} className="manager-table-scroll" role="region" tabIndex={0}>
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
                  return <tr className="manager-row manager-row--available" key={slot.slotId}>
                    <th scope="row"><time>{slot.time}</time></th>
                    <td colSpan={3 + service.requirementColumns.length + (editMode ? 1 : 0)}>Available</td>
                  </tr>;
                }
                return <tr className={`manager-row manager-row--${slot.state}`} key={slot.slotId}>
                  <th scope="row"><time>{slot.time}</time></th>
                  <td><CopyButton alliance copied={copiedKey === `${key}:alliance`} label="Alliance" onCopy={(value) => onCopy(value, `${key}:alliance`)} value={slot.player.alliance} /></td>
                  <td className="manager-player-cell">
                    {slot.player.isCurrentUser ? <span aria-label="This booking belongs to the current user" className="manager-current-user-badge">YOURS</span> : null}
                    <CopyButton copied={copiedKey === `${key}:name`} label="Player name" onCopy={(value) => onCopy(value, `${key}:name`)} value={slot.player.inGameName} />
                    {slot.state === "pending" ? <span className="manager-state-badge">Pending</span> : null}
                  </td>
                  <td><CopyButton copied={copiedKey === `${key}:id`} label="Player ID" onCopy={(value) => onCopy(value, `${key}:id`)} value={slot.player.playerId} /></td>
                  {service.requirementColumns.map((column) => {
                    const answer = slot.requirements?.find((candidate) => candidate.code === column.code);
                    return <td key={column.code}>{answer ? <>{answer.value}{answer.unit ? ` ${answer.unit}` : ""}</> : <span aria-label="No answer">—</span>}</td>;
                  })}
                  {editMode ? <td>{slot.state === "pending" && slot.requestId ? <div className="manager-row__actions">
                    <button className="booking-button" disabled={busyRequest === slot.requestId} onClick={() => onAction(slot.requestId!, "approve")} type="button">Approve</button>
                    <button className="booking-button booking-button--secondary" disabled={busyRequest === slot.requestId} onClick={() => onAction(slot.requestId!, "deny")} type="button">Deny</button>
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
  const [notice, setNotice] = useState("");
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

  const communityTerm = terms[profile].community;
  return (
    <article className="appointment-board">
      <header className="appointment-board__heading">
        <div><p className="booking-kicker">{communityTerm} {initialBoard.community.code}</p><h1>{initialBoard.community.displayName}</h1></div>
        {managerBoard ? <div className="manager-mode-control">
          <span>{editMode ? "Edit Mode" : "Copy Mode"}</span>
          <button className="booking-button booking-button--secondary" onClick={() => setEditMode((value) => !value)} type="button">
            {editMode ? "Return to Copy Mode" : "Edit appointments"}
          </button>
        </div> : null}
      </header>
      {notice ? <p aria-live="polite" className="booking-notice">{notice}</p> : null}
      {managerBoard
        ? <ManagerPanels board={managerBoard} busyRequest={busyRequest} copiedKey={copiedKey} editMode={editMode} onAction={approvalAction} onCopy={copy} />
        : <PublicPanels services={initialBoard.services} />}
      {managerBoard ? <details className="manager-activity">
        <summary>Recent manager activity</summary>
        {managerBoard.activity.length ? <ol>
          {managerBoard.activity.map((event, index) => <li key={`${event.createdAt}:${index}`}>
            <strong>{event.action}</strong> · {event.playerName}
            {event.managerDisplayName ? ` · ${event.managerDisplayName}` : ""}
            {event.previousState ? ` · ${event.previousState} → ${event.resultingState}` : ` · ${event.resultingState}`}
            <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
          </li>)}
        </ol> : <p>No activity yet.</p>}
      </details> : null}
    </article>
  );
}
