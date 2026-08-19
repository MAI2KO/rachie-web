import type { Metadata } from "next";

import { getBrandRequestContext } from "@/brands/server";
import { BookingExperience } from "@/components/booking/booking-experience";

export const metadata: Metadata = {
  title: "Booking",
};

export default async function BookingPage() {
  const { brand } = await getBrandRequestContext();
  return <BookingExperience brand={brand} />;
}
