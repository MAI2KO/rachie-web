import "server-only";

import { notFound } from "next/navigation";

import type { GameProfile } from "@/brands/types";
import { getBrandRequestContext } from "@/brands/server";
import {
  AllianceEvents,
  type PublicAllianceSchedule,
} from "@/components/alliance-events/alliance-events";

import { readAllianceEventsCommunity } from "./read";

export async function AllianceEventsPage({ communityCode, requiredProfile }: {
  readonly communityCode: string;
  readonly requiredProfile: GameProfile;
}) {
  const { brand } = await getBrandRequestContext();
  if (brand.game.profile !== requiredProfile) notFound();
  let result;
  try { result = await readAllianceEventsCommunity(requiredProfile, communityCode); } catch { notFound(); }
  if (!result) notFound();
  return <AllianceEvents
    alliances={result.alliances as PublicAllianceSchedule[]}
    community={{ code: result.community.location_code, displayName: result.community.display_name }}
    profile={requiredProfile}
    unavailable={result.availability !== "available"}
  />;
}
