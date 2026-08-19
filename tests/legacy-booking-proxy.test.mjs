import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEGACY_BOOKING_ACTIONS,
} from "../server/legacy-booking/actions.mjs";
import {
  resolveLegacyBookingBackendUrl,
} from "../server/legacy-booking/backend-config.mjs";
import {
  handleLegacyBookingProxyRequest,
} from "../server/legacy-booking/proxy-core.mjs";
import {
  createLegacyBookingTransport,
} from "../server/legacy-booking/transport.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  RACHIE_LEGACY_BOOKING_URL: "https://legacy.example/rachie",
  PEGGIE_LEGACY_BOOKING_URL: "https://legacy.example/peggie",
};

function jsonRequest(body) {
  return new Request("http://localhost/api/compat/booking/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function recordingTransport(responseBody = '{"ok":true}') {
  const calls = [];
  return {
    calls,
    transport: {
      async forward(backendUrl, requestBody) {
        calls.push({ backendUrl, requestBody });
        return { body: responseBody, status: 200 };
      },
    },
  };
}

async function proxy({
  expectedProfile,
  requestProfile = expectedProfile,
  body = '{"action":"get_times_for_server"}',
  environment = env,
  transport,
}) {
  return handleLegacyBookingProxyRequest({
    request: jsonRequest(body),
    expectedProfile,
    requestProfile,
    backendUrl: resolveLegacyBookingBackendUrl(requestProfile, environment),
    transport,
  });
}

test("profile backend configuration is strictly mapped", () => {
  assert.equal(resolveLegacyBookingBackendUrl("wos", env), env.RACHIE_LEGACY_BOOKING_URL);
  assert.equal(resolveLegacyBookingBackendUrl("kingshot", env), env.PEGGIE_LEGACY_BOOKING_URL);
  assert.equal(resolveLegacyBookingBackendUrl("unknown", env), null);
})

test("WOS and Kingshot requests use only their matching legacy backend", async () => {
  for (const [profile, backendUrl] of [
    ["wos", env.RACHIE_LEGACY_BOOKING_URL],
    ["kingshot", env.PEGGIE_LEGACY_BOOKING_URL],
  ]) {
    const recorded = recordingTransport();
    const response = await proxy({
      expectedProfile: profile,
      transport: recorded.transport,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(recorded.calls.map((call) => call.backendUrl), [backendUrl]);
  }
});

test("route and hostname profile mismatch fails without forwarding", async () => {
  const recorded = recordingTransport();
  const response = await proxy({
    expectedProfile: "wos",
    requestProfile: "kingshot",
    transport: recorded.transport,
  });

  assert.equal(response.status, 404);
  assert.deepEqual(recorded.calls, []);
});

test("request body profile fields have no routing authority", async () => {
  const recorded = recordingTransport();
  const body = [
    "{",
    '  "action": "get_times_for_server",',
    '  "game_profile": "kingshot",',
    '  "discordServerId": "123"',
    "}",
  ].join("\n");
  const response = await proxy({
    expectedProfile: "wos",
    body,
    transport: recorded.transport,
  });

  assert.equal(response.status, 200);
  assert.equal(recorded.calls[0].backendUrl, env.RACHIE_LEGACY_BOOKING_URL);
  assert.equal(recorded.calls[0].requestBody, body);
});

test("unknown, state, and banter actions are rejected", async () => {
  for (const action of [
    "unknown_action",
    "setup_state",
    "get_linked_servers_for_current_state",
    "get_sheet_link_for_server",
    "set_banter_channel_for_server",
    "get_banter_spice_for_server",
    "get_bot_admin_role_for_server",
    "update_setting_for_server",
  ]) {
    const recorded = recordingTransport();
    const response = await proxy({
      expectedProfile: "wos",
      body: JSON.stringify({ action }),
      transport: recorded.transport,
    });

    assert.equal(response.status, 400, action);
    assert.deepEqual(recorded.calls, [], action);
  }
});

test("request and successful legacy response bodies remain byte-for-byte unchanged", async () => {
  const legacyResponseBody = '{ "ok" : true, "times" : ["1:00", "2:00"] }\n';
  const requestBody = '{ "action" : "get_times_for_server", "day" : "Research" }\n';
  const recorded = recordingTransport(legacyResponseBody);
  const response = await proxy({
    expectedProfile: "wos",
    body: requestBody,
    transport: recorded.transport,
  });

  assert.equal(recorded.calls[0].requestBody, requestBody);
  assert.equal(await response.text(), legacyResponseBody);
});

test("missing backend configuration fails closed", async () => {
  const recorded = recordingTransport();
  const response = await proxy({
    expectedProfile: "wos",
    environment: {},
    transport: recorded.transport,
  });

  assert.equal(response.status, 503);
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "Legacy booking backend is not configured for this profile.",
  });
});

test("network failures return a controlled response without backend details", async () => {
  const transport = createLegacyBookingTransport({
    async fetchImpl() {
      throw new Error(`Could not reach ${env.RACHIE_LEGACY_BOOKING_URL}?secret=value`);
    },
  });
  const response = await proxy({ expectedProfile: "wos", transport });
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.match(body, /Legacy booking backend is unavailable/);
  assert.doesNotMatch(body, /legacy\.example|secret=value/);
});

test("timeouts return a controlled response without backend details", async () => {
  const transport = createLegacyBookingTransport({
    timeoutMs: 5,
    fetchImpl(_url, options) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      });
    },
  });
  const response = await proxy({ expectedProfile: "wos", transport });
  const body = await response.text();

  assert.equal(response.status, 504);
  assert.match(body, /Legacy booking backend timed out/);
  assert.doesNotMatch(body, /legacy\.example/);
});

