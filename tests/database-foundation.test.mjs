import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveDatabaseUrl } from "../server/database/database-url.mjs";
import {
  loadMigrations,
  MIGRATION_LOCK_KEY,
  runMigrations,
} from "../server/database/migrations.mjs";
import {
  configurePostgresTypeParsers,
  POSTGRES_DATE_OID,
} from "../server/database/postgres-types.mjs";
import {
  createProfileScopedBookingRepository,
} from "../server/native-booking/repository-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(root, "db/migrations");

function createFakeMigrationPool() {
  const state = {
    applied: new Map(),
    migrationExecutions: 0,
    rollbacks: 0,
    locked: false,
    waiters: [],
  };

  async function acquireLock() {
    if (!state.locked) {
      state.locked = true;
      return;
    }
    await new Promise((resolve) => state.waiters.push(resolve));
    state.locked = true;
  }

  function releaseLock() {
    state.locked = false;
    state.waiters.shift()?.();
  }

  return {
    state,
    async connect() {
      let pendingMigration = null;

      return {
        async query(sql, parameters = []) {
          const normalized = sql.trim();
          if (normalized.startsWith("SELECT pg_advisory_lock")) {
            assert.deepEqual(parameters, [MIGRATION_LOCK_KEY]);
            await acquireLock();
            return { rows: [] };
          }
          if (normalized.startsWith("SELECT pg_advisory_unlock")) {
            releaseLock();
            return { rows: [] };
          }
          if (normalized.startsWith("CREATE TABLE IF NOT EXISTS")) {
            return { rows: [] };
          }
          if (normalized.startsWith("SELECT version, name, checksum")) {
            return { rows: [...state.applied.values()] };
          }
          if (normalized === "BEGIN" || normalized === "COMMIT") {
            if (normalized === "COMMIT" && pendingMigration) {
              state.applied.set(pendingMigration.version, pendingMigration);
              pendingMigration = null;
            }
            return { rows: [] };
          }
          if (normalized === "ROLLBACK") {
            state.rollbacks += 1;
            pendingMigration = null;
            return { rows: [] };
          }
          if (normalized.startsWith("INSERT INTO app_schema_migrations")) {
            pendingMigration = {
              version: parameters[0],
              name: parameters[1],
              checksum: parameters[2],
            };
            return { rows: [] };
          }
          if (normalized === "FAIL MIGRATION") {
            throw new Error("migration failed");
          }

          state.migrationExecutions += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

function createRepositoryPool() {
  const calls = [];
  let failLookup = false;

  return {
    calls,
    setFailLookup(value) {
      failLookup = value;
    },
    async connect() {
      return {
        async query(sql, parameters = []) {
          calls.push({ sql: sql.trim(), parameters });
          if (sql.includes("FROM booking_communities") && failLookup) {
            throw new Error("lookup failed");
          }
          return { rows: [] };
        },
        release() {
          calls.push({ sql: "RELEASE", parameters: [] });
        },
      };
    },
  };
}

test("DATABASE_URL is optional and whitespace-safe", () => {
  assert.equal(resolveDatabaseUrl({}), null);
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: "   " }), null);
  assert.equal(
    resolveDatabaseUrl({ DATABASE_URL: " postgres://localhost/booking " }),
    "postgres://localhost/booking",
  );
});

test("PostgreSQL date values remain date-only strings", () => {
  const parsers = new Map();
  configurePostgresTypeParsers({
    setTypeParser(oid, parser) {
      parsers.set(oid, parser);
    },
  });

  assert.equal(parsers.get(POSTGRES_DATE_OID)("2026-08-20"), "2026-08-20");
});

test("database configuration is absent from browser-exposed source", () => {
  const exposedRoots = ["app", "brands", "components"];
  const exposedFiles = [];

  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (fullPath.includes(`${path.sep}app${path.sep}api`)) continue;
        collect(fullPath);
      } else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name)) {
        exposedFiles.push(fullPath);
      }
    }
  }

  for (const directory of exposedRoots) collect(path.join(root, directory));
  const exposedSource = exposedFiles
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const serverConfig = fs.readFileSync(
    path.join(root, "server/database/config.ts"),
    "utf8",
  );

  assert.doesNotMatch(exposedSource, /DATABASE_URL/);
  assert.match(serverConfig, /import "server-only"/);
});

test("migration files are ordered and checksummed", async () => {
  const migrations = await loadMigrations(migrationsDirectory);

  assert.deepEqual(
    migrations.map(({ version, name }) => ({ version, name })),
    [
      { version: "0001", name: "native_booking_schema" },
      { version: "0002", name: "discord_auth_foundation" },
    ],
  );
  assert.ok(migrations.every(({ checksum }) => /^[0-9a-f]{64}$/.test(checksum)));
});

