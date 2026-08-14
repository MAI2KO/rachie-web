import type { Metadata } from "next";

import { PagePlaceholder } from "@/components/page-placeholder";

export const metadata: Metadata = {
  title: "Events",
};

export default function EventsPage() {
  return (
    <PagePlaceholder title="Events">
      Upcoming community events will appear here.
    </PagePlaceholder>
  );
}
