export async function handlePublicAllianceEventsCore(request, rawCommunityCode, dependencies) {
  const context = dependencies.resolveRequestContext(request);
  if (!context) {
    return Response.json({ ok: false, code: "not_found", error: "Community was not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const result = await dependencies.readCommunity(context.gameProfile, rawCommunityCode);
    if (!result) {
      return Response.json({ ok: false, code: "not_found", error: "Community was not found." },
        { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (result.availability !== "available") {
      return Response.json({ ok: false, code: "scheduler_unavailable",
        error: "Alliance event schedules are temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({
      ok: true,
      profile: context.gameProfile,
      community: {
        code: result.community.location_code,
        displayName: result.community.display_name,
      },
      alliances: result.alliances,
    }, { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" } });
  } catch {
    return Response.json({ ok: false, code: "unavailable",
      error: "Alliance event schedules are temporarily unavailable." },
    { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
