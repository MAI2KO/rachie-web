import { handleCommunitySelection } from "@/server/auth/route-handler";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleCommunitySelection(request);
}
