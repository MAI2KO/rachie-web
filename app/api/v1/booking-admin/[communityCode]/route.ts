import {
  handleBookingAdminMutation,
  handleBookingAdminRead,
} from "@/server/booking-admin/route-handler";

export const runtime = "nodejs";

type Context = { params: Promise<{ communityCode: string }> };

export async function GET(request: Request, context: Context) {
  return handleBookingAdminRead(request, (await context.params).communityCode);
}

export async function PATCH(request: Request, context: Context) {
  return handleBookingAdminMutation(request, (await context.params).communityCode);
}
