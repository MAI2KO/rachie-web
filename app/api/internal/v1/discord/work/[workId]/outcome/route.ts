import { handleDiscordWorkOutcome } from "@/server/discord-integration/route-handler";

export const runtime = "nodejs";
type Context = { params: Promise<{ workId: string }> };
export async function POST(request: Request, context: Context) {
  const { workId } = await context.params;
  return handleDiscordWorkOutcome(request, workId);
}
