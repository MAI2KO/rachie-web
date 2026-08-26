import type { Metadata } from "next";

import { BookingAdminPage } from "@/server/booking-admin/page";

export const metadata: Metadata = { title: "Kingdom booking admin" };

export default async function KingdomBookingAdminPage({ params }: {
  readonly params: Promise<{ communityCode: string }>;
}) {
  return <BookingAdminPage communityCode={(await params).communityCode} requiredProfile="kingshot" />;
}