test("transport preserves the legacy JSON response and POST request contract", async () => {
  const calls = [];
  const responseBody = '{"ok":false,"error":"legacy error"}';
  const transport = createLegacyBookingTransport({
    async fetchImpl(...args) {
      calls.push(args);
      return new Response(responseBody, {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const requestBody = '{"action":"book_for_server","adminKey":"test"}';
  const result = await transport.forward("https://legacy.example/rachie", requestBody);

  assert.deepEqual(result, { body: responseBody, status: 409 });
  assert.equal(calls[0][0], "https://legacy.example/rachie");
  assert.deepEqual(
    {
      method: calls[0][1].method,
      headers: calls[0][1].headers,
      body: calls[0][1].body,
      cache: calls[0][1].cache,
    },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      cache: "no-store",
    },
  );
});

test("the allowlist is explicit and limited to booking-domain actions", () => {
  assert.deepEqual(LEGACY_BOOKING_ACTIONS, [
    "admin_add_booking_for_server",
    "admin_remove_booking_for_server",
    "admin_remove_reserved_slots_for_server",
    "admin_reserve_slots_for_server",
    "book_for_server",
    "clear_bookings_for_server",
    "close_bookings_for_server",
    "delete_registered_player_for_server",
    "get_booking_config_for_server",
    "get_booking_date_for_server",
    "get_booking_link_for_server",
    "get_my_bookings_for_server",
    "get_registered_player_for_server",
    "get_reserved_times_for_server",
    "get_times_for_server",
    "open_bookings_for_server",
    "register_player_for_server",
    "remove_booking_for_server",
    "set_booking_date_for_server",
  ]);
});

test("legacy backend configuration is absent from browser-exposed source", () => {
  const browserRoots = ["app", "brands", "components"];
  const exposedFiles = [];

  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (fullPath.includes(`${path.sep}app${path.sep}api`)) continue;
        collect(fullPath);
      } else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name)) {
        exposedFiles.push(fullPath);
      }
    }
  }

  for (const directory of browserRoots) collect(path.join(root, directory));
  const exposedSource = exposedFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const serverConfig = fs.readFileSync(
    path.join(root, "server/legacy-booking/config.ts"),
    "utf8",
  );

  assert.doesNotMatch(exposedSource, /RACHIE_LEGACY_BOOKING_URL/);
  assert.doesNotMatch(exposedSource, /PEGGIE_LEGACY_BOOKING_URL/);
  assert.match(serverConfig, /import "server-only"/);
});
