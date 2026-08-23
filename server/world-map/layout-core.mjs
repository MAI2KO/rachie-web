export const WORLD_MAP_NODE_WIDTH = 176;
export const WORLD_MAP_NODE_HEIGHT = 92;
export const WORLD_MAP_COLUMN_GAP = 72;
export const WORLD_MAP_ROW_GAP = 64;
export const WORLD_MAP_MIN_ZOOM = 0.24;
export const WORLD_MAP_MAX_ZOOM = 2.4;

function compareCommunityCodes(left, right) {
  const leftNumeric = /^\d+$/.test(left.code);
  const rightNumeric = /^\d+$/.test(right.code);
  if (leftNumeric && rightNumeric) {
    const difference = BigInt(left.code) - BigInt(right.code);
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  } else if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left.code.localeCompare(right.code, "en", { numeric: true });
}

export function communityPath(profile, code) {
  return `/${profile === "kingshot" ? "kingdom" : "state"}/${encodeURIComponent(code)}`;
}

export function sortWorldMapCommunities(communities) {
  return [...communities].sort((left, right) =>
    compareCommunityCodes(left, right)
    || left.displayName.localeCompare(right.displayName, "en"));
}

export function buildWorldMapLayout(communities) {
  const ordered = sortWorldMapCommunities(communities);
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const stepX = WORLD_MAP_NODE_WIDTH + WORLD_MAP_COLUMN_GAP;
  const stepY = WORLD_MAP_NODE_HEIGHT + WORLD_MAP_ROW_GAP;
  const nodes = ordered.map((community, index) => ({
    ...community,
    column: index % columns,
    row: Math.floor(index / columns),
    x: (index % columns) * stepX,
    y: Math.floor(index / columns) * stepY,
  }));
  const connections = [];
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index + 1]?.row === nodes[index].row) {
      connections.push({ from: nodes[index], to: nodes[index + 1] });
    }
    if (nodes[index + columns]) {
      connections.push({ from: nodes[index], to: nodes[index + columns] });
    }
  }
  const last = nodes.at(-1);
  const bounds = nodes.length === 0
    ? { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
    : {
      minX: -WORLD_MAP_NODE_WIDTH / 2,
      minY: -WORLD_MAP_NODE_HEIGHT / 2,
      maxX: Math.min(columns - 1, nodes.length - 1) * stepX + WORLD_MAP_NODE_WIDTH / 2,
      maxY: last.row * stepY + WORLD_MAP_NODE_HEIGHT / 2,
      width: Math.min(columns, nodes.length) * WORLD_MAP_NODE_WIDTH
        + Math.max(0, Math.min(columns, nodes.length) - 1) * WORLD_MAP_COLUMN_GAP,
      height: (last.row + 1) * WORLD_MAP_NODE_HEIGHT + last.row * WORLD_MAP_ROW_GAP,
    };
  return Object.freeze({ columns, nodes, connections, bounds });
}

export function clampZoom(value) {
  return Math.min(WORLD_MAP_MAX_ZOOM, Math.max(WORLD_MAP_MIN_ZOOM, value));
}

export function initialWorldMapCamera(bounds, viewport) {
  if (!bounds.width || !bounds.height || !viewport.width || !viewport.height) {
    return { x: 0, y: 0, zoom: 1 };
  }
  const availableWidth = Math.max(1, viewport.width - 96);
  const availableHeight = Math.max(1, viewport.height - 96);
  const zoom = clampZoom(Math.min(1, availableWidth / bounds.width, availableHeight / bounds.height));
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    zoom,
  };
}

export function clampWorldMapCamera(camera, bounds, viewport) {
  if (!bounds.width || !bounds.height) return camera;
  const visibleWidth = viewport.width / camera.zoom;
  const visibleHeight = viewport.height / camera.zoom;
  const x = visibleWidth >= bounds.width + 160
    ? (bounds.minX + bounds.maxX) / 2
    : Math.min(bounds.maxX, Math.max(bounds.minX, camera.x));
  const y = visibleHeight >= bounds.height + 160
    ? (bounds.minY + bounds.maxY) / 2
    : Math.min(bounds.maxY, Math.max(bounds.minY, camera.y));
  return { ...camera, x, y };
}

export function screenToWorld(point, camera, viewport) {
  return {
    x: (point.x - viewport.width / 2) / camera.zoom + camera.x,
    y: (point.y - viewport.height / 2) / camera.zoom + camera.y,
  };
}

export function hitTestWorldMap(nodes, point, camera, viewport) {
  const world = screenToWorld(point, camera, viewport);
  return nodes.find((node) =>
    Math.abs(world.x - node.x) <= WORLD_MAP_NODE_WIDTH / 2
    && Math.abs(world.y - node.y) <= WORLD_MAP_NODE_HEIGHT / 2) ?? null;
}

export function findWorldMapCommunity(communities, rawCode) {
  const code = String(rawCode ?? "").trim();
  if (!/^\d+$/.test(code)) return null;
  return communities.find((community) => community.code === code) ?? null;
}
