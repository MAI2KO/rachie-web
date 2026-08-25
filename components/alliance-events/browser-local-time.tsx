"use client";

import { useEffect, useState } from "react";

function localTime(instant: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(instant));
}

export function BrowserLocalTime({ instant }: { readonly instant: string }) {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setValue(localTime(instant)), 0);
    return () => window.clearTimeout(timer);
  }, [instant]);
  return <span suppressHydrationWarning>{value ? `Your time: ${value}` : "Your time: —"}</span>;
}
