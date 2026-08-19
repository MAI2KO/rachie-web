import { proxyLegacyBookingRequest } from "@/server/legacy-booking/route-handler";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return proxyLegacyBookingRequest(request, "kingshot");
}
