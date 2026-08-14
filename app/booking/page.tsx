import type { Metadata } from "next";

import { PagePlaceholder } from "@/components/page-placeholder";

export const metadata: Metadata = {
  title: "Booking",
};

export default function BookingPage() {
  return (
    <PagePlaceholder title="Booking">
      Booking services will appear here.
    </PagePlaceholder>
  );
}
