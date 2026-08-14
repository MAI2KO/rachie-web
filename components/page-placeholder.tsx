import type { ReactNode } from "react";

interface PagePlaceholderProps {
  readonly title: string;
  readonly children: ReactNode;
}

export function PagePlaceholder({ title, children }: PagePlaceholderProps) {
  return (
    <section aria-labelledby="page-title" className="page-intro">
      <h1 id="page-title">{title}</h1>
      <p>{children}</p>
    </section>
  );
}
