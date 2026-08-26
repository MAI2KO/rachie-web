import type { Metadata } from "next";

import { BookingAdminPage } from "@/server/booking-admin/page";

export const metadata: Metadata = { title: "State booking admin" };

export default async function StateBookingAdminPage({ params }: {
  readonly params: Promise<{ communityCode: string }>;
}) {
  return <BookingAdminPage communityCode={(await params).communityCode} requiredProfile="wos" />;
}
