import "server-only";

import { resolveDatabaseUrl } from "./database-url.mjs";

export function getDatabaseUrl(): string | null {
  return resolveDatabaseUrl(process.env);
}
