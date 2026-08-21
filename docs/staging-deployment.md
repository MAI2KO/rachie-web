# First staging deployment

This guide prepares the shared R.A.C.H.I.E/P.E.G.G.I.E service for staging. It
does not authorize a Railway, DNS, Discord, or production change.

## Hosts and OAuth redirects

Use one stateless web service and an isolated PostgreSQL service in a dedicated
Railway staging environment. Prefer staging-specific credentials. If the two
existing Discord applications/bots are reused, their staging and production
redirects must coexist and the shared credential becomes a cross-environment
dependency that should be recorded explicitly.

| Environment | R.A.C.H.I.E | P.E.G.G.I.E |
| --- | --- | --- |
| Local | `localhost:3000` | `peggie.localhost:3000` |
| Staging | `staging.r-a-c-h-i-e.com` | `peggie-staging.r-a-c-h-i-e.com` |
| Production | `r-a-c-h-i-e.com` | `peggie.r-a-c-h-i-e.com` |

Both staging names are explicit application authorities. A generated Railway
hostname is suitable for `/api/health`, but not for OAuth/authenticated booking:
unknown auth hosts fail closed. Attach both custom names to the same service.

Register these exact callbacks only on the matching Discord application:

| Environment | Application | Exact callback |
| --- | --- | --- |
| Staging | R.A.C.H.I.E | `https://staging.r-a-c-h-i-e.com/api/v1/auth/callback` |
| Staging | P.E.G.G.I.E | `https://peggie-staging.r-a-c-h-i-e.com/api/v1/auth/callback` |
| Production | R.A.C.H.I.E | `https://r-a-c-h-i-e.com/api/v1/auth/callback` |
| Production | P.E.G.G.I.E | `https://peggie.r-a-c-h-i-e.com/api/v1/auth/callback` |

The environment value and Developer Portal value must match exactly, including
scheme, hostname, path, and absence of a trailing slash.

## Environment-variable matrix

There are no browser `NEXT_PUBLIC_*` settings. Every application variable below
is server-only even when its value is not intrinsically secret.

| Variable | Required / optional | Secret | Scope | Environments | Purpose |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | Required for auth/native booking | Yes | Shared | Local/staging/production | PostgreSQL URL. Web runtime must use the restricted role and Railway private address. |
| `AUTH_SESSION_SECRET` | Required | Yes | Shared | Local/staging/production | At least 32 random bytes; distinct per environment. Rotation signs users out. |
| `TRUSTED_PROXY` | Required on Railway; blank locally | No | Shared | Staging/production | Set exactly `railway` only when Railway edge is the sole public ingress. |
| `RACHIE_DISCORD_OAUTH_CLIENT_ID` | Required | No | WOS | Local/staging/production | R.A.C.H.I.E OAuth application ID. |
| `RACHIE_DISCORD_OAUTH_CLIENT_SECRET` | Required | Yes | WOS | Local/staging/production | R.A.C.H.I.E OAuth secret. |
| `RACHIE_DISCORD_OAUTH_REDIRECT_URI` | Required | No | WOS | Local/staging/production | Exact callback for that environment. |
| `RACHIE_DISCORD_BOT_TOKEN` | Required | Yes | WOS | Local/staging/production | R.A.C.H.I.E bot token for stale membership checks; not an OAuth secret. |
| `PEGGIE_DISCORD_OAUTH_CLIENT_ID` | Required | No | Kingshot | Local/staging/production | P.E.G.G.I.E OAuth application ID. |
| `PEGGIE_DISCORD_OAUTH_CLIENT_SECRET` | Required | Yes | Kingshot | Local/staging/production | P.E.G.G.I.E OAuth secret. |
| `PEGGIE_DISCORD_OAUTH_REDIRECT_URI` | Required | No | Kingshot | Local/staging/production | Exact callback for that environment. |
| `PEGGIE_DISCORD_BOT_TOKEN` | Required | Yes | Kingshot | Local/staging/production | P.E.G.G.I.E bot token for stale membership checks; not an OAuth secret. |
| `RACHIE_LEGACY_BOOKING_URL` | Optional | Treat as secret | WOS | Any environment retaining compatibility | Apps Script deployment/capability URL. Missing disables only this proxy. |
| `PEGGIE_LEGACY_BOOKING_URL` | Optional | Treat as secret | Kingshot | Any environment retaining compatibility | Apps Script deployment/capability URL. Missing disables only this proxy. |
| `WOS_NATIVE_BOOKING_COMMUNITY_CODE` | Optional obsolete bridge | No | WOS | Local isolated tests only | Authenticated routes do not read it; omit from staging/production. |
| `KINGSHOT_NATIVE_BOOKING_COMMUNITY_CODE` | Optional obsolete bridge | No | Kingshot | Local isolated tests only | Authenticated routes do not read it; omit from staging/production. |
| `ALLOW_DEVELOPMENT_DATABASE_SEED` | Required only for local seed | No | Shared | Local only | Must be `true`; seed also rejects remote DBs and production mode. |
| `BOOKING_BOOTSTRAP_ENABLED` | Required only for operator bootstrap | No | Shared | One-shot operator command only | Must be exactly `true`; never set on the web service. Remote commands also require the CLI confirmation flag. |
| `WOS_DEV_DISCORD_GUILD_ID` | Required only for local seed | No | WOS | Local only | Development seed guild; never staging authority. |
| `KINGSHOT_DEV_DISCORD_GUILD_ID` | Required only for local seed | No | Kingshot | Local only | Development seed guild; never staging authority. |
| `TEST_DATABASE_URL` | Optional runtime; required for DB tests | Yes | Shared | Local/CI only | Disposable test database; never staging/production. |
| `PORT` | Railway-injected | No | Shared | Staging/production | Read by `next start`; do not hardcode. |
| `NODE_ENV` | Framework-managed | No | Shared | All | `next build`/`next start` use production; do not override. Secure cookies depend on production mode. |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | Optional | No | Shared | Staging/production | Railway control value; default is normally sufficient. |
| Other Railway-provided `RAILWAY_*` | Automatic | Metadata | Shared | Staging/production | Do not create manually; never application auth authority. |

