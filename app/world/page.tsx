import type { Metadata } from "next";

import { getBrandRequestContext } from "@/brands/server";
import { WorldMap } from "@/components/world-map/world-map";
import { readPublicWorldMap, type PublicWorldMapCommunity } from "@/server/world-map/read";

export const metadata: Metadata = {
  title: "World",
  description: "Explore registered States and Kingdoms and open their public appointment boards.",
};

export default async function WorldPage() {
  const { brand } = await getBrandRequestContext();
  let communities: PublicWorldMapCommunity[] = [];
  let unavailable = false;
  try {
    communities = await readPublicWorldMap(brand.game.profile);
  } catch {
    unavailable = true;
  }
  return <WorldMap communities={communities} profile={brand.game.profile} unavailable={unavailable} />;
}
