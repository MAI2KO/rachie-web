"use client";

import { useEffect, useState } from "react";

function localTime(instant: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(new Date(instant));
}

export function BrowserLocalTime({ instant }: { readonly instant: string }) {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setValue(localTime(instant)), 0);
    return () => window.clearTimeout(timer);
  }, [instant]);
  return <span aria-label={value ? `Your local time: ${value}` : "Your local time unavailable"}
    className="alliance-occurrence-time__local" suppressHydrationWarning>
    {value ?? "Local time —"}
  </span>;
}
