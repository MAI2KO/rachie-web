import { handleLegacyAnnouncementRepairCandidates } from "@/server/discord-integration/route-handler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleLegacyAnnouncementRepairCandidates(request);
}
