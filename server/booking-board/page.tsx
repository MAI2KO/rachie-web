import "server-only";

import { notFound } from "next/navigation";

import type { GameProfile } from "@/brands/types";
import { getBrandRequestContext } from "@/brands/server";
import { AppointmentBoard, type PublicBoard } from "@/components/appointment-board/appointment-board";
import { readPublicAppointmentBoard } from "./public-board";

export async function AppointmentBoardPage({
  communityCode,
  requiredProfile,
}: {
  communityCode: string;
  requiredProfile: GameProfile;
}) {
  const { brand } = await getBrandRequestContext();
  if (brand.game.profile !== requiredProfile) notFound();
  let board;
  try {
    board = await readPublicAppointmentBoard(requiredProfile, communityCode);
  } catch {
    notFound();
  }
  if (!board) notFound();
  return <AppointmentBoard initialBoard={board as PublicBoard} profile={requiredProfile} />;
}
