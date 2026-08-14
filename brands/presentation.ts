import type { CSSProperties } from "react";

import type { ActiveBrand } from "./config";

interface BrandCssProperties extends CSSProperties {
  "--brand-accent": string;
  "--brand-accent-strong": string;
  "--brand-accent-contrast": string;
  "--brand-canvas": string;
  "--brand-surface": string;
  "--brand-surface-muted": string;
  "--brand-text": string;
  "--brand-text-muted": string;
  "--brand-border": string;
  "--brand-focus-ring": string;
}

export function getBrandCssProperties(brand: ActiveBrand): BrandCssProperties {
  const { colors } = brand.theme;

  return {
    "--brand-accent": colors.accent,
    "--brand-accent-strong": colors.accentStrong,
    "--brand-accent-contrast": colors.accentContrast,
    "--brand-canvas": colors.canvas,
    "--brand-surface": colors.surface,
    "--brand-surface-muted": colors.surfaceMuted,
    "--brand-text": colors.text,
    "--brand-text-muted": colors.textMuted,
    "--brand-border": colors.border,
    "--brand-focus-ring": colors.focusRing,
  };
}
