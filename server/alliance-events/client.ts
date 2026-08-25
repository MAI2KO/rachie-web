import "server-only";

import type { GameProfile } from "@/brands/types";

import { createAllianceEventsClient } from "./client-core.mjs";
import { getAllianceEventsIntegrationConfig } from "./config";

const clients = new Map<GameProfile, ReturnType<typeof createAllianceEventsClient>>();

export function getAllianceEventsClient(profile: GameProfile) {
  if (clients.has(profile)) return clients.get(profile)!;
  const config = getAllianceEventsIntegrationConfig(profile);
  if (!config) return null;
  const client = createAllianceEventsClient({ config });
  clients.set(profile, client);
  return client;
}
