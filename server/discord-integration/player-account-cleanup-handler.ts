import "server-only";

import { createNativeBookingRepository } from "@/server/native-booking/repository";
import { inspectOrDeactivateLegacyPlayerAccounts } from "@/server/native-booking/player-account-cleanup-core.mjs";

import { authenticateDiscordIntegrationReadOnlyRequest,
  authenticateDiscordIntegrationRequest, discordIntegrationError } from "./route-handler";

const responseHeaders = { "Cache-Control": "no-store" };

async function handle(request: Request, dryRun: boolean) {
  try {
    const scope = dryRun
      ? await authenticateDiscordIntegrationReadOnlyRequest(request)
      : await authenticateDiscordIntegrationRequest(request);
    const repository = createNativeBookingRepository(scope.profile);
    if (!repository) throw new Error("booking_database_unavailable");
    const body = scope.body as { candidates?: unknown };
    const cleanup = await inspectOrDeactivateLegacyPlayerAccounts({
      gameProfile: scope.profile, candidates: body.candidates, dryRun, repository,
    });
    return Response.json({ ok: true, profile: scope.profile, cleanup }, {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    return discordIntegrationError(error, dryRun
      ? "player_account_cleanup_preview" : "player_account_cleanup_execute");
  }
}

export function handlePlayerAccountCleanupPreview(request: Request) { return handle(request, true); }
export function handlePlayerAccountCleanupExecute(request: Request) { return handle(request, false); }
