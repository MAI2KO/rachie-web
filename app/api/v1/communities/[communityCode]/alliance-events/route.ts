import { handlePublicAllianceEvents } from "@/server/alliance-events/route-handler";

export const runtime = "nodejs";

type Context = { params: Promise<{ communityCode: string }> };

export async function GET(request: Request, context: Context) {
  return handlePublicAllianceEvents(request, (await context.params).communityCode);
}
