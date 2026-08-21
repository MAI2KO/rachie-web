export type AllianceBadgeVariant = "solid";

export function AllianceBadge({
  abbreviation,
  variant = "solid",
}: {
  abbreviation: string;
  variant?: AllianceBadgeVariant;
}) {
  return (
    <span
      aria-label={`Alliance ${abbreviation}`}
      className={`alliance-badge alliance-badge--${variant}`}
    >
      {abbreviation}
    </span>
  );
}
