import { randomUUID } from "node:crypto";

import {
  generateGuestShareToken,
  guestShareTokenHint,
  hashGuestShareToken,
} from "../booking-approval/domain-core.mjs";

const PROFILES = new Set(["wos", "kingshot"]);
const ACTIONS = new Set(["create", "rotate", "revoke", "status"]);

export class GuestLinkOperatorError extends Error {
  constructor(code, message) { super(message); this.name = "GuestLinkOperatorError"; this.code = code; }
}

function usage(message) {
  throw new GuestLinkOperatorError("invalid_arguments", `${message}\nUsage: npm run db:guest-link -- --profile <wos|kingshot> --community <code> <--create|--rotate|--revoke|--status> [--base-url <https://host>]`);
}

function validateBaseUrl(value) {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
        || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error();
    return url.origin;
  } catch {
    usage("--base-url must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
}

export function parseGuestLinkArguments(argv) {
  let profile = null; let communityCode = null; let action = null; let baseUrl = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--profile", "--community", "--base-url"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage(`${argument} requires a value.`);
      if (argument === "--profile") { if (profile) usage("--profile may be supplied once."); profile = value; }
      if (argument === "--community") { if (communityCode) usage("--community may be supplied once."); communityCode = value; }
      if (argument === "--base-url") { if (baseUrl) usage("--base-url may be supplied once."); baseUrl = value; }
      index += 1;
    } else if (/^--(create|rotate|revoke|status)$/.test(argument)) {
      if (action) usage("Supply exactly one lifecycle action.");
      action = argument.slice(2);
    } else usage(`Unknown argument: ${argument}`);
  }
  if (!PROFILES.has(profile)) usage("--profile must be wos or kingshot.");
  if (typeof communityCode !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(communityCode)) usage("--community is invalid.");
  if (!ACTIONS.has(action)) usage("Supply exactly one of --create, --rotate, --revoke, or --status.");
  const normalizedBaseUrl = validateBaseUrl(baseUrl);
  if (["create", "rotate"].includes(action) && !normalizedBaseUrl) usage("--base-url is required for create and rotate so no hostname is inferred.");
  if (["revoke", "status"].includes(action) && normalizedBaseUrl) usage("--base-url is used only with create or rotate.");
  return Object.freeze({ profile, communityCode, action, baseUrl: normalizedBaseUrl });
}

async function requireOperator(client) {
  const row = (await client.query(`SELECT
    has_table_privilege(current_user,'app_schema_migrations','SELECT') AS ledger,
    has_table_privilege(current_user,'booking_guest_share_links','INSERT') AS can_insert,
    has_table_privilege(current_user,'booking_guest_share_links','UPDATE') AS can_update`)).rows[0];
  if (!row?.ledger || !row.can_insert || !row.can_update) {
    throw new GuestLinkOperatorError("insufficient_role", "Guest-link operation refused: DATABASE_URL must use the migration/operator role, not the website runtime role.");
  }
}

export async function manageGuestLink({ pool, profile, communityCode, action, baseUrl, now = () => new Date(), createId = randomUUID, createToken = generateGuestShareToken, injectFailure = false }) {
  if (!PROFILES.has(profile) || !ACTIONS.has(action)) throw new GuestLinkOperatorError("invalid_operation", "Guest-link operation is invalid.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireOperator(client);
    await client.query("SELECT set_config('app.game_profile',$1,true)", [profile]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`guest-link:${profile}:${communityCode}`]);
    const community = (await client.query(`SELECT id,display_name FROM booking_communities
      WHERE game_profile=$1 AND location_code=$2 AND status='active'`, [profile, communityCode])).rows[0];
    if (!community) throw new GuestLinkOperatorError("unknown_community", `No ${profile} community exists with code ${communityCode}.`);
    const current = (await client.query(`SELECT id,token_hint,created_at,expires_at,
        (expires_at IS NULL OR expires_at>transaction_timestamp()) AS is_active
      FROM booking_guest_share_links
      WHERE game_profile=$1 AND community_id=$2 AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [profile, community.id])).rows[0] ?? null;
    const active = current?.is_active ? current : null;

    let token = null; let changed = false; let link = active;
    if (action === "create" && active) throw new GuestLinkOperatorError("active_link_exists", "An active guest link already exists. Use --rotate to replace it.");
    if (action === "rotate" && !active) throw new GuestLinkOperatorError("missing_active_link", "No active guest link exists to rotate. Use --create.");
    if (action === "revoke" && active) {
      await client.query(`UPDATE booking_guest_share_links SET revoked_at=$3,revoked_by_actor_id='operator-cli',updated_at=$3
        WHERE game_profile=$1 AND id=$2`, [profile, active.id, now()]);
      changed = true; link = null;
    }
    if (["create", "rotate"].includes(action)) {
      const replaced = action === "rotate" ? active : current;
      if (replaced) await client.query(`UPDATE booking_guest_share_links SET revoked_at=$3,revoked_by_actor_id='operator-cli',updated_at=$3
        WHERE game_profile=$1 AND id=$2`, [profile, replaced.id, now()]);
      if (injectFailure) throw new Error("Injected guest-link failure.");
      token = createToken();
      link = (await client.query(`INSERT INTO booking_guest_share_links
        (game_profile,id,community_id,token_hash,token_hint,label,created_by_actor_id,rotated_from_link_id)
        VALUES ($1,$2,$3,$4,$5,'In-game guest booking link','operator-cli',$6)
        RETURNING id,token_hint,created_at,expires_at`,
      [profile, createId(), community.id, hashGuestShareToken(token), guestShareTokenHint(token), action === "rotate" ? active.id : null])).rows[0];
      changed = true;
    }
    await client.query("COMMIT");
    return Object.freeze({ profile, communityCode, displayName: community.display_name, action, changed, active: Boolean(link), tokenHint: link?.token_hint ?? null, createdAt: link?.created_at ?? null, token, url: token ? `${baseUrl}/book/${token}` : null });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  } finally { client.release(); }
}

export function formatGuestLinkResult(result) {
  const term = result.profile === "kingshot" ? "Kingdom" : "State";
  const lines = [`Profile: ${result.profile}`, `${term}: ${result.communityCode}`, `Guest link: ${result.active ? "active" : "inactive"}`];
  if (result.tokenHint) lines.push(`Token hint: ${result.tokenHint}…`);
  if (result.url) lines.push("Plaintext token: shown once; it cannot be recovered later.", `Guest URL: ${result.url}`);
  lines.push(`Result: ${result.changed ? result.action === "revoke" ? "revoked" : result.action === "rotate" ? "rotated" : "created" : "no change"}`, "");
  return lines.join("\n");
}
