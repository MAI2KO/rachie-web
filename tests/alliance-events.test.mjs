import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { allianceEventsRequestHeaders } from "../server/alliance-events/auth-core.mjs";
import { createAllianceEventsClient, publicAllianceEventsModel } from "../server/alliance-events/client-core.mjs";
import { readAllianceEventsCommunityCore } from "../server/alliance-events/read-core.mjs";
import { createProfileScopedAllianceEventsRepository } from "../server/alliance-events/repository-core.mjs";
import { handlePublicAllianceEventsCore } from "../server/alliance-events/route-core.mjs";

const secret = "local-test-secret-with-at-least-32-characters";
const raw = {
  profile: "wos", communityCode: "9999", guildId: "private", channelId: "private",
  alliances: [{ name: "Titans", abbreviation: "TIT", internalId: 4, events: [{
    name: "Bear Trap", messageId: "private", recurrence: { days: 2, summary: "Every 2 days" },
    upcoming: [{ at: "2026-08-24T19:00:00.000Z", group: "Best Bear", claimId: 9 }]
  }] }]
};

test("public serializer is stable and removes all scheduler-private fields", () => {
  const model = publicAllianceEventsModel({ ok: true, ...raw }, "wos", "9999");
  assert.deepEqual(Object.keys(model), ["profile", "communityCode", "alliances"]);
  assert.deepEqual(Object.keys(model.alliances[0]), ["name", "abbreviation", "events"]);
  assert.equal(model.alliances[0].abbreviation, "TIT");
  assert.deepEqual(Object.keys(model.alliances[0].events[0]), ["name", "recurrence", "upcoming"]);
  assert.deepEqual(Object.keys(model.alliances[0].events[0].upcoming[0]), ["at", "group"]);
  assert.doesNotMatch(JSON.stringify(model), /guild|channel|message|claim|transfer/i);
  assert.throws(() => publicAllianceEventsModel({ ok: true, ...raw }, "kingshot", "9999"));
});

test("website client signs, caches by profile/community, and degrades safely", async () => {
  let calls = 0;
  const guildId = "123456789012345678";
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, `https://internal.example/internal/v1/public-alliance-events/guild/${guildId}`);
    assert.equal(options.headers["x-alliance-events-profile"], "wos");
    assert.match(options.headers["x-alliance-events-signature"], /^v1=[0-9a-f]{64}$/);
    return { ok: true, json: async () => ({ ok: true, profile: "wos", alliances: raw.alliances }) };
  };
  const client = createAllianceEventsClient({ config: { baseUrl: "https://internal.example", secret, profile: "wos" },
    fetchImplementation: fetchImpl, now: () => 1_777_777_777_000, createNonce: () => "abcdefghijklmnop" });
  assert.deepEqual((await client.read("9999", [guildId])).alliances[0].name, "Titans");
  await client.read("9999", [guildId]);
  assert.equal(calls, 1);
  const broken = createAllianceEventsClient({ config: { baseUrl: "https://internal.example", secret, profile: "wos" },
    fetchImplementation: async () => { throw new Error("offline"); } });
  await assert.rejects(broken.read("9999", [guildId]), /unavailable/i);
});

test("multiple mapped alliance guilds aggregate and sort without exposing guild IDs", async () => {
  const guilds = ["123456789012345678", "223456789012345678"];
  const calls = [];
  const client = createAllianceEventsClient({
    config: { baseUrl: "https://internal.example", secret, profile: "wos" },
    fetchImplementation: async (url) => {
      calls.push(url);
      const second = url.endsWith(guilds[1]);
      return { ok: true, json: async () => ({ ok: true, profile: "wos", alliances: [{
        name: second ? "Alpha" : "Zulu", abbreviation: null, events: [{
          name: second ? "Foundry" : "Bear Trap", recurrence: { days: 2, summary: "Every 2 days" },
          upcoming: [{ at: "2026-08-24T19:00:00.000Z", group: null }],
        }],
      }] }) };
    },
  });
  const model = await client.read("9999", guilds);
  assert.deepEqual(model.alliances.map((alliance) => alliance.name), ["Alpha", "Zulu"]);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(model), new RegExp(guilds.join("|")));
});

