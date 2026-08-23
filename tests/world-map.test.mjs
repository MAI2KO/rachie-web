import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import {
  buildWorldMapLayout,
  clampWorldMapCamera,
  clampZoom,
  communityPath,
  findWorldMapCommunity,
  hitTestWorldMap,
  initialWorldMapCamera,
  panWorldMapCamera,
  pointerMovedBeyondDragThreshold,
  pointerNavigationTarget,
  screenToWorld,
  worldMapPanBounds,
  WORLD_MAP_MAX_ZOOM,
  WORLD_MAP_MIN_ZOOM,
} from "../server/world-map/layout-core.mjs";
import { createProfileScopedWorldMapRepository } from "../server/world-map/repository-core.mjs";
import { handlePublicWorldMapCore, publicWorldMapCommunities } from "../server/world-map/read-core.mjs";

const databaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();

const rows = [
  { location_code: "10002", display_name: "Ten Thousand Two" },
  { location_code: "7", display_name: "Seven" },
  { location_code: "9999", display_name: "Test Server" },
];

test("world-map public model has stable numeric ordering, correct routes, and no private fields", () => {
  const wos = publicWorldMapCommunities("wos", rows);
  const kingshot = publicWorldMapCommunities("kingshot", rows);
  assert.deepEqual(wos.map((item) => item.code), ["7", "9999", "10002"]);
  assert.deepEqual(wos[1], { code: "9999", displayName: "Test Server", href: "/state/9999" });
  assert.deepEqual(kingshot[1], { code: "9999", displayName: "Test Server", href: "/kingdom/9999" });
  assert.deepEqual(Object.keys(wos[0]).sort(), ["code", "displayName", "href"]);
  assert.equal(communityPath("wos", "9999"), "/state/9999");
  assert.equal(communityPath("kingshot", "9999"), "/kingdom/9999");
});

test("anonymous world-map API uses hostname profile and ignores profile query overrides", async () => {
  const seen = [];
  const dependencies = {
    resolveRequestContext(request) {
      return { gameProfile: request.headers.get("host") === "peggie.test" ? "kingshot" : "wos" };
    },
    async listCommunities(profile) {
      seen.push(profile);
      return publicWorldMapCommunities(profile, [{ location_code: "9999", display_name: `${profile} server` }]);
    },
  };
  const wos = await handlePublicWorldMapCore(
    new Request("https://rachie.test/api/v1/world-map?profile=kingshot", { headers: { host: "rachie.test" } }),
    dependencies,
  );
  const kingshot = await handlePublicWorldMapCore(
    new Request("https://peggie.test/api/v1/world-map?profile=wos", { headers: { host: "peggie.test" } }),
    dependencies,
  );
  assert.equal(wos.status, 200);
  assert.equal(kingshot.status, 200);
  assert.deepEqual(seen, ["wos", "kingshot"]);
  assert.equal((await wos.json()).communities[0].href, "/state/9999");
  assert.equal((await kingshot.json()).communities[0].href, "/kingdom/9999");
});

test("unknown host is not a public profile", async () => {
  const response = await handlePublicWorldMapCore(new Request("https://unknown.test/api/v1/world-map"), {
    resolveRequestContext: () => null,
    listCommunities: async () => { throw new Error("must not run"); },
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "not_found");
});

test("registered-community repository uses active authoritative rows in a profile-scoped read-only transaction", async () => {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes("FROM booking_communities")) return { rows };
      return { rows: [] };
    },
    release() { calls.push({ sql: "release" }); },
  };
  const repository = createProfileScopedWorldMapRepository("wos", { connect: async () => client });
  assert.deepEqual(await repository.listRegisteredCommunities(), rows);
  assert.equal(calls[0].sql, "BEGIN READ ONLY");
  assert.deepEqual(calls[1].parameters, ["wos"]);
  assert.match(calls[2].sql, /game_profile=\$1 AND status='active'/);
  assert.deepEqual(calls[2].parameters, ["wos"]);
  assert.equal(calls[3].sql, "COMMIT");
  assert.throws(() => createProfileScopedWorldMapRepository("other", {}), /Unsupported/);
});

