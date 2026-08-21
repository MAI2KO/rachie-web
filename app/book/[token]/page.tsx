import type { Metadata } from "next";

import { getBrandRequestContext } from "@/brands/server";
import { GuestBookingLoader } from "@/components/guest-booking/guest-booking-form";

export const metadata: Metadata = { title: "Guest booking" };

export default async function GuestBookingPage({ params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  const { brand } = await getBrandRequestContext();
  const profile = brand.game.profile;
  return <GuestBookingLoader profile={profile} token={token} />;
}