Seal session, OAuth, bot, database, and legacy capability secrets when practical.
Railway sealed values are not copied automatically into duplicated environments,
so verify staging has separate values rather than production credentials.

## Proxy, HTTPS, and cookies

Railway documents `X-Forwarded-Host` (original host), `X-Real-IP` (client
address), and `X-Forwarded-Proto: https`. The application trusts forwarded
authority only with `TRUSTED_PROXY=railway`:

- hostname/profile resolution uses `X-Forwarded-Host` on trusted Railway and
  direct `Host` otherwise;
- network rate-limit subjects use only a syntactically valid `X-Real-IP`;
- caller-supplied `X-Forwarded-For` is always ignored;
- with no trust, forwarded headers have no authority and network-only subjects
  conservatively share `unknown-network`.

Do not expose the container directly or add another proxy/CDN without reviewing
this single-proxy assumption. With Cloudflare in front, Railway may observe the
Cloudflare edge as `X-Real-IP`, so revisit rate-limit identity first.

Cookies have no `Domain` attribute and are therefore host-only: root R.A.C.H.I.E
cookies do not bleed to P.E.G.G.I.E subdomains, despite sharing a cookie name.
They are `HttpOnly`, `SameSite=Lax`, and `Secure` in production mode. OAuth state
is callback-path-limited. Railway terminates public TLS; cookie security does not
depend on trusting the forwarded protocol header.

## Railway commands and readiness

Node.js is pinned to 22 through `package.json` and `.nvmrc`; installed Next.js
16.3.1 requires Node 20.9 or later.

| Phase | Command |
| --- | --- |
| Install | `npm ci` |
| Railway build | `npm run build` |
| Railway start | `npm start` |
| Migration release | `npm run db:migrate` with migration-role `DATABASE_URL` |

Railpack normally installs dependencies before the build command. Never combine
migrations with application startup. Configure Railway healthcheck path
`/api/health`; it returns `200` only when `SELECT 1` succeeds and a detail-free
`503` otherwise. It is hostname-independent because Railway checks with Host
`healthcheck.railway.app`. Railway healthchecks gate deployments, not continuous
monitoring.

Prefer a dedicated one-shot migration service or controlled CI release job.
Railway pre-deploy commands can access private networking and block a deployment,
but putting migration-owner credentials on the web service also exposes them to
the long-running process. The web service must receive only the runtime URL.

Use Railway's private `DATABASE_URL`, not `DATABASE_PUBLIC_URL`. If PgBouncer is
enabled, migrations need the unpooled/direct private URL because the runner holds
an advisory lock and transactions.

