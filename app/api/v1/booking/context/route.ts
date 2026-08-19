import { handleNativeBookingContextRead } from "@/server/native-booking/read-route-handler";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleNativeBookingContextRead(request);
}
