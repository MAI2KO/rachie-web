const PROFILES = new Set(["wos", "kingshot"]);

export class BookingWindowOperatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BookingWindowOperatorError";
    this.code = code;
  }
}

function invalidArguments(message) {
  throw new BookingWindowOperatorError(
    "invalid_arguments",
    `${message}\nUsage: npm run db:booking-window -- --profile <wos|kingshot> --community <code> <--open|--close>`,
  );
}

export function parseBookingWindowArguments(argv) {
  let profile = null;
  let communityCode = null;
  let open = false;
  let close = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      if (profile !== null) invalidArguments("--profile may be supplied only once.");
      profile = argv[index + 1] ?? null;
      if (!profile || profile.startsWith("--")) invalidArguments("--profile requires wos or kingshot.");
      index += 1;
    } else if (argument === "--community") {
      if (communityCode !== null) invalidArguments("--community may be supplied only once.");
      communityCode = argv[index + 1] ?? null;
      if (!communityCode || communityCode.startsWith("--")) invalidArguments("--community requires a community code.");
      index += 1;
    } else if (argument === "--open") {
      open = true;
    } else if (argument === "--close") {
      close = true;
    } else {
      invalidArguments(`Unknown argument: ${argument}`);
    }
  }

  if (!PROFILES.has(profile)) invalidArguments("--profile must be wos or kingshot.");
  if (typeof communityCode !== "string" || communityCode.length > 32
      || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(communityCode)) {
    invalidArguments("--community must contain 1-32 letters, digits, hyphens, or underscores.");
  }
  if (open === close) invalidArguments("Supply exactly one of --open or --close.");

  return Object.freeze({ profile, communityCode, open });
}

async function checkOperatorRole(client) {
  const result = await client.query(
    `SELECT table_name,
            has_table_privilege(current_user, table_name, 'UPDATE') AS can_update
     FROM unnest($1::text[]) AS table_name`,
    [["booking_communities", "booking_windows"]],
  );
  if (result.rows.some((row) => !row.can_update)) {
    throw new BookingWindowOperatorError(
      "insufficient_role",
      "Booking-state change refused: DATABASE_URL must use the migration/operator role, not the website runtime role.",
    );
  }
}

function resolvedState(communityOpen, windowStatus) {
  if (communityOpen && windowStatus === "open") return "open";
  if (!communityOpen && windowStatus === "closed") return "closed";
  return "inconsistent";
}

export async function setCommunityBookingState({
  pool,
  profile,
  communityCode,
  open,
  injectFailureAfterCommunityUpdate = false,
}) {
  if (!PROFILES.has(profile)) throw new BookingWindowOperatorError("invalid_profile", "Profile must be wos or kingshot.");
  if (typeof communityCode !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(communityCode)) {
    throw new BookingWindowOperatorError("invalid_community", "Community code is invalid.");
  }
  if (typeof open !== "boolean") throw new BookingWindowOperatorError("invalid_state", "Booking state must be open or closed.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await checkOperatorRole(client);
    await client.query("SELECT set_config('app.game_profile', $1, true)", [profile]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`booking-window:${profile}:${communityCode}`]);

    const community = (await client.query(
      `SELECT id, bookings_open
       FROM booking_communities
       WHERE game_profile=$1 AND location_code=$2
       FOR UPDATE`,
      [profile, communityCode],
    )).rows[0];
    if (!community) {
      throw new BookingWindowOperatorError("unknown_community", `No ${profile} community exists with code ${communityCode}.`);
    }

    const window = (await client.query(
      `SELECT id, status
       FROM booking_windows
       WHERE game_profile=$1 AND community_id=$2 AND status IN ('open', 'closed')
       ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END,
                COALESCE(opened_at, created_at) DESC,
                id
       LIMIT 1
       FOR UPDATE`,
      [profile, community.id],
    )).rows[0];
    if (!window) {
      throw new BookingWindowOperatorError("missing_window", `Community ${communityCode} has no open or closed booking window to update.`);
    }

    const previousState = resolvedState(community.bookings_open, window.status);
    const desiredState = open ? "open" : "closed";
    if (previousState === desiredState) {
      await client.query("COMMIT");
      return Object.freeze({ profile, communityCode, previousState, desiredState, changed: false });
    }

    if (community.bookings_open !== open) {
      await client.query(
        `UPDATE booking_communities
         SET bookings_open=$3, version=version+1, updated_at=now()
         WHERE game_profile=$1 AND id=$2`,
        [profile, community.id, open],
      );
    }
    if (injectFailureAfterCommunityUpdate) throw new Error("Injected booking-window failure.");

    if (window.status !== desiredState) {
      await client.query(
        `UPDATE booking_windows
         SET status=$3,
             opened_at=CASE WHEN $3='open' THEN COALESCE(opened_at,now()) ELSE opened_at END,
             closed_at=CASE WHEN $3='closed' THEN now() ELSE NULL END,
             version=version+1,
             updated_at=now()
         WHERE game_profile=$1 AND id=$2`,
        [profile, window.id, desiredState],
      );
    }

    await client.query("COMMIT");
    return Object.freeze({ profile, communityCode, previousState, desiredState, changed: true });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export function formatBookingWindowResult(result) {
  return [
    `Profile: ${result.profile}`,
    `Community: ${result.communityCode}`,
    `Booking state: ${result.changed ? `${result.previousState} -> ${result.desiredState}` : `already ${result.desiredState}`}`,
    `Result: ${result.changed ? "updated" : "no change"}`,
    "",
  ].join("\n");
}