test("migration re-runs are safe and concurrent runners serialize", async () => {
  const pool = createFakeMigrationPool();
  const migration = {
    version: "0001",
    name: "test",
    checksum: "a".repeat(64),
    sql: "SELECT 1",
  };
  const results = await Promise.all([
    runMigrations(pool, [migration]),
    runMigrations(pool, [migration]),
  ]);

  assert.equal(pool.state.migrationExecutions, 1);
  assert.equal(results.flatMap((result) => result.applied).length, 1);
  assert.deepEqual((await runMigrations(pool, [migration])).applied, []);
});

test("applied migration changes and missing files are rejected", async () => {
  const pool = createFakeMigrationPool();
  const migration = {
    version: "0001",
    name: "test",
    checksum: "a".repeat(64),
    sql: "SELECT 1",
  };
  await runMigrations(pool, [migration]);

  await assert.rejects(
    runMigrations(pool, [{ ...migration, checksum: "b".repeat(64) }]),
    /has been modified/,
  );
  await assert.rejects(runMigrations(pool, []), /missing from this deployment/);
});

test("failed migrations roll back and are not tracked", async () => {
  const pool = createFakeMigrationPool();

  await assert.rejects(
    runMigrations(pool, [
      {
        version: "0001",
        name: "failure",
        checksum: "a".repeat(64),
        sql: "FAIL MIGRATION",
      },
    ]),
    /migration failed/,
  );

  assert.equal(pool.state.rollbacks, 1);
  assert.equal(pool.state.applied.size, 0);
});

test("repositories bind every transaction and lookup to one profile", async () => {
  const pool = createRepositoryPool();
  const repository = createProfileScopedBookingRepository("wos", pool);

  await repository.findCommunityById("kingshot-record-id");

  assert.deepEqual(pool.calls[0], { sql: "BEGIN", parameters: [] });
  assert.match(pool.calls[1].sql, /set_config\('app\.game_profile'/);
  assert.deepEqual(pool.calls[1].parameters, ["wos"]);
  assert.match(pool.calls[2].sql, /game_profile = \$1/);
  assert.deepEqual(pool.calls[2].parameters, ["wos", "kingshot-record-id"]);
  assert.equal(pool.calls[3].sql, "COMMIT");

  const kingshotPool = createRepositoryPool();
  const kingshotRepository = createProfileScopedBookingRepository(
    "kingshot",
    kingshotPool,
  );
  await kingshotRepository.findCommunityByLocationCode("1234");
  assert.deepEqual(kingshotPool.calls[1].parameters, ["kingshot"]);
  assert.deepEqual(kingshotPool.calls[2].parameters, ["kingshot", "1234"]);
});

test("repository transactions roll back and reject unsupported profiles", async () => {
  const pool = createRepositoryPool();
  const repository = createProfileScopedBookingRepository("wos", pool);
  pool.setFailLookup(true);

  await assert.rejects(repository.findCommunityById("id"), /lookup failed/);
  assert.equal(pool.calls.at(-2).sql, "ROLLBACK");
  assert.equal(pool.calls.at(-1).sql, "RELEASE");
  assert.throws(
    () => createProfileScopedBookingRepository("untrusted", pool),
    /Unsupported native booking game profile/,
  );
});

test("initial schema encodes the native isolation and collision rules", () => {
  const schema = fs.readFileSync(
    path.join(migrationsDirectory, "0001_native_booking_schema.sql"),
    "utf8",
  );
  const requiredTables = [
    "booking_communities",
    "booking_discord_guilds",
    "booking_settings",
    "booking_windows",
    "minister_services",
    "booking_service_dates",
    "appointment_slots",
    "booking_slot_blocks",
    "booking_participants",
    "minister_bookings",
    "booking_requirement_answers",
    "booking_change_events",
    "booking_outbox",
    "booking_idempotency_keys",
  ];

  for (const table of requiredTables) {
    assert.match(schema, new RegExp(`CREATE TABLE ${table} \\(`));
    assert.match(schema, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
  }

  assert.match(schema, /booking_date date NOT NULL/);
  assert.match(schema, /local_start_time time without time zone/);
  assert.match(schema, /time_zone text/);
  assert.match(schema, /minister_bookings_one_active_per_slot/);
  assert.match(schema, /minister_bookings_one_active_player_service/);
  assert.match(schema, /booking_participants_one_active_discord_registration/);
  assert.match(schema, /FOREIGN KEY \(game_profile, community_id\)/);
  assert.doesNotMatch(schema, /join_password text/);
  assert.doesNotMatch(schema, /service_credential/);
});
