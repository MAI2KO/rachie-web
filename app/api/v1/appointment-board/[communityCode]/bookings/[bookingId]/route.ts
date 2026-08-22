import { handleManagerBookingMutation } from "@/server/booking-board/route-handler";

export const runtime = "nodejs";

type Context = { params: Promise<{ communityCode: string; bookingId: string }> };

export async function PATCH(request: Request, context: Context) {
  const { communityCode, bookingId } = await context.params;
  return handleManagerBookingMutation(request, communityCode, bookingId, "reschedule");
}

export async function DELETE(request: Request, context: Context) {
  const { communityCode, bookingId } = await context.params;
  return handleManagerBookingMutation(request, communityCode, bookingId, "cancel");
}
