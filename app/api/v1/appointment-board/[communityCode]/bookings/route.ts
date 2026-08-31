import { handleManagerManualBooking } from "@/server/booking-board/route-handler";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ communityCode: string }> },
) {
  return handleManagerManualBooking(request, (await params).communityCode);
}
