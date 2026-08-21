import { handleDiscordWorkClaim } from "@/server/discord-integration/route-handler";

export const runtime = "nodejs";
export const POST = handleDiscordWorkClaim;