test("website membership lookup is exact-profile and exact-community under RLS context", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/FROM booking_communities/.test(sql)) {
        return { rows: [{ id: "community-wos", location_code: "9999", display_name: "State 9999" }] };
      }
      if (/FROM booking_discord_guilds/.test(sql)) {
        return { rows: [{ discord_guild_id: "123456789012345678" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = createProfileScopedAllianceEventsRepository("wos", { connect: async () => client });
  const result = await repository.findCommunityGuilds("9999");
  assert.deepEqual(result.guildIds, ["123456789012345678"]);
  assert.deepEqual(calls[1].values, ["wos"]);
  assert.match(calls[1].sql, /set_config\('app\.game_profile'/);
  assert.deepEqual(calls[2].values, ["wos", "9999"]);
  assert.match(calls[2].sql, /game_profile=\$1/);
  assert.match(calls[2].sql, /location_code=\$2/);
  assert.deepEqual(calls[3].values, ["wos", "community-wos"]);
  assert.match(calls[3].sql, /game_profile=\$1 AND community_id=\$2/);
});

test("a community with zero mapped guilds is an available empty result without a bot", async () => {
  let clientRequested = false;
  const result = await readAllianceEventsCommunityCore("kingshot", "9999", {
    createRepository: () => ({ findCommunityGuilds: async () => ({
      community: { id: "community-kingshot", location_code: "9999", display_name: "Kingdom 9999" },
      guildIds: [],
    }) }),
    getClient: () => { clientRequested = true; return null; },
  });
  assert.equal(result.availability, "available");
  assert.deepEqual(result.alliances, []);
  assert.equal(clientRequested, false);
});

test("public route is anonymous, profile-derived, and returns a bounded degraded response", async () => {
  const available = await handlePublicAllianceEventsCore(new Request("https://peggie.example/api"), "9999", {
    resolveRequestContext: () => ({ gameProfile: "kingshot" }),
    readCommunity: async () => ({ availability: "available",
      community: { location_code: "9999", display_name: "Test" }, alliances: [] }),
  });
  assert.equal(available.status, 200);
  assert.equal((await available.json()).profile, "kingshot");
  const unavailable = await handlePublicAllianceEventsCore(new Request("https://rachie.example/api"), "9999", {
    resolveRequestContext: () => ({ gameProfile: "wos" }),
    readCommunity: async () => ({ availability: "unavailable" }),
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { ok: false, error: "Alliance event schedules are temporarily unavailable.", code: "scheduler_unavailable" });
});

test("State and Kingdom share navigation and render UTC plus browser-local time without changing top Events", () => {
  const nav = fs.readFileSync(new URL("../components/community-section-navigation.tsx", import.meta.url), "utf8");
  const ui = fs.readFileSync(new URL("../components/alliance-events/alliance-events.tsx", import.meta.url), "utf8");
  const local = fs.readFileSync(new URL("../components/alliance-events/browser-local-time.tsx", import.meta.url), "utf8");
  const state = fs.readFileSync(new URL("../app/state/[communityCode]/events/page.tsx", import.meta.url), "utf8");
  const kingdom = fs.readFileSync(new URL("../app/kingdom/[communityCode]/events/page.tsx", import.meta.url), "utf8");
  const topEvents = fs.readFileSync(new URL("../app/events/page.tsx", import.meta.url), "utf8");
  assert.match(nav, /Appointments/); assert.match(nav, /Alliance Events/);
  assert.match(ui, /Kingdom/); assert.match(ui, /State/); assert.match(ui, /UTC/); assert.match(ui, /occurrence\.group/);
  assert.match(local, /Intl\.DateTimeFormat/); assert.match(local, /timeZoneName/);
  assert.match(state, /requiredProfile="wos"/); assert.match(kingdom, /requiredProfile="kingshot"/);
  assert.doesNotMatch(topEvents, /AllianceEvents|alliance-events/);
});

test("Alliance Events presentation uses responsive event cards with event-led hierarchy", () => {
  const ui = fs.readFileSync(new URL("../components/alliance-events/alliance-events.tsx", import.meta.url), "utf8");
  const local = fs.readFileSync(new URL("../components/alliance-events/browser-local-time.tsx", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(ui, /<h3>\{alliance\.name\}<\/h3>/);
  assert.match(ui, /<h4>\{event\.name\}<\/h4>/);
  assert.match(ui, /<article className="alliance-event-card"/);
  assert.match(ui, /alliance\.events\.map/);
  assert.match(ui, /alliance-event-groups/);
  assert.match(ui, /<dt>\{occurrence\.group\}/);
  assert.match(ui, /aria-hidden="true"> — /);
  assert.match(ui, /event\.upcoming\.slice\(0, 1\)/);
  assert.doesNotMatch(ui, /event\.upcoming\.map/);
  assert.doesNotMatch(ui, /event\.recurrence\.summary|Upcoming:|utcDate/);
  assert.doesNotMatch(ui, /First date|advance reminder|final reminder|publish_to_state|roundup settings/i);
  assert.match(local, /Your local time/);
  assert.match(css, /\.alliance-event-list \{[^}]*grid-template-columns: repeat\(2,/);
  assert.match(css, /\.alliance-event-card \{[^}]*border: 1px solid/);
  assert.match(css, /\.alliance-event-card h4 \{[^}]*font-weight: 800/);
  assert.match(css, /\.alliance-event-group dt \{[^}]*font-weight: 500/);
  assert.doesNotMatch(css, /alliance-event-group[^}]*justify-content: space-between/);
  assert.match(css, /@media \(max-width: 39\.99rem\)[\s\S]*\.alliance-event-list \{ grid-template-columns: 1fr; \}/);
  assert.doesNotMatch(css, /alliance-event-recurrence|alliance-event-upcoming/);
});

test("auth request contains no secret and supports large public models", () => {
  const headers = allianceEventsRequestHeaders({ secret, profile: "wos", method: "GET",
    path: "/internal/v1/public-alliance-events/9999", now: () => 1_777_777_777_000,
    createNonce: () => "abcdefghijklmnop" });
  assert.equal(JSON.stringify(headers).includes(secret), false);
  const many = structuredClone(raw);
  many.alliances = Array.from({ length: 12 }, (_, alliance) => ({ name: `Alliance ${alliance}`, abbreviation: null,
    events: Array.from({ length: 30 }, (_, event) => ({ name: `Event ${event}`,
      recurrence: { days: 2, summary: "Every 2 days" }, upcoming: [{ at: "2026-08-24T19:00:00.000Z", group: null }] })) }));
  assert.equal(publicAllianceEventsModel({ ok: true, ...many }, "wos", "9999").alliances.length, 12);
});
