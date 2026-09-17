import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalRegistrationScope,
  canonicalRegistrationIdempotencyKey,
  CanonicalRegistrationContractError,
  resolveCanonicalRegistrationCommunity,
} from "../server/discord-integration/canonical-registration-core.mjs";

const valid = {
  guildId: "777777777777777777",
  discordUserId: "999999999999999999",
  communityCode: "1001",
  canonicalCommunityCode: "1001",
  isPrimary: true,
};

test("canonical registration resolves the character community and treats guild linkage as attribution", async () => {
  const scope = canonicalRegistrationScope(valid);
  const matching = await resolveCanonicalRegistrationCommunity({ scope, session: {
    async findCommunityByLocationCode(code) {
      assert.equal(code, "1001");
      return { id: "community-one", location_code: code, status: "active" };
    },
    async findCommunityForDiscordGuild() {
      return { id: "community-one", location_code: "1001", status: "active" };
    },
  } });
  assert.equal(matching.sourceGuildId, valid.guildId);
  assert.equal(matching.sourceGuildRelation, "matching");

  const moved = await resolveCanonicalRegistrationCommunity({ scope, session: {
    async findCommunityByLocationCode() {
      return { id: "community-one", location_code: "1001", status: "active" };
    },
    async findCommunityForDiscordGuild() {
      return { id: "old-community", location_code: "999", status: "active" };
    },
  } });
  assert.equal(moved.community.id, "community-one");
  assert.equal(moved.sourceGuildId, null);
  assert.equal(moved.sourceGuildRelation, "stale_or_different_community");
});

test("canonical retry keys are stable and distinguish authoritative MAIN changes", () => {
  const input = { profile: "wos", discordUserId: valid.discordUserId,
    communityCode: "1001", registration: { playerId: "123", inGameName: "One",
      alliance: "TAG" }, isPrimary: true };
  assert.equal(canonicalRegistrationIdempotencyKey(input),
    canonicalRegistrationIdempotencyKey(structuredClone(input)));
  assert.notEqual(canonicalRegistrationIdempotencyKey(input),
    canonicalRegistrationIdempotencyKey({ ...input, isPrimary: false }));
});

test("canonical registration refuses unresolved, cross-community, and malformed contracts", async () => {
  assert.throws(() => canonicalRegistrationScope({
    ...valid, canonicalCommunityCode: "1002",
  }), (error) => error instanceof CanonicalRegistrationContractError
    && error.code === "community_mismatch");
  assert.throws(() => canonicalRegistrationScope({
    ...valid, discordUserId: "not-a-snowflake",
  }), (error) => error.code === "invalid_request");
  assert.throws(() => canonicalRegistrationScope({
    ...valid, isPrimary: "true",
  }), (error) => error.code === "invalid_request");
  await assert.rejects(resolveCanonicalRegistrationCommunity({
    scope: canonicalRegistrationScope(valid),
    session: {
      async findCommunityByLocationCode() { return null; },
    },
  }), (error) => error.code === "unresolved_community");
});

test("WOS and Kingshot codes resolve only through their injected profile-scoped session", async () => {
  for (const [profile, code] of [["wos", "1001"], ["kingshot", "2002"]]) {
    const seen = [];
    const result = await resolveCanonicalRegistrationCommunity({
      scope: canonicalRegistrationScope({ ...valid, guildId: null,
        communityCode: code, canonicalCommunityCode: code }),
      session: {
        async findCommunityByLocationCode(value) {
          seen.push([profile, value]);
          return { id: `${profile}-community`, location_code: value, status: "active" };
        },
      },
    });
    assert.deepEqual(seen, [[profile, code]]);
    assert.equal(result.sourceGuildRelation, "not_supplied");
  }
});
