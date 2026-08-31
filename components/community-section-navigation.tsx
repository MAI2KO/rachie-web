"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { GameProfile } from "@/brands/types";

type PublicSession = {
  readonly authenticated?: boolean;
  readonly csrfToken?: string;
  readonly user?: { readonly username?: string; readonly globalName?: string | null };
};

export function CommunityHeaderActions() {
  const [session, setSession] = useState<PublicSession | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => { if (active) setSession(payload); })
      .catch(() => { if (active) setSession({ authenticated: false }); });
    return () => { active = false; };
  }, []);

  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": session?.csrfToken ?? "" },
      });
      if (!response.ok) throw new Error("Log out failed.");
      setSession({ authenticated: false });
    } catch {
      setLogoutError("Log out failed. Please try again.");
    } finally {
      setLoggingOut(false);
    }
  }

  return <div className="community-header-actions">
    <div className="session-actions">
      {session?.authenticated
        ? <><span className="session-mark">Discord: {session.user?.globalName
          ?? session.user?.username ?? "Signed in"}</span>
        <button className="booking-button booking-button--secondary" disabled={loggingOut}
          onClick={() => void logout()} type="button">{loggingOut ? "Logging out..." : "Log out"}</button></>
        : session
          ? <a className="booking-button booking-button--secondary" href="/api/v1/auth/login">Log in</a>
          : null}
    </div>
    <Link className="booking-button" href="/booking">Book Appointment / My Bookings</Link>
    {logoutError ? <span aria-live="polite" className="community-auth-error">{logoutError}</span> : null}
  </div>;
}

export function CommunitySectionNavigation({ profile, communityCode, current, showAdmin = false }: {
  readonly profile: GameProfile;
  readonly communityCode: string;
  readonly current: "appointments" | "events" | "admin";
  readonly showAdmin?: boolean;
}) {
  const base = `/${profile === "kingshot" ? "kingdom" : "state"}/${encodeURIComponent(communityCode)}`;
  const [managerAuthorized, setManagerAuthorized] = useState(showAdmin);
  useEffect(() => {
    let active = true;
    void fetch("/api/v1/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(async (session) => {
        if (!active) return;
        const signedIn = session?.authenticated === true;
        if (!signedIn || showAdmin) return;
        const response = await fetch(
          `/api/v1/appointment-board/${encodeURIComponent(communityCode)}/manager`,
          { cache: "no-store" },
        );
        if (active && response.ok) setManagerAuthorized(true);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [communityCode, showAdmin]);
  return (
    <div className="community-section-navigation">
      <nav aria-label={`${profile === "kingshot" ? "Kingdom" : "State"} sections`} className="community-section-nav">
        <Link aria-current={current === "appointments" ? "page" : undefined} href={base}>Appointments</Link>
        <Link aria-current={current === "events" ? "page" : undefined} href={`${base}/events`}>Alliance Events</Link>
        {managerAuthorized
          ? <Link aria-current={current === "admin" ? "page" : undefined} href={`${base}/admin`}>Booking Admin</Link>
          : null}
      </nav>
    </div>
  );
}
