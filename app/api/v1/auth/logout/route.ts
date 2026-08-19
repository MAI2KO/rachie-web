import { handleAuthLogout } from "@/server/auth/route-handler";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleAuthLogout(request);
}
