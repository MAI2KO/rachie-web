import { handleDiscordCanonicalRegistration } from "@/server/discord-integration/setup-registration-handler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleDiscordCanonicalRegistration(request);
}