test("deterministic compact grid and neighbour connections scale to a large set", () => {
  const communities = Array.from({ length: 2500 }, (_, index) => ({
    code: String(5000 - index), displayName: `Community ${index}`, href: `/state/${5000 - index}`,
  }));
  const first = buildWorldMapLayout(communities);
  const second = buildWorldMapLayout([...communities].reverse());
  assert.equal(first.columns, 50);
  assert.equal(first.nodes.length, 2500);
  assert.equal(first.connections.length, 4900);
  assert.deepEqual(first.nodes, second.nodes);
  assert.deepEqual(first.connections.map(({ from, to }) => [from.code, to.code]),
    second.connections.map(({ from, to }) => [from.code, to.code]));
  assert.equal(first.nodes[0].code, "2501");
  assert.deepEqual({ row: first.nodes[50].row, column: first.nodes[50].column }, { row: 1, column: 0 });
});

test("one-node initial fit stays centred while bounded empty-space pan remains visible", () => {
  const one = buildWorldMapLayout([{ code: "9999", displayName: "Test", href: "/state/9999" }]);
  const viewport = { width: 1000, height: 600 };
  const oneCamera = initialWorldMapCamera(one.bounds, viewport);
  assert.equal(oneCamera.zoom, 1);
  assert.deepEqual({ x: oneCamera.x, y: oneCamera.y }, { x: 0, y: 0 });

  const panned = panWorldMapCamera(oneCamera, { x: 500, y: 300 }, { x: 800, y: 500 },
    one.bounds, viewport);
  assert.deepEqual(panned, { x: -300, y: -200, zoom: 1 });
  const bounded = clampWorldMapCamera({ x: 99_999, y: -99_999, zoom: 1 }, one.bounds, viewport);
  assert.deepEqual(bounded, { x: 428, y: -250, zoom: 1 });
  const visibleEdge = screenToWorld({ x: 160, y: 504 }, bounded, viewport);
  assert.equal(visibleEdge.x, one.bounds.maxX);
  assert.equal(visibleEdge.y, one.bounds.minY);
});

test("small maps pan usefully while large maps retain a modest edge margin", () => {
  const small = buildWorldMapLayout(Array.from({ length: 4 }, (_, index) => ({
    code: String(1000 + index), displayName: `Small ${index}`, href: `/state/${1000 + index}`,
  })));
  const viewport = { width: 1000, height: 600 };
  const initial = initialWorldMapCamera(small.bounds, viewport);
  const panned = panWorldMapCamera(initial, { x: 500, y: 300 }, { x: 700, y: 400 },
    small.bounds, viewport);
  assert.notEqual(panned.x, initial.x);
  assert.notEqual(panned.y, initial.y);

  const large = buildWorldMapLayout(Array.from({ length: 2500 }, (_, index) => ({
    code: String(index + 1), displayName: `Large ${index}`, href: `/state/${index + 1}`,
  })));
  const bounds = worldMapPanBounds(large.bounds, viewport, 1);
  assert.ok(bounds.minX > large.bounds.minX);
  assert.ok(bounds.maxX < large.bounds.maxX);
  const clamped = clampWorldMapCamera({ x: -99_999, y: 99_999, zoom: 1 }, large.bounds, viewport);
  assert.equal(clamped.x, bounds.minX);
  assert.equal(clamped.y, bounds.maxY);
});

test("zoom recalculates pan bounds while fit and zoom limits remain stable", () => {
  const one = buildWorldMapLayout([{ code: "9999", displayName: "Test", href: "/state/9999" }]);
  const viewport = { width: 1000, height: 600 };
  const zoomedOut = worldMapPanBounds(one.bounds, viewport, 0.5);
  const zoomedIn = worldMapPanBounds(one.bounds, viewport, 2);
  assert.ok(zoomedOut.minX < zoomedIn.minX);
  assert.ok(zoomedOut.maxX > zoomedIn.maxX);
  assert.equal(clampWorldMapCamera({ x: 9999, y: 0, zoom: 2 }, one.bounds, viewport).x,
    zoomedIn.maxX);

  const several = buildWorldMapLayout(publicWorldMapCommunities("wos", rows));
  const fitted = initialWorldMapCamera(several.bounds, { width: 420, height: 300 });
  assert.equal(fitted.x, (several.bounds.minX + several.bounds.maxX) / 2);
  assert.equal(fitted.y, (several.bounds.minY + several.bounds.maxY) / 2);
  assert.ok(fitted.zoom >= WORLD_MAP_MIN_ZOOM && fitted.zoom <= 1);
  assert.equal(clampZoom(0.001), WORLD_MAP_MIN_ZOOM);
  assert.equal(clampZoom(99), WORLD_MAP_MAX_ZOOM);
});

