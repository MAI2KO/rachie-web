import { handlePlayerMirrorReconciliationExecute } from "@/server/discord-integration/player-mirror-reconciliation-handler";

export const runtime = "nodejs";

export const POST = handlePlayerMirrorReconciliationExecute;

