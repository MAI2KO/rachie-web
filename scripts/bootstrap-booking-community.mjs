import { readFile } from "node:fs/promises";

import pg from "pg";

import {
  assertBookingBootstrapSafety,
  BookingBootstrapError,
  formatBookingBootstrapSummary,
  runBookingCommunityBootstrap,
  validateBookingBootstrapConfig,
} from "../server/bootstrap/booking-community-bootstrap.mjs";
import { resolveDatabaseUrl } from "../server/database/database-url.mjs";

function parseArguments(argv) {
  let configPath = null;
  let dryRun = false;
  let confirmRemote = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      configPath = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--confirm-remote-bootstrap") {
      confirmRemote = true;
    } else {
      throw new BookingBootstrapError("invalid_arguments", `Unknown argument: ${argument}`);
    }
  }
  if (!configPath || configPath.startsWith("--")) {
    throw new BookingBootstrapError("invalid_arguments", "Usage: npm run db:bootstrap -- --config <reviewed.json> [--dry-run] [--confirm-remote-bootstrap]");
  }
  return { configPath, dryRun, confirmRemote };
}

async function loadConfig(configPath) {
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    throw new BookingBootstrapError("config_read", `Could not read bootstrap configuration: ${configPath}`);
  }
  try {
    return validateBookingBootstrapConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new BookingBootstrapError("invalid_config", "Bootstrap configuration is not valid JSON.");
    throw error;
  }
}

let pool;
try {
  const options = parseArguments(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  const databaseUrl = resolveDatabaseUrl();
  assertBookingBootstrapSafety(databaseUrl, { confirmRemote: options.confirmRemote });
  pool = new pg.Pool({
    application_name: "rachie-peggie-booking-bootstrap",
    connectionString: databaseUrl,
    max: 1,
  });
  const plan = await runBookingCommunityBootstrap({ pool, config, dryRun: options.dryRun });
  process.stdout.write(formatBookingBootstrapSummary(plan, { dryRun: options.dryRun }));
  if (plan.conflicts.length) process.exitCode = 1;
} catch (error) {
  if (error instanceof BookingBootstrapError) {
    process.stderr.write(`${error.message}\n`);
    for (const detail of error.details) process.stderr.write(`- ${detail}\n`);
  } else {
    process.stderr.write("Bootstrap failed during a database operation. No configuration was committed.\n");
  }
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
