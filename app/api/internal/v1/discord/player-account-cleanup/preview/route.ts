import { handlePlayerAccountCleanupPreview } from "@/server/discord-integration/player-account-cleanup-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handlePlayerAccountCleanupPreview;
