import type { BrandConfig, BrandId } from "./types";

export const DEFAULT_BRAND_ID: BrandId = "rachie";

export const brandConfigs = {
  rachie: {
    id: "rachie",
    displayName: "R.A.C.H.I.E",
    shortName: "RACHIE",
    description: "Community tools and resources for Whiteout Survival.",
    domain: "r-a-c-h-i-e.com",
    localHostnames: ["localhost", "127.0.0.1", "::1"],
    game: { name: "Whiteout Survival", profile: "wos" },
    assets: { namespace: "rachie", basePath: "/brands/rachie" },
    theme: {
      id: "whiteout",
      colors: {
        accent: "#2563eb",
        accentStrong: "#1d4ed8",
        accentContrast: "#ffffff",
        canvas: "#f8fafc",
        surface: "#ffffff",
        surfaceMuted: "#f1f5f9",
        text: "#18181b",
        textMuted: "#52525b",
        border: "#d4d4d8",
        focusRing: "#2563eb",
      },
    },
  },
  peggie: {
    id: "peggie",
    displayName: "P.E.G.G.I.E",
    shortName: "PEGGIE",
    description: "Community tools and resources for Kingshot.",
    domain: "peggie.r-a-c-h-i-e.com",
    localHostnames: ["peggie.localhost"],
    game: { name: "Kingshot", profile: "kingshot" },
    assets: { namespace: "peggie", basePath: "/brands/peggie" },
    theme: {
      id: "kingshot",
      colors: {
        accent: "#b45309",
        accentStrong: "#92400e",
        accentContrast: "#ffffff",
        canvas: "#fafaf9",
        surface: "#ffffff",
        surfaceMuted: "#f5f5f4",
        text: "#1c1917",
        textMuted: "#57534e",
        border: "#d6d3d1",
        focusRing: "#b45309",
      },
    },
  },
} as const satisfies Record<BrandId, BrandConfig>;

export type ActiveBrand = (typeof brandConfigs)[BrandId];
