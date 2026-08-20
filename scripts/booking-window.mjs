import pg from "pg";

import {
  BookingWindowOperatorError,
  formatBookingWindowResult,
  parseBookingWindowArguments,
  setCommunityBookingState,
} from "../server/bootstrap/booking-window-operator.mjs";
import { resolveDatabaseUrl } from "../server/database/database-url.mjs";

let pool;
try {
  const options = parseBookingWindowArguments(process.argv.slice(2));
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) {
    throw new BookingWindowOperatorError("database_configuration", "DATABASE_URL is not configured; booking state was not changed.");
  }
  pool = new pg.Pool({
    application_name: "rachie-peggie-booking-window-operator",
    connectionString: databaseUrl,
    max: 1,
  });
  const result = await setCommunityBookingState({ pool, ...options });
  process.stdout.write(formatBookingWindowResult(result));
} catch (error) {
  if (error instanceof BookingWindowOperatorError) process.stderr.write(`${error.message}\n`);
  else process.stderr.write("Booking-state change failed during a database operation. The transaction was rolled back.\n");
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
