import assert from "node:assert/strict";
import test from "node:test";

import { brandHostnames } from "../brands/hostnames.mjs";
import { normalizeHostname, resolveKnownBrandCore } from "../brands/resolve-core.mjs";
import { resolveAuthRequestContextCore } from "../server/auth/request-context-core.mjs";
import {
  railwayClientAddress,
  requestHostnameHeader,
  trustsRailwayProxy,
} from "../server/request-proxy.mjs";
import { readinessResponse } from "../server/health/readiness-core.mjs";
import { requestNetworkSubject } from "../server/rate-limit/request-subject.mjs";

test("staging and production hostnames resolve to the matching isolated profile", () => {
  const brands = {
    rachie: { domain: brandHostnames.rachie.production, stagingDomain: brandHostnames.rachie.staging, localHostnames: brandHostnames.rachie.local, game: { profile: "wos" } },
    peggie: { domain: brandHostnames.peggie.production, stagingDomain: brandHostnames.peggie.staging, localHostnames: brandHostnames.peggie.local, game: { profile: "kingshot" } },
  };
  for (const [hostname, profile] of [
    ["r-a-c-h-i-e.com", "wos"],
    ["staging.r-a-c-h-i-e.com", "wos"],
    ["peggie.r-a-c-h-i-e.com", "kingshot"],
    ["peggie-staging.r-a-c-h-i-e.com", "kingshot"],
  ]) {
    assert.equal(resolveKnownBrandCore(hostname, brands)?.game.profile, profile);
  }
});

test("forwarded hostname has authority only with explicit Railway proxy trust", () => {
  const request = new Request("http://internal/api/v1/auth/session", {
    headers: {
      host: "r-a-c-h-i-e.com",
      "x-forwarded-host": "peggie.r-a-c-h-i-e.com",
    },
  });
  const dependencies = {
    normalizeHostname,
    resolveKnownBrand: (hostname) => resolveKnownBrandCore(hostname, {
      rachie: { domain: brandHostnames.rachie.production, stagingDomain: brandHostnames.rachie.staging, localHostnames: brandHostnames.rachie.local, game: { profile: "wos" } },
      peggie: { domain: brandHostnames.peggie.production, stagingDomain: brandHostnames.peggie.staging, localHostnames: brandHostnames.peggie.local, game: { profile: "kingshot" } },
    }),
  };
  const direct = resolveAuthRequestContextCore(request, {
    ...dependencies,
    requestHostnameHeader: (headers) => requestHostnameHeader(headers, false),
  });
  const railway = resolveAuthRequestContextCore(request, {
    ...dependencies,
    requestHostnameHeader: (headers) => requestHostnameHeader(headers, true),
  });
  assert.equal(direct.gameProfile, "wos");
  assert.equal(railway.gameProfile, "kingshot");
  assert.equal(trustsRailwayProxy({ TRUSTED_PROXY: "railway" }), true);
  assert.equal(trustsRailwayProxy({ TRUSTED_PROXY: "other" }), false);
});

test("rate-limit identity trusts Railway X-Real-IP, never client X-Forwarded-For", () => {
  const spoofed = new Headers({
    "x-forwarded-for": "203.0.113.99",
    "x-real-ip": "198.51.100.42",
  });
  assert.equal(railwayClientAddress(spoofed, false), null);
  assert.equal(railwayClientAddress(spoofed, true), "198.51.100.42");
  const request = new Request("https://staging.r-a-c-h-i-e.com", { headers: spoofed });
  assert.equal(requestNetworkSubject(request, {}), "unknown-network");
  assert.equal(
    requestNetworkSubject(request, { TRUSTED_PROXY: "railway" }),
    "198.51.100.42",
  );
  assert.equal(
    railwayClientAddress(new Headers({ "x-real-ip": "not-an-ip" }), true),
    null,
  );
});

test("readiness is controlled and requires a working database", async () => {
  assert.equal((await readinessResponse(() => null)).status, 503);
  assert.equal((await readinessResponse(() => ({ query: async () => { throw new Error("database details"); } }))).status, 503);
  const ready = await readinessResponse(() => ({ query: async () => ({ rows: [{ one: 1 }] }) }));
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true });
});
