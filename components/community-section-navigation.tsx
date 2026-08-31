"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import type { GameProfile } from "@/brands/types";

type PublicSession = {
  readonly authenticated?: boolean;
  readonly csrfToken?: string;
  readonly user?: { readonly username?: string; readonly globalName?: string | null };
};

function communityPath(profile: GameProfile, communityCode: string,
  current: "appointments" | "events" | "admin") {
  const base = `/${profile === "kingshot" ? "kingdom" : "state"}/${encodeURIComponent(communityCode)}`;
  if (current === "events") return `${base}/events`;
  if (current === "admin") return `${base}/admin`;
  return base;
}

export function CommunityHeaderActions({ returnPath }: { readonly returnPath: string }) {
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
          ? <a className="booking-button booking-button--secondary"
            href={`/api/v1/auth/login?returnTo=${encodeURIComponent(returnPath)}`}>Log in</a>
          : null}
    </div>
    {logoutError ? <span aria-live="polite" className="community-auth-error">{logoutError}</span> : null}
  </div>;
}

export function CommunitySectionNavigation({ profile, communityCode, current, showAdmin = false,
  resolveAdmin = true }: {
  readonly profile: GameProfile;
  readonly communityCode: string;
  readonly current: "appointments" | "events" | "admin";
  readonly showAdmin?: boolean;
  readonly resolveAdmin?: boolean;
}) {
  const base = communityPath(profile, communityCode, "appointments");
  const [authorizedCommunity, setAuthorizedCommunity] = useState<string | null>(null);
  const managerAuthorized = showAdmin || authorizedCommunity === communityCode;
  useEffect(() => {
    if (showAdmin || !resolveAdmin) return;
    let active = true;
    void fetch("/api/v1/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(async (session) => {
        if (!active) return;
        const signedIn = session?.authenticated === true;
        if (!signedIn) {
          setAuthorizedCommunity(null);
          return;
        }
        const response = await fetch(
          `/api/v1/appointment-board/${encodeURIComponent(communityCode)}/manager`,
          { cache: "no-store" },
        );
        if (active && response.ok) setAuthorizedCommunity(communityCode);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [communityCode, resolveAdmin, showAdmin]);
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

export function CommunityPageChrome({ profile, communityCode, displayName, current,
  showAdmin = false, resolveAdmin = true, children }: {
  readonly profile: GameProfile;
  readonly communityCode: string;
  readonly displayName: string;
  readonly current: "appointments" | "events" | "admin";
  readonly showAdmin?: boolean;
  readonly resolveAdmin?: boolean;
  readonly children?: ReactNode;
}) {
  const noun = profile === "kingshot" ? "Kingdom" : "State";
  const returnPath = communityPath(profile, communityCode, current);
  return <div className="community-page-chrome">
    <header className="community-page-heading">
      <div><p className="booking-kicker">{noun} {communityCode}</p><h1>{displayName}</h1></div>
      <CommunityHeaderActions returnPath={returnPath} />
    </header>
    <CommunitySectionNavigation communityCode={communityCode} current={current} profile={profile}
      resolveAdmin={resolveAdmin} showAdmin={showAdmin} />
    {children}
  </div>;
}
