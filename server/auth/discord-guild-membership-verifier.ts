import "server-only";

import type { GameProfile } from "@/brands/types";

import { getDiscordBotToken } from "./config";
import { createDiscordGuildMembershipVerifier } from "./discord-guild-membership-verifier-core.mjs";

export type DiscordGuildMembershipResult =
  | { readonly status: "member" }
  | { readonly status: "not_member" }
  | {
      readonly status: "unavailable";
      readonly reason: string;
      readonly retryAfterSeconds: number | null;
    };

export const verifyDiscordGuildMembership = createDiscordGuildMembershipVerifier({
  resolveBotToken: (gameProfile: GameProfile) => getDiscordBotToken(gameProfile),
}) as (input: {
  gameProfile: GameProfile;
  discordUserId: string;
  guildId: string;
}) => Promise<DiscordGuildMembershipResult>;
