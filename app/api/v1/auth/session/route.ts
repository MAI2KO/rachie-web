import { handleAuthSession } from "@/server/auth/route-handler";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleAuthSession(request);
}
