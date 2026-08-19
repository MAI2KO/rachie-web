import { handleBookingCreate } from "@/server/native-booking/booking-creation-route-handler";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleBookingCreate(request);
}
