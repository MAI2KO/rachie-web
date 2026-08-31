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
  assert.match(handler, /authenticateDiscordIntegrationRequest/);
  assert.match(handler, /createDiscordCommunitySetupService/);
  assert.match(handler, /findCommunityForDiscordGuild/);
  assert.match(handler, /community\.location_code !== communityCode/);
  assert.match(handler, /createRegistrationService/);
  assert.match(handler, /allianceAbbreviation/);
  assert.doesNotMatch(handler, /GAME_PROFILE|gameProfile\s*:\s*body/);
  assert.match(setupRoute, /handleDiscordCommunitySetup/);
  assert.match(registrationRoute, /handleDiscordCanonicalRegistration/);
});
