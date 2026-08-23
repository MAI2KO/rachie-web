import { communityPath, sortWorldMapCommunities } from "./layout-core.mjs";

export function publicWorldMapCommunities(profile, rows) {
  return sortWorldMapCommunities(rows.map((row) => ({
    code: String(row.location_code),
    displayName: String(row.display_name),
    href: communityPath(profile, String(row.location_code)),
  })));
}

export async function handlePublicWorldMapCore(request, dependencies) {
  const context = dependencies.resolveRequestContext(request);
  if (!context) {
    return Response.json(
      { ok: false, error: "World map was not found.", code: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const communities = await dependencies.listCommunities(context.gameProfile);
    return Response.json(
      { ok: true, communities },
      { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=120" } },
    );
  } catch {
    return Response.json(
      { ok: false, error: "World map is unavailable.", code: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
