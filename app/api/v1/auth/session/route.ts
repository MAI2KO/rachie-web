import { handleAuthSession } from "@/server/auth/route-handler";
import { withDevelopmentTiming } from "@/server/development-timing.mjs";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return withDevelopmentTiming("route GET /api/v1/auth/session", () => handleAuthSession(request));
}
