import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const MIGRATION_LOCK_KEY = "5808457531528991";

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrations(directory) {
  const fileNames = (await readdir(directory))
    .filter((fileName) => MIGRATION_FILE_PATTERN.test(fileName))
    .sort();
  const versions = new Set();

  return Promise.all(
    fileNames.map(async (fileName) => {
      const match = fileName.match(MIGRATION_FILE_PATTERN);
      const version = match[1];
      const name = match[2];

      if (versions.has(version)) {
        throw new Error(`Duplicate database migration version: ${version}`);
      }
      versions.add(version);

      const sql = await readFile(path.join(directory, fileName), "utf8");

      return Object.freeze({
        version,
        name,
        fileName,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      });
    }),
  );
}

export async function runMigrations(pool, migrations) {
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [
      MIGRATION_LOCK_KEY,
    ]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query(
      "SELECT version, name, checksum FROM app_schema_migrations",
    );
    const appliedByVersion = new Map(
      appliedResult.rows.map((migration) => [migration.version, migration]),
    );
    const availableVersions = new Set(
      migrations.map((migration) => migration.version),
    );

    for (const version of appliedByVersion.keys()) {
      if (!availableVersions.has(version)) {
        throw new Error(
          `Applied migration ${version} is missing from this deployment.`,
        );
      }
    }

    const appliedNow = [];

    for (const migration of migrations) {
      const applied = appliedByVersion.get(migration.version);
      if (applied) {
        if (
          applied.name !== migration.name ||
          applied.checksum !== migration.checksum
        ) {
          throw new Error(
            `Applied migration ${migration.version} has been modified.`,
          );
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO app_schema_migrations (version, name, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        appliedNow.push(migration.version);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return Object.freeze({ applied: appliedNow });
  } finally {
    if (lockAcquired) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [
        MIGRATION_LOCK_KEY,
      ]);
    }
    client.release();
  }
}
