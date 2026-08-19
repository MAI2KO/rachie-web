import { fileURLToPath } from "node:url";

import pg from "pg";

import { resolveDatabaseUrl } from "../server/database/database-url.mjs";
import {
  loadMigrations,
  runMigrations,
} from "../server/database/migrations.mjs";

const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is not configured; no migrations ran.\n");
  process.exitCode = 1;
} else {
  const migrationsDirectory = fileURLToPath(
    new URL("../db/migrations/", import.meta.url),
  );
  const pool = new pg.Pool({
    application_name: "rachie-peggie-web-migrations",
    connectionString: databaseUrl,
  });

  try {
    const migrations = await loadMigrations(migrationsDirectory);
    const result = await runMigrations(pool, migrations);
    process.stdout.write(
      result.applied.length === 0
        ? "Database schema is already current.\n"
        : `Applied migrations: ${result.applied.join(", ")}\n`,
    );
  } finally {
    await pool.end();
  }
}
