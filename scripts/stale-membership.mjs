import pg from "pg";

import {
  formatStaleMembershipResult,
  makeMembershipEvidenceStale,
  parseStaleMembershipArguments,
  StaleMembershipOperatorError,
} from "../server/bootstrap/stale-membership-operator.mjs";
import { resolveDatabaseUrl } from "../server/database/database-url.mjs";

let pool;
try {
  const options = parseStaleMembershipArguments(process.argv.slice(2));
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) {
    throw new StaleMembershipOperatorError(
      "database_configuration",
      "DATABASE_URL is not configured; membership evidence was not changed.",
    );
  }
  pool = new pg.Pool({
    application_name: "rachie-peggie-stale-membership-operator",
    connectionString: databaseUrl,
    max: 1,
  });
  const result = await makeMembershipEvidenceStale({ pool, ...options });
  process.stdout.write(formatStaleMembershipResult(result));
} catch (error) {
  if (error instanceof StaleMembershipOperatorError) process.stderr.write(`${error.message}\n`);
  else process.stderr.write("Membership-evidence change failed during a database operation. The transaction was rolled back.\n");
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
