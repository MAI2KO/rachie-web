import "server-only";

import type { GameProfile } from "@/brands/types";

import { publicWorldMapCommunities } from "./read-core.mjs";
import { createWorldMapRepository } from "./repository";

export interface PublicWorldMapCommunity {
  readonly code: string;
  readonly displayName: string;
  readonly href: string;
}

export async function readPublicWorldMap(gameProfile: GameProfile): Promise<PublicWorldMapCommunity[]> {
  const repository = createWorldMapRepository(gameProfile);
  if (!repository) throw new Error("World map database is unavailable.");
  return publicWorldMapCommunities(
    gameProfile,
    await repository.listRegisteredCommunities(),
  ) as PublicWorldMapCommunity[];
}
