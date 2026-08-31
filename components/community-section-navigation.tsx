"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { GameProfile } from "@/brands/types";

export function CommunitySectionNavigation({ profile, communityCode, current, showAdmin = false }: {
  readonly profile: GameProfile;
  readonly communityCode: string;
  readonly current: "appointments" | "events" | "admin";
  readonly showAdmin?: boolean;
}) {
  const base = `/${profile === "kingshot" ? "kingdom" : "state"}/${encodeURIComponent(communityCode)}`;
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [managerAuthorized, setManagerAuthorized] = useState(showAdmin);
  useEffect(() => {
    let active = true;
    void fetch("/api/v1/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(async (session) => {
        if (!active) return;
        const signedIn = session?.authenticated === true;
        setAuthenticated(signedIn);
        if (!signedIn || showAdmin) return;
        const response = await fetch(
          `/api/v1/appointment-board/${encodeURIComponent(communityCode)}/manager`,
          { cache: "no-store" },
        );
        if (active && response.ok) setManagerAuthorized(true);
      })
      .catch(() => { if (active) setAuthenticated(false); });
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
      <div className="community-section-actions">
        {authenticated
          ? <Link className="booking-button" href="/booking">Book Appointment / My Bookings</Link>
          : authenticated === false
            ? <a className="booking-button" href="/api/v1/auth/login">Log in / Book Appointment</a>
            : null}
        {managerAuthorized && current !== "admin"
          ? <Link className="booking-button booking-button--secondary" href={`${base}/admin`}>Booking Admin</Link>
          : null}
      </div>
    </div>
  );
}
