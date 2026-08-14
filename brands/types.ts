export type BrandId = "rachie" | "peggie";

export type GameProfile = "wos" | "kingshot";

export interface BrandConfig {
  readonly id: BrandId;
  readonly name: string;
  readonly domain: string;
  readonly localHostnames: readonly string[];
  readonly game: {
    readonly name: string;
    readonly profile: GameProfile;
  };
  readonly copy: {
    readonly siteDescription: string;
  };
  readonly assets: {
    readonly namespace: string;
  };
  readonly theme: {
    readonly accent: string;
    readonly background: string;
    readonly foreground: string;
  };
}
