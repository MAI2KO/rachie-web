import { getDatabasePool } from "@/server/database/pool";
import { readinessResponse } from "@/server/health/readiness-core.mjs";

export async function GET(): Promise<Response> {
  return readinessResponse(getDatabasePool);
}
