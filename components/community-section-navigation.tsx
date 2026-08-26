import Link from "next/link";

import type { GameProfile } from "@/brands/types";

export function CommunitySectionNavigation({ profile, communityCode, current, showAdmin = false }: {
  readonly profile: GameProfile;
  readonly communityCode: string;
  readonly current: "appointments" | "events" | "admin";
  readonly showAdmin?: boolean;
}) {
  const base = `/${profile === "kingshot" ? "kingdom" : "state"}/${encodeURIComponent(communityCode)}`;
  return (
    <nav aria-label={`${profile === "kingshot" ? "Kingdom" : "State"} sections`} className="community-section-nav">
      <Link aria-current={current === "appointments" ? "page" : undefined} href={base}>Appointments</Link>
      <Link aria-current={current === "events" ? "page" : undefined} href={`${base}/events`}>Alliance Events</Link>
      {showAdmin
        ? <Link aria-current={current === "admin" ? "page" : undefined} href={`${base}/admin`}>Booking Admin</Link>
        : null}
    </nav>
  );
}
