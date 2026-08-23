import { handlePublicWorldMap } from "@/server/world-map/route-handler";

export const runtime = "nodejs";

export function GET(request: Request) {
  return handlePublicWorldMap(request);
}