### PostgreSQL version validation

PostgreSQL 16 remains the original development and local Compose baseline. The
Railway staging database target was compatibility-validated against a disposable
local PostgreSQL 18.6 container using the real migration runner and the complete
PostgreSQL-backed test suite. Migrations `0001`-`0004` applied successfully, a
second run was a clean no-op, and all 135 tests passed, including forced RLS,
restricted roles, concurrency, advisory locks, dates/timestamps, authentication,
rate limiting, and community bootstrap. No PostgreSQL 18 compatibility warning or
application defect was found.

Staging may proceed on Railway PostgreSQL 18.6. This validation does not claim
production support beyond the exact PostgreSQL 18.6 staging target tested here.

## PostgreSQL roles

Connect as the Railway database administrator. Substitute generated passwords
through a secret mechanism; never put real passwords in source or shell history.

```sql
CREATE ROLE rachie_peggie_migration
  LOGIN PASSWORD '<generated-migration-password>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE rachie_peggie_runtime
  LOGIN PASSWORD '<generated-runtime-password>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

REVOKE ALL ON DATABASE railway FROM PUBLIC;
GRANT CONNECT ON DATABASE railway
  TO rachie_peggie_migration, rachie_peggie_runtime;
ALTER SCHEMA public OWNER TO rachie_peggie_migration;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rachie_peggie_runtime;
```

Run migrations as `rachie_peggie_migration`, then apply runtime grants as that
owner:

```sql
GRANT SELECT ON
  booking_communities, booking_discord_guilds, booking_settings,
  booking_windows, minister_services, booking_service_dates,
  appointment_slots, booking_slot_blocks
TO rachie_peggie_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  booking_idempotency_keys, booking_participants, minister_bookings,
  booking_requirement_answers, booking_change_events, booking_outbox,
  website_oauth_states, website_discord_identities, website_auth_sessions,
  website_auth_session_communities, website_auth_session_selection,
  website_rate_limit_buckets
TO rachie_peggie_runtime;

-- PostgreSQL row locks require UPDATE privilege even when application code
-- only selects and locks the row. Grant one low-authority metadata column,
-- not table-wide UPDATE on these operator-owned configuration tables.
GRANT UPDATE (updated_at) ON booking_communities
TO rachie_peggie_runtime;
GRANT UPDATE (updated_at) ON appointment_slots
TO rachie_peggie_runtime;

REVOKE ALL ON app_schema_migrations FROM rachie_peggie_runtime;
```

### Runtime booking-write privilege audit

PostgreSQL requires `SELECT` plus `UPDATE` privilege on at least one column of a
table targeted by `SELECT ... FOR UPDATE`, even when the query never issues an
`UPDATE`. Native creation first locks `booking_communities`; it later locks the
chosen `appointment_slots` row with `FOR UPDATE OF slot`. With the former
SELECT-only staging grant, the first query fails with SQLSTATE `42501`
(`permission denied for table booking_communities`). Granting only the community
lock privilege exposes the same `42501` at the appointment-slot lock.

Column-level `UPDATE (updated_at)` is sufficient for both row locks on
PostgreSQL 18.6. It is preferable to table-wide `UPDATE`: the runtime still
cannot change `booking_communities.bookings_open` or
`appointment_slots.status`. The lock queries do not update `updated_at`; the
grant is solely the narrow PostgreSQL authorization needed to acquire the row
lock. Keep these grants paired with the lock methods when reviewing future
schema or repository changes.

| Runtime path | Tables and operations | Required grant |
| --- | --- | --- |
| Authenticated context | Session `last_seen_at` update; identity, selected-community and community reads | Existing read/write-table grants |
| Membership refresh/loss | Session-community update or delete joined to session reads | Existing read/write-table grants |
| Mutation rate limit | Expired-row delete and insert-on-conflict update | Existing read/write-table grant |
| Community serialization | `booking_communities ... FOR UPDATE` | `SELECT` plus `UPDATE (updated_at)` |
| Idempotency | Insert, conflict read and completion update | Existing read/write-table grant |
| Participant serialization | `booking_participants ... FOR UPDATE` | Existing table `SELECT, UPDATE` |
| Slot serialization | Joined slot/window/service read with `FOR UPDATE OF slot` | Slot `SELECT, UPDATE (updated_at)`; window/service `SELECT` |
| Availability checks | Slot blocks, existing bookings and settings | Existing `SELECT` grants |
| Create | Booking, requirement-answer, audit and outbox inserts | Existing read/write-table grants |
| Reschedule | Booking/participant locks, booking update+insert, answer/audit/outbox inserts | Existing grants plus both narrow lock grants |
| Cancellation | Booking/participant locks, booking update, audit/outbox inserts | Existing grants plus community lock grant |

