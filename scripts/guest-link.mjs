import pg from "pg";
import { formatGuestLinkResult, GuestLinkOperatorError, manageGuestLink, parseGuestLinkArguments } from "../server/bootstrap/guest-link-operator.mjs";
import { resolveDatabaseUrl } from "../server/database/database-url.mjs";

let pool;
try {
  const options = parseGuestLinkArguments(process.argv.slice(2));
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) throw new GuestLinkOperatorError("database_configuration", "DATABASE_URL is not configured; no guest link was changed.");
  pool = new pg.Pool({ application_name: "rachie-peggie-guest-link-operator", connectionString: databaseUrl, max: 1 });
  process.stdout.write(formatGuestLinkResult(await manageGuestLink({ pool, ...options })));
} catch (error) {
  process.stderr.write(error instanceof GuestLinkOperatorError ? `${error.message}\n` : "Guest-link operation failed. The transaction was rolled back.\n");
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
