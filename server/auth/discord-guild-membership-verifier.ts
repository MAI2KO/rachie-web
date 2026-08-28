import "server-only";

import type { GameProfile } from "@/brands/types";
import { getAllianceEventsIntegrationConfig } from "@/server/alliance-events/config";

import { getDiscordBotToken } from "./config";
import {
  createDiscordGuildManagerVerifier,
  createDiscordGuildMembershipVerifier,
} from "./discord-guild-membership-verifier-core.mjs";
import {
  createNativeBotGuildOwnerVerifier,
  createNativeBotManagerVerifier,
} from "./native-bot-manager-verifier-core.mjs";

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

export type DiscordGuildManagerResult =
  | { readonly status: "authorized"; readonly via: "administrator" | "bot_manager_role"; readonly guildId: string }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string; readonly retryAfterSeconds: number | null };

const verifyDiscordOwnerOrAdministrator = createDiscordGuildManagerVerifier({
  resolveBotToken: (gameProfile: GameProfile) => getDiscordBotToken(gameProfile),
}) as (input: {
  gameProfile: GameProfile;
  discordUserId: string;
  guildId: string;
  managerRoleId: string | null;
}) => Promise<DiscordGuildManagerResult>;

export const verifyDiscordGuildManager = createNativeBotManagerVerifier({
  resolveIntegrationConfig: (gameProfile: GameProfile) =>
    getAllianceEventsIntegrationConfig(gameProfile),
  verifyDiscordOwnerOrAdministrator,
}) as (input: {
  gameProfile: GameProfile;
  discordUserId: string;
  guildId: string;
}) => Promise<DiscordGuildManagerResult>;

export type DiscordGuildOwnerResult =
  | { readonly status: "owner" | "not_owner" }
  | { readonly status: "unavailable"; readonly reason: string; readonly retryAfterSeconds: number | null };

export const verifyDiscordGuildOwner = createNativeBotGuildOwnerVerifier({
  resolveIntegrationConfig: (gameProfile: GameProfile) =>
    getAllianceEventsIntegrationConfig(gameProfile),
}) as (input: {
  gameProfile: GameProfile;
  discordUserId: string;
  guildId: string;
}) => Promise<DiscordGuildOwnerResult>;
