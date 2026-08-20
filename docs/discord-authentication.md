# Discord Authentication Foundation

## Scope

This foundation authenticates ordinary website users with Discord and resolves
the booking communities they may select. It does not create, reschedule, cancel,
or administer bookings. It does not call Apps Script and it does not implement
website administrator permissions.

Protocol behavior follows Discord's official [OAuth2 documentation](https://docs.discord.com/developers/topics/oauth2),
[OAuth2 overview](https://docs.discord.com/developers/platform/oauth2-and-permissions),
and [User resource documentation](https://docs.discord.com/developers/resources/user).

## OAuth Routes

| Route | Purpose |
| --- | --- |
| `GET /api/v1/auth/login` | Creates one-use state and redirects to Discord |
| `GET /api/v1/auth/callback` | Validates state, exchanges the code, resolves communities, and creates a session |
| `GET /api/v1/auth/session` | Returns the safe current identity/community context |
| `POST /api/v1/auth/community` | Selects one of the session's verified communities |
| `POST /api/v1/auth/logout` | Revokes the server session and expires its cookie |

The callback redirects a successful login to `/booking`. No public sign-in UI has
been added in this phase.

## Discord Scopes

Only these scopes are requested:

- `identify` reads the Discord user ID, username, display name, and avatar metadata.
- `guilds` reads the user's current guild IDs so they can be matched to approved
  `booking_discord_guilds` rows.

The application does not request `email`, `guilds.join`, `guilds.members.read`,
`bot`, or any administrator scope. The access token exists only in server memory
while `/users/@me` and `/users/@me/guilds` are read. Access and refresh tokens are
never stored in PostgreSQL, placed in cookies, or returned to browser JavaScript.

## Configuration

All values are server-only. None may use a `NEXT_PUBLIC_` prefix.

| Variable | Purpose |
| --- | --- |
| `RACHIE_DISCORD_OAUTH_CLIENT_ID` | R.A.C.H.I.E Discord OAuth application ID |
| `RACHIE_DISCORD_OAUTH_CLIENT_SECRET` | R.A.C.H.I.E Discord OAuth secret |
| `RACHIE_DISCORD_OAUTH_REDIRECT_URI` | Exact R.A.C.H.I.E callback URI |
| `PEGGIE_DISCORD_OAUTH_CLIENT_ID` | P.E.G.G.I.E Discord OAuth application ID |
| `PEGGIE_DISCORD_OAUTH_CLIENT_SECRET` | P.E.G.G.I.E Discord OAuth secret |
| `PEGGIE_DISCORD_OAUTH_REDIRECT_URI` | Exact P.E.G.G.I.E callback URI |
| `AUTH_SESSION_SECRET` | At least 32 bytes used to derive profile-bound CSRF tokens |
| `DATABASE_URL` | Server-only PostgreSQL connection used for sessions and mappings |

Production callback values should be registered exactly as:

```text
https://r-a-c-h-i-e.com/api/v1/auth/callback
https://peggie.r-a-c-h-i-e.com/api/v1/auth/callback
```

Local Discord application redirect entries can instead use the corresponding
`localhost:3000` and `peggie.localhost:3000` callback URLs. Each profile has its
own credentials and redirect setting; there is no cross-profile fallback.

## Session Model

Migration `0002_discord_auth_foundation.sql` adds:

| Table | Responsibility |
| --- | --- |
| `website_oauth_states` | One-use, ten-minute OAuth state hashes |
| `website_discord_identities` | Profile-scoped Discord display identity |
| `website_auth_sessions` | Hashed opaque session tokens, expiry, and revocation |
| `website_auth_session_communities` | Communities verified from the login-time guild list |
| `website_auth_session_selection` | At most one selected verified community per session |
| `website_rate_limit_buckets` | Profile-scoped distributed abuse counters added by migration `0003` |

The raw random session token is stored only in a host-only, HTTP-only,
`SameSite=Lax` cookie. Production cookies also use `Secure`. PostgreSQL stores only
its SHA-256 hash. Sessions expire after 12 hours and logout records revocation
before expiring the browser cookie. Invalid, expired, revoked, or unknown tokens
produce an unauthenticated context.

Booking membership authority expires sooner than the website session: reads accept
the login-time guild proof for 30 minutes, while registration and booking mutations
accept it for five minutes. Because Discord tokens are deliberately not persisted,
normal session reads cannot refresh that proof. After five minutes the current UI
must start OAuth again before another mutation; this is membership freshness, not
website-session expiry. The security-preserving refresh recommendation is recorded
in [authenticated-booking-context.md](authenticated-booking-context.md#membership-freshness).

State is a separate random token stored in an HTTP-only callback-path cookie and
as a profile-scoped database hash. The callback requires the query and cookie
values to match and atomically consumes the unexpired database row. Selection and
logout require a profile-bound HMAC CSRF token in `x-csrf-token`; same-origin POST
requests are additionally checked when an `Origin` header is present.

## Profile And Community Trust

The request hostname is the only profile selector:

```text
r-a-c-h-i-e.com / localhost
  -> wos repository and R.A.C.H.I.E OAuth application

peggie.r-a-c-h-i-e.com / peggie.localhost
  -> kingshot repository and P.E.G.G.I.E OAuth application
```

Unknown hostnames fail closed. Query strings, JSON fields, public location codes,
and cookies cannot override that profile. All auth tables use profile-composite
keys and forced row-level security. A session token copied to the other hostname
therefore cannot resolve there even in the improbable event that hashes collide.

Community authority is established only during server-side callback processing:

```text
Discord /users/@me/guilds IDs
  -> same-profile booking_discord_guilds
  -> active same-profile booking_communities
  -> immutable choices recorded for this server session
```

Zero matches produce an empty community list. One match is selected
automatically. Multiple matches require `POST /api/v1/auth/community` with a
public `locationCode`, and the repository accepts it only when the exact community
was already recorded for that session. The API does not accept community UUIDs or
profile values as authority.

The existing `WOS_NATIVE_BOOKING_COMMUNITY_CODE` and
`KINGSHOT_NATIVE_BOOKING_COMMUNITY_CODE` settings remain a development bridge for
isolated service testing only. Authenticated native booking routes do not read
them. They do not grant access, populate authenticated choices, or authorize any
future mutation.

## Safe Session Response

An authenticated session returns only the hostname-derived game profile, basic
Discord display identity, verified community display values, current selection,
expiry, and a CSRF token. It never returns Discord OAuth tokens, client secrets,
database identifiers, guild IDs, session hashes, or credentials.

## Remaining Work

Before native booking writes:

- retain the trusted authenticated request-context adapter for every booking
  service and never replace it with request parameters;
- evaluate whether community-link changes should revoke affected sessions before
  the bounded membership lease expires;
- decide whether sessions should be revoked across devices when a community link
  changes;
- add participant registration and ownership rules without treating Discord
  identity alone as an in-game player record;
- design idempotent booking mutations, audit/outbox behavior, rate limits, and
  abuse controls;
- configure separate least-privilege migration and runtime PostgreSQL roles in
  production;
- build the user-facing login, empty-state, and community-picker UI.

No production Discord credentials, deployment settings, or database connection
were created by this phase.

Authenticated booking reads use a 30-minute login-time guild-membership lease.
Stale membership requires a fresh Discord sign-in; future mutations have an
implemented five-minute freshness assertion. Authentication and booking routes
also use profile-scoped PostgreSQL fixed-window limits. Full details are in
[authenticated-booking-context.md](authenticated-booking-context.md).
