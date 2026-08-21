import { handleManagerApprovalMutation } from "@/server/booking-board/route-handler";

export const runtime = "nodejs";

type Context = { params: Promise<{ communityCode: string; requestId: string }> };

export async function POST(request: Request, context: Context) {
  const { communityCode, requestId } = await context.params;
  return handleManagerApprovalMutation(request, communityCode, requestId);
}
