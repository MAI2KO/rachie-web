import type { BrandConfig, BrandId } from "./types";

export const DEFAULT_BRAND_ID: BrandId = "rachie";

export const brandConfigs = {
  rachie: {
    id: "rachie",
    name: "R.A.C.H.I.E",
    domain: "r-a-c-h-i-e.com",
    localHostnames: ["localhost", "127.0.0.1", "::1"],
    game: { name: "Whiteout Survival", profile: "wos" },
    copy: { siteDescription: "R.A.C.H.I.E for Whiteout Survival" },
    assets: { namespace: "rachie" },
    theme: {
      accent: "#2563eb",
      background: "#ffffff",
      foreground: "#171717",
    },
  },
  peggie: {
    id: "peggie",
    name: "P.E.G.G.I.E",
    domain: "peggie.r-a-c-h-i-e.com",
    localHostnames: ["peggie.localhost"],
    game: { name: "Kingshot", profile: "kingshot" },
    copy: { siteDescription: "P.E.G.G.I.E for Kingshot" },
    assets: { namespace: "peggie" },
    theme: {
      accent: "#dc2626",
      background: "#ffffff",
      foreground: "#171717",
    },
  },
} as const satisfies Record<BrandId, BrandConfig>;

export type ActiveBrand = (typeof brandConfigs)[BrandId];
