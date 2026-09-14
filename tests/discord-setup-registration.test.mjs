import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Discord setup and registration routes reuse signed profile scope and native booking services", () => {
  const handler = fs.readFileSync(new URL(
    "../server/discord-integration/setup-registration-handler.ts", import.meta.url,
  ), "utf8");
  const setupRoute = fs.readFileSync(new URL(
    "../app/api/internal/v1/discord/setup/community/route.ts", import.meta.url,
  ), "utf8");
  const registrationRoute = fs.readFileSync(new URL(
    "../app/api/internal/v1/discord/registration/route.ts", import.meta.url,
  ), "utf8");
  const reconciliationHandler = fs.readFileSync(new URL(
    "../server/discord-integration/player-mirror-reconciliation-handler.ts", import.meta.url,
  ), "utf8");
  const previewRoute = fs.readFileSync(new URL(
    "../app/api/internal/v1/discord/player-mirrors/preview/route.ts", import.meta.url,
  ), "utf8");
  const executeRoute = fs.readFileSync(new URL(
    "../app/api/internal/v1/discord/player-mirrors/execute/route.ts", import.meta.url,
  ), "utf8");
  const cleanupHandler = fs.readFileSync(new URL(
    "../server/discord-integration/player-account-cleanup-handler.ts", import.meta.url,
  ), "utf8");
  const cleanupPreviewRoute = fs.readFileSync(new URL(
    "../app/api/internal/v1/discord/player-account-cleanup/preview/route.ts", import.meta.url,
  ), "utf8");
  const cleanupExecuteRoute = fs.readFileSync(new URL(
    "../app/api/internal/v1/discord/player-account-cleanup/execute/route.ts", import.meta.url,
  ), "utf8");
  const integrationHandler = fs.readFileSync(new URL(
    "../server/discord-integration/route-handler.ts", import.meta.url,
  ), "utf8");
  assert.match(handler, /authenticateDiscordIntegrationRequest/);
  assert.match(handler, /createDiscordCommunitySetupService/);
  assert.match(handler, /findCommunityForDiscordGuild/);
  assert.match(handler, /community\.location_code !== communityCode/);
  assert.match(handler, /createRegistrationService/);
  assert.match(handler, /synchronizeAuthoritativePrimary/);
  assert.match(handler, /primarySyncOnly === true/);
  assert.match(handler, /body\.isPrimary !== true/);
  assert.match(handler, /allianceAbbreviation/);
  assert.doesNotMatch(handler, /GAME_PROFILE|gameProfile\s*:\s*body/);
  assert.match(setupRoute, /handleDiscordCommunitySetup/);
  assert.match(registrationRoute, /handleDiscordCanonicalRegistration/);
  assert.match(reconciliationHandler, /authenticateDiscordIntegrationReadOnlyRequest/);
  assert.match(reconciliationHandler, /authenticateDiscordIntegrationRequest/);
  assert.match(reconciliationHandler, /reconcileAuthoritativePlayerMirrors/);
  assert.doesNotMatch(reconciliationHandler, /getServerSession|cookies\(|authorization/i);
  assert.match(previewRoute, /handlePlayerMirrorReconciliationPreview/);
  assert.match(executeRoute, /handlePlayerMirrorReconciliationExecute/);
  assert.match(cleanupHandler, /authenticateDiscordIntegrationReadOnlyRequest/);
  assert.match(cleanupHandler, /authenticateDiscordIntegrationRequest/);
  assert.match(cleanupHandler, /inspectOrDeactivateLegacyPlayerAccounts/);
  assert.doesNotMatch(cleanupHandler, /getServerSession|cookies\(|authorization/i);
  assert.match(cleanupPreviewRoute, /handlePlayerAccountCleanupPreview/);
  assert.match(cleanupExecuteRoute, /handlePlayerAccountCleanupExecute/);
  assert.match(integrationHandler, /verifyDiscordIntegrationRequest/);
  assert.match(integrationHandler,
    /authenticateDiscordIntegrationRequestCore\(request, false\)/);
  assert.match(integrationHandler, /if \(consumeNonce\)/);
});
