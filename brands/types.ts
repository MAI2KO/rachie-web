export type BrandId = "rachie" | "peggie";

export type GameProfile = "wos" | "kingshot";

export type BrandThemeId = "whiteout" | "kingshot";

export interface BrandConfig {
  readonly id: BrandId;
  readonly displayName: string;
  readonly shortName: string;
  readonly description: string;
  readonly domain: string;
  readonly stagingDomain: string;
  readonly localHostnames: readonly string[];
  readonly game: {
    readonly name: string;
    readonly profile: GameProfile;
  };
  readonly assets: {
    readonly namespace: string;
    readonly basePath: string;
  };
  readonly theme: {
    readonly id: BrandThemeId;
    readonly colors: {
      readonly accent: string;
      readonly accentStrong: string;
      readonly accentContrast: string;
      readonly canvas: string;
      readonly surface: string;
      readonly surfaceMuted: string;
      readonly text: string;
      readonly textMuted: string;
      readonly border: string;
      readonly focusRing: string;
    };
  };
}
