import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { allianceEventsRequestHeaders } from "../server/alliance-events/auth-core.mjs";
import { createAllianceEventsClient, publicAllianceEventsModel } from "../server/alliance-events/client-core.mjs";
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
  const fetchImpl = async (_url, options) => {
    calls += 1;
    assert.equal(options.headers["x-alliance-events-profile"], "wos");
    assert.match(options.headers["x-alliance-events-signature"], /^v1=[0-9a-f]{64}$/);
    return { ok: true, json: async () => ({ ok: true, ...raw }) };
  };
  const client = createAllianceEventsClient({ config: { baseUrl: "https://internal.example", secret, profile: "wos" },
    fetchImplementation: fetchImpl, now: () => 1_777_777_777_000, createNonce: () => "abcdefghijklmnop" });
  assert.deepEqual((await client.read("9999")).alliances[0].name, "Titans");
  await client.read("9999");
  assert.equal(calls, 1);
  const broken = createAllianceEventsClient({ config: { baseUrl: "https://internal.example", secret, profile: "wos" },
    fetchImplementation: async () => { throw new Error("offline"); } });
  await assert.rejects(broken.read("9999"), /unavailable/i);
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
  assert.match(ui, /Kingdom/); assert.match(ui, /State/); assert.match(ui, /UTC:/); assert.match(ui, /occurrence\.group/);
  assert.match(local, /Intl\.DateTimeFormat/); assert.match(local, /timeZoneName/);
  assert.match(state, /requiredProfile="wos"/); assert.match(kingdom, /requiredProfile="kingshot"/);
  assert.doesNotMatch(topEvents, /AllianceEvents|alliance-events/);
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
