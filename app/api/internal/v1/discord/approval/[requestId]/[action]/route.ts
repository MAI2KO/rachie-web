import { handleDiscordApprovalAction } from "@/server/discord-integration/route-handler";

export const runtime = "nodejs";
type Context = { params: Promise<{ requestId: string; action: string }> };
export async function POST(request: Request, context: Context) {
  const { requestId, action } = await context.params;
  return handleDiscordApprovalAction(request, requestId, action);
}