`FOR NO KEY UPDATE`, `FOR SHARE`, and `FOR KEY SHARE` have the same PostgreSQL
`UPDATE`-privilege requirement. The current repository uses only `FOR UPDATE`.
Advisory transaction locks require no table privilege. Foreign-key enforcement
and UUID generation add no sequence grant; the current schema has no sequences.

Unexpected native booking `503` paths emit one bounded JSON diagnostic with a
static operation name, internal category, validated SQLSTATE when present, and
a syntactically bounded `X-Request-ID` when supplied. They never log SQL, error
messages/stacks, URLs, credentials, cookies, session tokens, or request payloads.
Discord membership verification outages use the distinct bounded category
`discord_membership_verification_unavailable` and the API code
`membership_verification_unavailable`, so they are distinguishable from generic
application or database `503`s without logging Discord response bodies or bot
credentials.

The current schema has no sequences; UUIDs come from the application. If a future
migration adds sequences, grant only named `USAGE, SELECT` privileges needed by
runtime inserts. Review grants with every migration rather than granting blanket
defaults. Verify the runtime connection reports both booleans false:

```sql
SELECT current_user, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = current_user;

SELECT
  has_table_privilege(current_user, 'booking_communities', 'UPDATE')
    AS community_table_update,
  has_column_privilege(current_user, 'booking_communities', 'updated_at', 'UPDATE')
    AS community_row_lock,
  has_table_privilege(current_user, 'appointment_slots', 'UPDATE')
    AS slot_table_update,
  has_column_privilege(current_user, 'appointment_slots', 'updated_at', 'UPDATE')
    AS slot_row_lock;
```

The expected privilege result is `false, true, false, true`: no table-wide
configuration update, with only the two narrow row-lock grants.

The migration URL must never be present in the web service environment.

## Migration review

The runner sorts four-digit files, SHA-256 hashes complete contents, records
version/name/checksum, rejects changed or missing applied files, and serializes
runners with advisory lock `5808457531528991`. Each pending migration plus its
ledger insert is transactional.

| Version | Name | SHA-256 |
| --- | --- | --- |
| `0001` | `native_booking_schema` | `f0745388a35bb422cd66effb42b73bb2f87c6c8bde27beedd93bbcd1f4cb62a0` |
| `0002` | `discord_auth_foundation` | `38fddac496e2cd908ef7497842c15b5ff9b7a7ae3d31dd75a24a3578d49797f8` |
| `0003` | `rate_limit_foundation` | `8eed5ca979efd262ba7da3fb79b09b01ce68d4813e5865cd8dee3d0d8f09c189` |
| `0004` | `native_booking_participant_guard` | `a928f0e9f7dcd0422bd10aa9413cb3583a8f89d803726822dc5c13d16681aac3` |

Reruns are safe through the ledger. Individual SQL files are not standalone
idempotent and must never be manually rerun or edited after application.

Staging procedure:

1. Verify a backup or that the new staging database is disposable.
2. From the exact release commit, run `npm ci`.
3. Run `npm run db:migrate` through the release job with its direct private
   migration-role `DATABASE_URL`, without echoing it.
4. Confirm `app_schema_migrations` contains exactly `0001`–`0004` with the hashes
   above.
5. Apply runtime grants, then validate `rolsuper=false`, `rolbypassrls=false` and
   forced-RLS integration tests.
6. Deploy the web image using only the runtime URL.

There are no down migrations. Rollback means a forward repair or verified backup
restore; old application code is safe only if compatible with the current schema.

## Discord verifier and outage behavior

Each bot token is selected only from hostname-derived profile. The bot must be in
every guild mapped to that profile and able to call Get Guild Member.

- member: refresh that selected session-community timestamp and continue;
- Discord `10007 Unknown Member`: remove only that relationship and deny;
- bot removed, unknown guild, forbidden, or invalid token: controlled retryable
  `membership_verification_unavailable`, never stale trust;
