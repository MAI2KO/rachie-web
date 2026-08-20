const HEADERS = Object.freeze({ "Cache-Control": "no-store" });

export async function readinessResponse(createDatabasePool) {
  try {
    const pool = createDatabasePool();
    if (!pool) throw new Error("Database is not configured.");
    await pool.query("SELECT 1");
    return Response.json({ ok: true }, { headers: HEADERS });
  } catch {
    return Response.json(
      { ok: false },
      { status: 503, headers: HEADERS },
    );
  }
}
