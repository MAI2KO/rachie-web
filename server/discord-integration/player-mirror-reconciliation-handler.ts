import "server-only";

import { createNativeBookingRepository } from "@/server/native-booking/repository";
import { reconcileAuthoritativePlayerMirrors } from "@/server/native-booking/player-mirror-reconciliation-core.mjs";

import {
  authenticateDiscordIntegrationReadOnlyRequest,
  authenticateDiscordIntegrationRequest,
  discordIntegrationError,
} from "./route-handler";

const responseHeaders = { "Cache-Control": "no-store" };

async function handle(request: Request, dryRun: boolean) {
  try {
    const scope = dryRun
      ? await authenticateDiscordIntegrationReadOnlyRequest(request)
      : await authenticateDiscordIntegrationRequest(request);
    const repository = createNativeBookingRepository(scope.profile);
    if (!repository) throw new Error("booking_database_unavailable");
    const body = scope.body as { accounts?: unknown };
    const reconciliation = await reconcileAuthoritativePlayerMirrors({
      gameProfile: scope.profile,
      accounts: body.accounts,
      dryRun,
      repository,
    });
    return Response.json({ ok: true, profile: scope.profile, reconciliation }, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    return discordIntegrationError(error, dryRun
      ? "player_mirror_reconciliation_preview"
      : "player_mirror_reconciliation_execute");
  }
}

export function handlePlayerMirrorReconciliationPreview(request: Request) {
  return handle(request, true);
}

export function handlePlayerMirrorReconciliationExecute(request: Request) {
  return handle(request, false);
}

