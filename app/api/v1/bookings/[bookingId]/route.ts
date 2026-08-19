import { handleBookingCancellation, handleBookingReschedule } from "@/server/native-booking/booking-mutation-route-handler";

export const runtime = "nodejs";

type Context = { params: Promise<{ bookingId: string }> };

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return handleBookingReschedule(request, (await context.params).bookingId);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return handleBookingCancellation(request, (await context.params).bookingId);
}
