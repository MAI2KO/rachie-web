import { handleLegacyAnnouncementRepairBegin } from "@/server/discord-integration/route-handler";

export const runtime = "nodejs";
type Context = { params: Promise<{ notificationId: string }> };

export async function POST(request: Request, context: Context) {
  return handleLegacyAnnouncementRepairBegin(request, (await context.params).notificationId);
}
