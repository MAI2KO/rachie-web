import type { Metadata } from "next";

import { AppointmentBoardPage } from "@/server/booking-board/page";

export const metadata: Metadata = { title: "Kingdom appointments" };

export default async function KingdomAppointmentsPage({ params }: { params: Promise<{ communityCode: string }> }) {
  return <AppointmentBoardPage communityCode={(await params).communityCode} requiredProfile="kingshot" />;
}
