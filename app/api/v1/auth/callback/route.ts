import { handleAuthCallback } from "@/server/auth/route-handler";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleAuthCallback(request);
}