- Discord/network timeout or malformed response: same closed failure;
- Discord `429`: bounded `Retry-After`; identical in-flight checks coalesce per
  process.

Static shell pages do not connect to PostgreSQL while rendering. Database outage
causes controlled auth/booking API `503`s and a recoverable UI state without SQL,
URLs, stacks, cookies, or credentials. `/api/health` also returns detail-free 503.

Secret review findings:

- `.gitignore` ignores `.env*` except placeholder `.env.example`;
- `.env.local` exists, is untracked, and its values were not printed;
- only `.env.example` appears in current or historical tracked env names;
- no real high-entropy OAuth/bot/session secret was found in tracked source;
- documented database URLs contain explicitly local/example credentials;
- timing logs contain static operation/profile labels and elapsed time only;
- Discord and legacy errors are bounded before clients receive them.

Treat legacy Apps Script URLs as secrets. Never log environment objects, export
Railway secrets into tickets, or include database URLs in screenshots.

### Staging membership-refresh smoke test

`website_auth_session_communities.verified_at` is the existing membership
freshness evidence. Authenticated reads accept it for 30 minutes; future booking
mutations accept it for five minutes. The operator command below changes only
that timestamp for the specified user's active sessions, setting it to exactly
one hour before the transaction time. It does not add or remove membership,
change a session, or contact Discord.

Use the direct migration/operator `DATABASE_URL`. The command checks migration
ledger access and explicitly refuses the website runtime role even though the
runtime application legitimately updates this timestamp after a successful
Discord check.

```bash
npm run db:stale-membership -- \
  --profile wos \
  --community 9999 \
  --discord-user-id 123456789012345678
```

Use `--profile kingshot` for P.E.G.G.I.E. Community code and user lookup are
always scoped to that profile. The command requires an existing identity, active
session, and stored community-membership row. Its output contains the number of
active session records changed and the stale timestamp, but no session hashes or
database credentials.

Positive refresh test:

1. Confirm the test user is currently in the profile's mapped Discord test
   server, is signed in to the website, and has the booking page open. Leave that
   page open for the next steps; reloading first exercises the separate
   30-minute read lease rather than the mutation refresh path.
2. Run `db:stale-membership` for that profile, community, and Discord user ID.
3. Without reloading or signing in again, perform a protected booking mutation:
   create, reschedule, or cancel.
4. The mutation should transparently verify membership with Discord and succeed.
5. Verify that the matching `website_auth_session_communities.verified_at` is
   newer than the one-hour-old value printed by the command. The repository
   refresh writes `now()` only to that session/community relationship.

For a read-only verification that does not expose session hashes, run this as
the migration/operator role after substituting the three public identifiers:

```sql
SELECT max(evidence.verified_at) AS newest_membership_verification
FROM website_auth_session_communities AS evidence
JOIN website_auth_sessions AS session
  ON session.game_profile = evidence.game_profile
 AND session.token_hash = evidence.session_token_hash
JOIN booking_communities AS community
  ON community.game_profile = evidence.game_profile
 AND community.id = evidence.community_id
WHERE evidence.game_profile = 'wos'
  AND community.location_code = '9999'
  AND session.discord_user_id = '123456789012345678';
```

Negative membership-loss test:

1. With the protected booking page already open, manually remove the test
   Discord user from the test guild. This repository provides no command and
   performs no Discord membership changes.
2. Run `db:stale-membership` again if the stored evidence has become fresh.
3. Without reloading, attempt a protected booking mutation. The server must
   check Discord, remove only the now-invalid stored session/community
   relationship, and return `community_membership_lost`; it must not trust the
   stale evidence.
4. Rejoin the user to the guild, then sign in again or refresh authentication as
   appropriate so a new verified relationship can be stored.

Bot removal, missing bot guild access, Discord authentication errors, rate
limits, timeouts, and malformed responses instead fail closed as
`membership_verification_unavailable`. Do not automate kicking or removing test
members from Discord.

## Ordered staging checklist

