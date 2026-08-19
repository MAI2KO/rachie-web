import "server-only";

import { Pool, types } from "pg";

import { getDatabaseUrl } from "./config";
import { configurePostgresTypeParsers } from "./postgres-types.mjs";

configurePostgresTypeParsers(types);

export class DatabaseUnavailableError extends Error {
  constructor() {
    super("Native booking database is not configured.");
    this.name = "DatabaseUnavailableError";
  }
}

const globalDatabase = globalThis as typeof globalThis & {
  nativeBookingPool?: Pool;
};

export function getDatabasePool(): Pool | null {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) return null;

  if (!globalDatabase.nativeBookingPool) {
    globalDatabase.nativeBookingPool = new Pool({
      application_name: "rachie-peggie-web",
      connectionString: databaseUrl,
    });
  }

  return globalDatabase.nativeBookingPool;
}

export function requireDatabasePool(): Pool {
  const pool = getDatabasePool();
  if (!pool) throw new DatabaseUnavailableError();
  return pool;
}