test("pointer down/move/up distinguishes drag from node click navigation", () => {
  const one = buildWorldMapLayout([{ code: "9999", displayName: "Test", href: "/state/9999" }]);
  const viewport = { width: 1000, height: 600 };
  const camera = initialWorldMapCamera(one.bounds, viewport);
  const pointerDown = { x: 500, y: 300 };
  const pointerMove = { x: 530, y: 320 };
  const dragged = pointerMovedBeyondDragThreshold(pointerDown, pointerMove);
  const movedCamera = panWorldMapCamera(camera, pointerDown, pointerMove, one.bounds, viewport);
  assert.equal(dragged, true);
  assert.notDeepEqual(movedCamera, camera);
  assert.equal(pointerNavigationTarget({ wasSinglePointer: true, dragged, node: one.nodes[0] }), null);

  const tapEnd = { x: 503, y: 302 };
  const tapDragged = pointerMovedBeyondDragThreshold(pointerDown, tapEnd);
  const tappedNode = hitTestWorldMap(one.nodes, tapEnd, camera, viewport);
  assert.equal(tapDragged, false);
  assert.equal(pointerNavigationTarget({ wasSinglePointer: true, dragged: tapDragged, node: tappedNode }),
    "/state/9999");
  assert.equal(pointerNavigationTarget({ wasSinglePointer: false, dragged: false, node: tappedNode }), null);
});

test("State and Kingdom search locates exact registered codes and node hit testing opens public boards", () => {
  const communities = publicWorldMapCommunities("wos", rows);
  const layout = buildWorldMapLayout(communities);
  assert.equal(findWorldMapCommunity(communities, "9999")?.displayName, "Test Server");
  assert.equal(findWorldMapCommunity(communities, "1234"), null);
  assert.equal(findWorldMapCommunity(communities, "player name"), null);
  const target = layout.nodes.find((node) => node.code === "9999");
  const hit = hitTestWorldMap(layout.nodes, { x: 400, y: 300 },
    { x: target.x, y: target.y, zoom: 1 }, { width: 800, height: 600 });
  assert.equal(hit.href, "/state/9999");
});

test("world-map UI provides profile terminology, empty states, Pointer Events, search, and accessible links", async () => {
  const source = await readFile(new URL("../components/world-map/world-map.tsx", import.meta.url), "utf8");
  const navigation = await readFile(new URL("../components/site-navigation.tsx", import.meta.url), "utf8");
  assert.match(source, /profile === "kingshot" \? "Kingdom" : "State"/);
  assert.match(source, /No \{noun\}s are registered yet\./);
  assert.match(source, /onPointerDown=\{onPointerDown\}/);
  assert.match(source, /onPointerMove=\{onPointerMove\}/);
  assert.match(source, /onPointerUp=\{finishPointer\}/);
  assert.match(source, /pointersRef\.current\.size === 2/);
  assert.match(source, /pointerMovedBeyondDragThreshold\(origin, next\)/);
  assert.match(source, /pointerNavigationTarget/);
  assert.match(source, /role="search"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /Browse all registered \{noun\}s/);
  assert.match(source, /<Link href=\{community\.href\}>/);
  assert.match(source, /is not currently registered/);
  assert.match(navigation, /href: "\/world", label: "World"/);
});

test("PostgreSQL world-map reads include only active communities and isolate identical codes by profile",
  { skip: !databaseUrl && "TEST_DATABASE_URL is not configured" }, async () => {
    const schema = `world_map_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    try {
      await runMigrations(pool, await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url))));
      for (const [profile, name] of [["wos", "WOS Test"], ["kingshot", "Kingshot Test"]]) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.game_profile',$1,true)", [profile]);
          await client.query(
            `INSERT INTO booking_communities (game_profile,id,location_code,display_name,status)
             VALUES ($1,$2,'9999',$3,'active'),($1,$4,'8888','Archived','archived')`,
            [profile, randomUUID(), name, randomUUID()],
          );
          await client.query("COMMIT");
        } finally { client.release(); }
      }
      const wos = await createProfileScopedWorldMapRepository("wos", pool).listRegisteredCommunities();
      const kingshot = await createProfileScopedWorldMapRepository("kingshot", pool).listRegisteredCommunities();
      assert.deepEqual(wos, [{ location_code: "9999", display_name: "WOS Test" }]);
      assert.deepEqual(kingshot, [{ location_code: "9999", display_name: "Kingshot Test" }]);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