1. Provision isolated staging PostgreSQL and appropriate backups.
2. Create migration and runtime roles with the SQL above.
3. Create private URLs; set only runtime `DATABASE_URL` on the web service.
4. Run `0001`–`0004` through the migration release job and verify the ledger.
5. Apply and verify runtime grants and forced RLS.
6. Load reviewed staging community/guild/settings/window/service/date/slot data.
   First create each JSON file with `npm run db:bootstrap-config`; this local
   wizard requires no PostgreSQL knowledge and makes no database connection.
   Review its summary and generated file. Later, follow the
   [booking bootstrap guide](booking-community-bootstrap.md) to run the
   `npm run db:bootstrap` dry run with the generated file and the
   migration/bootstrap role. Do not use `db:seed`; it intentionally refuses
   staging databases.
7. Configure required variables, including `TRUSTED_PROXY=railway`; omit all
   development-only values.
8. Add the two exact staging redirects to matching Discord applications.
9. Configure profile-specific bot tokens and verify both bots in mapped guilds.
10. Build with `npm run build`, start with `npm start`, healthcheck `/api/health`.
11. Attach both staging domains, then make separately authorized DNS records and
    wait for Railway TLS verification.
12. Start, verify health/migration ledger/runtime flags, then run smoke tests.

## Two-brand staging smoke checklist

- [ ] Both branded home and `/booking` pages load on their staging hostname.
- [ ] Each host starts/completes only its matching Discord OAuth flow.
- [ ] Logout clears that host without changing the other host's session.
- [ ] State/Kingdom guild mapping and labels are correct.
- [ ] Registration, availability, and whole-day speed-up labels work.
- [ ] Create succeeds and duplicate/occupied slots return controlled conflicts.
- [ ] One click reschedules; replacement slots load; original survives failure.
- [ ] Cancellation succeeds and releases the slot.
- [ ] Proof older than five minutes refreshes via bot without visible OAuth.
- [ ] Confirmed membership loss removes only that session-community proof.
- [ ] WOS session/cookies/IDs cannot access Kingshot, and vice versa.
- [ ] Auth/read/mutation rate limits trigger; spoofed `X-Forwarded-For` does not
      create a new bucket.
- [ ] Invalid bot/blocked Discord produces retryable controlled failure.
- [ ] PostgreSQL outage leaves static pages renderable and causes detail-free 503
      from auth/booking/readiness APIs.
- [ ] Restored dependencies recover with an ordinary retry.

## Rollback checklist

- [ ] Application: retain/redeploy the previous healthy image only after schema
      compatibility review.
- [ ] Environment: inventory variable names before change; roll back atomically.
      `AUTH_SESSION_SECRET` rotation signs everyone out.
- [ ] Migration/database: backup before non-additive changes. With no down
      migrations, restore into a separate database, validate, then switch URL.
- [ ] DNS/domain: record previous values/TTLs and revert only affected staging
      records; retain generated Railway domain for health diagnostics.
- [ ] Discord: preserve existing redirect lists; remove staging callbacks only
      after traffic/DNS rollback, never by replacing production callbacks.
- [ ] Suspected disclosure: rotate the affected DB password, OAuth secret, bot
      token, legacy URL, or session secret rather than restoring it.

## Blockers before deployment

- Railway staging services, roles, backups, release job, and domains are not yet
  provisioned or verified.
- DNS and Discord redirect changes need separate explicit authorization.
- Both staging bot credentials and guild membership must be verified.
- Create both staging community files with `npm run db:bootstrap-config`, keep
  them outside source, and peer-review them. Then dry-run and apply each one with
  the migration/bootstrap role. The development seed still correctly refuses
  remote databases.
- Decide whether legacy compatibility is needed; otherwise omit its variables and
  expect controlled 503s from those endpoints.
- Complete the real-identity smoke checklist after staging exists.

## Platform references

- Railway [public-networking specifications and injected headers](https://docs.railway.com/networking/public-networking/specs-and-limits)
- Railway [deployment healthchecks](https://docs.railway.com/deployments/healthchecks)
- Railway [pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command)
- Railway [PostgreSQL service and connection variables](https://docs.railway.com/databases/postgresql)
- Railway [private networking](https://docs.railway.com/networking/private-networking)
- Railway [variables and sealed-variable behavior](https://docs.railway.com/variables)
- Railway [PostgreSQL backup and restore guidance](https://docs.railway.com/guides/postgres-backups-restores)
- Discord [Get Guild Member](https://docs.discord.com/developers/resources/guild#get-guild-member)
- Discord [bot authentication](https://docs.discord.com/developers/platform/oauth2-and-permissions)
