import type { Metadata } from "next";

import { PagePlaceholder } from "@/components/page-placeholder";

export const metadata: Metadata = {
  title: "Help",
};

export default function HelpPage() {
  return (
    <PagePlaceholder title="Help">
      Guides and support resources will appear here.
    </PagePlaceholder>
  );
}
