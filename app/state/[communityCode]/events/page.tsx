import type { Metadata } from "next";

import { AllianceEventsPage } from "@/server/alliance-events/page";

export const metadata: Metadata = { title: "State alliance events" };

export default async function StateAllianceEventsPage({ params }: {
  readonly params: Promise<{ communityCode: string }>;
}) {
  return <AllianceEventsPage communityCode={(await params).communityCode} requiredProfile="wos" />;
}
