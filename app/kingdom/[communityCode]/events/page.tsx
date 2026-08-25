import type { Metadata } from "next";

import { AllianceEventsPage } from "@/server/alliance-events/page";

export const metadata: Metadata = { title: "Kingdom alliance events" };

export default async function KingdomAllianceEventsPage({ params }: {
  readonly params: Promise<{ communityCode: string }>;
}) {
  return <AllianceEventsPage communityCode={(await params).communityCode} requiredProfile="kingshot" />;
}
