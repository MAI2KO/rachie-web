import type { Metadata } from "next";

import { AppointmentBoardPage } from "@/server/booking-board/page";

export const metadata: Metadata = { title: "State appointments" };

export default async function StateAppointmentsPage({ params }: { params: Promise<{ communityCode: string }> }) {
  return <AppointmentBoardPage communityCode={(await params).communityCode} requiredProfile="wos" />;
}
