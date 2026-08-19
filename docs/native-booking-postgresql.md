# Native Booking PostgreSQL Foundation

## Scope

This is additive infrastructure for the future native Minister booking service.
It does not implement booking operations, expose a public API or UI, import Sheets,
or change the source of truth. The legacy Apps Script deployments remain
authoritative and the compatibility proxy remains available for rollback and
migration work.

The website database is independent from every Discord bot database.

## Configuration

`DATABASE_URL` is read only by server modules. It must be a PostgreSQL connection
URL for this website's database and must never use a `NEXT_PUBLIC_` prefix. Pool
creation is lazy: when the variable is absent or blank, normal pages and the legacy
compatibility proxy can still start, while native repository creation returns
unavailable.

`TEST_DATABASE_URL` is used only by the optional integration suite. Tests create a
random schema, run migrations there, and drop it afterward. It must point to a safe
disposable database where schema creation is permitted, never a production database.

The read-only native API also uses these server-only settings:

- `WOS_NATIVE_BOOKING_COMMUNITY_CODE`
- `KINGSHOT_NATIVE_BOOKING_COMMUNITY_CODE`

Each value is the exact `booking_communities.location_code` served for that
profile's hostname. They are a controlled single-community bridge until the site
has authenticated State/Kingdom selection. They must not be exposed with a
`NEXT_PUBLIC_` prefix.

### Disposable local PostgreSQL

A local Docker database can be created without using Railway:

```bash
docker run --rm --name rachie-booking-pg-test \
  -e POSTGRES_PASSWORD=local_test_only \
  -e POSTGRES_DB=rachie_booking_test \
  -p 127.0.0.1:55432:5432 \
  -d postgres:16-alpine

TEST_DATABASE_URL=postgresql://postgres:local_test_only@127.0.0.1:55432/rachie_booking_test \
  node --test --test-isolation=none tests/database-integration.test.mjs

docker stop rachie-booking-pg-test
```

The integration suite creates an additional temporary login with `NOSUPERUSER`
and `NOBYPASSRLS`, grants it only schema usage and table DML, runs tenant tests
through that login, and removes both the role and random test schema afterward.

## Migrations

Run migrations locally or as an explicit Railway release/pre-deploy command:

```bash
npm run db:migrate
```

Migration files live in `db/migrations` and use an ordered
`NNNN_descriptive_name.sql` format. The runner:

- acquires a session-level PostgreSQL advisory lock before inspecting schema state;
- creates and reads `app_schema_migrations` while holding that lock;
- applies each pending migration in its own transaction;
- records its version, name, SHA-256 checksum, and application timestamp in the
  same transaction;
- safely does nothing when all migrations are already applied;
- refuses changed checksums, changed names, duplicate versions, or an applied
  migration missing from the deployment.

Applied migration files are immutable. Schema changes require a new ordered file.
The application does not automatically migrate during ordinary startup, so a
missing or unavailable database does not prevent the non-booking website from
starting. Concurrent migration commands serialize on the advisory lock.

## Schema Overview

The initial migration creates:

| Table | Responsibility |
| --- | --- |
| `booking_communities` | State/Kingdom booking tenant and open state |
| `booking_discord_guilds` | Discord guild-to-community links |
| `booking_settings` | Current requirements and retained inert legacy metadata |
| `booking_windows` | Historical booking cycles and lifecycle |
| `minister_services` | Profile-scoped construction, research, and troop definitions |
| `booking_service_dates` | One PostgreSQL `date` per service/window |
| `appointment_slots` | Ordered slots and their exact display labels |
| `booking_slot_blocks` | Active/cancelled administrative reservations |
| `booking_participants` | Community-scoped player registration identities |
| `minister_bookings` | Confirmed and ended booking records plus snapshots |
| `booking_requirement_answers` | Raw and optionally parsed requirement values |
| `booking_change_events` | Append-oriented mutation/audit history |
| `booking_outbox` | Transactional integration and Discord notification events |
| `booking_idempotency_keys` | Request hashes, correlation IDs, and replay results |

No Sheet mapping, import staging, or compatibility request journal is created yet.
Those tables should be introduced only alongside a reviewed importer/reconciliation
design.

## Profile Isolation

Every booking-owned table has a `game_profile` constrained to `wos` or `kingshot`.
Primary, unique, and foreign-key relationships include the profile wherever tenant
ownership crosses tables. A WOS child therefore cannot reference a Kingshot parent,
even if it knows the parent's UUID.

Every booking table also has forced PostgreSQL row-level security. Policies compare
the row profile with transaction-local `app.game_profile`. The native repository is
constructed once for a trusted `GameProfile`, starts a transaction, sets that local
context, and includes the same profile in every lookup. Repository methods do not
accept a profile selector. Future hostname and authenticated bot contexts must
construct the appropriate repository; request-body `game_profile` values must
never do so.

Production database roles must not have PostgreSQL `BYPASSRLS` or superuser
privileges. Separate least-privilege runtime and migration roles remain desirable
before deployment.

This behavior has been verified on PostgreSQL 16.13 using a temporary runtime role:
WOS and Kingshot contexts could see and mutate their own rows, could not see,
update, delete, insert, or move rows through the other profile, and could not create
cross-profile composite references in either direction. Successful repository
reads under forced RLS also prove that repository transactions establish the local
profile before querying.

## Important Constraints

- A slot ordinal and exact display label are each unique within a service date.
- Only one non-cancelled slot block can occupy a slot.
- Only one `confirmed` booking can occupy a slot.
- A player-ID snapshot can have only one `confirmed` booking for a given community,
  window, and service. Cancellation or replacement retains history and releases the
  partial uniqueness constraint.
- One active Discord registration is allowed per user/community. Player ID is
  intentionally not globally unique and may repeat across communities or manual
  records.
- `discord` and `website` participant sources require a Discord user ID. Admin,
  manual, and legacy-import identities may omit one.
- Bookings contain immutable player/alliance/time snapshots and explicit actor,
  source, request, correlation, idempotency, cancellation, and reschedule lineage.
- Slot blocks, registrations, and bookings reference a claimed community-scoped
  idempotency key. Future mutation services must claim and complete that key in the
  same transaction as domain changes, audit events, and outbox messages.

The retained `legacy_max_bookings_per_player_per_day` setting is nullable metadata
only. No booking constraint or repository rule enforces it because recovered Apps
Script did not enforce it.

## Date and Time Representation

`booking_service_dates.booking_date` and the slot's matching date are PostgreSQL
`date` values. No midnight UTC timestamp is fabricated.

The `pg` driver is configured to return PostgreSQL `date` (OID 1082) as its exact
`YYYY-MM-DD` string. Real-database testing exposed that the default parser creates
a JavaScript `Date` and can shift the displayed calendar day when the session
timezone changes. `time without time zone` remains a wall-clock string, while
resolved `timestamptz` values remain absolute JavaScript `Date` instants. The
integration suite verifies all three under a deliberately different session zone.

Each slot always stores its service date, ordinal, and exact `display_time_label`.
Native scheduling can later add `local_start_time` together with an IANA
`time_zone`; the schema requires those two values as a pair. `starts_at` is an
optional `timestamptz` resolved from that approved local date/time/zone policy, and
`ends_at` remains optional until duration is known. This separates display fidelity,
wall-clock intent, zone rules, and an actual instant instead of inheriting the
legacy mixture of local and UTC conversions.

No native code should populate the semantic time fields from legacy labels until
the production Sheet/script timezones, daylight-saving behavior, and slot duration
are verified.

## PostgreSQL Validation

Migration `0001` has been applied with the real runner on PostgreSQL 16.13 and then
re-run as a no-op. Concurrent runners applied it exactly once under the advisory
lock. The recorded SHA-256 checksum was present, and a mismatched checksum was
rejected.

The database integration suite verifies all 14 native tables, forced RLS and its
policies, both directions of composite profile isolation, transaction rollback,
idempotency uniqueness, participant rules, active slot/block/player uniqueness,
and rollback of a multi-step reschedule shape. The reschedule test ends the old
booking and creates its successor in one transaction, forces a later failure, and
confirms neither intermediate change survives.

The PostgreSQL catalog index audit found no correctness defect or removable index.
Some unique indexes intentionally overlap because PostgreSQL requires the exact
composite key targeted by profile-safe foreign keys. Dedicated child-side indexes
for future deletion and history-query paths should be selected alongside the native
repository operations and verified with their query plans rather than added before
those access patterns exist.

## Native Read Service

The first native service layer is read only:

```text
Hostname
  -> trusted brand/profile resolution
  -> profile-specific configured community code
  -> profile-bound repository transaction and RLS context
  -> native read service
  -> versioned public response
```

The service reads community state, the current public window, active service
definitions, service dates, public requirement settings, available slots, and an
internally trusted Discord user's active registration/current bookings. Raw SQL
rows are mapped into typed domain objects before they reach route handlers.

The participant read has no public route. It is reserved for a future authenticated
Discord identity context and cannot currently be invoked by supplying a user ID in
a query string.

### Community resolution

`r-a-c-h-i-e.com`/`localhost` resolves the WOS profile and its configured WOS
community code. `peggie.r-a-c-h-i-e.com`/`peggie.localhost` resolves Kingshot and
its separately configured code. Unknown hosts, absent configuration, archived or
missing communities, and profile/community mismatches fail closed.

No request body, query parameter, cookie, or arbitrary header chooses
`game_profile` or community. This deliberately supports only one configured
community per profile for now. Before multi-community public use, an authenticated
Discord guild/community membership or another approved server-owned selection
mechanism is required.

### Current window and availability

Public reads choose an open window when one exists; otherwise they use the most
recently opened/created closed window. Draft and archived windows are not public.
Before native writes, the service must decide whether the schema should enforce at
most one open window per community rather than relying on deterministic read order.

A slot is returned only when all of these database conditions hold:

- its community is active and has `bookings_open = true`;
- its selected window has status `open`;
- its service definition is active;
- the slot has status `available`;
- no `confirmed` booking occupies the slot;
- no slot block without `cancelled_at` occupies the slot.

Slots are ordered by ordinal and then stable slot ID. Occupied player, participant,
Discord, alliance, and booking details are never selected or returned.

### Public routes

`GET /api/v1/booking/context` returns:

```json
{
  "brand": {
    "displayName": "R.A.C.H.I.E",
    "shortName": "RACHIE",
    "description": "...",
    "gameName": "Whiteout Survival",
    "gameProfile": "wos",
    "theme": { "id": "whiteout", "accent": "#2563eb" }
  },
  "community": { "locationCode": "1001", "displayName": "State 1001" },
  "bookingsOpen": true,
  "windowState": "open",
  "requirements": {
    "construction": {
      "fcRequired": true,
      "rfcRequired": false,
      "speedupsRequired": true
    },
    "research": { "shardsRequired": true, "speedupsRequired": true },
    "troop": { "speedupsRequired": false }
  },
  "services": [
    {
      "code": "construction",
      "displayLabel": "Construction",
      "appointmentLabel": "Minister booking",
      "date": "2026-08-20"
    }
  ]
}
```

`GET /api/v1/booking/availability?service=construction` returns:

```json
{
  "service": { "code": "construction", "displayLabel": "Construction" },
  "date": "2026-08-20",
  "bookingsOpen": true,
  "slots": [
    { "slotId": "opaque-uuid", "displayTime": "09:30", "ordinal": 2 }
  ]
}
```

Only `construction`, `research`, and `troop` are accepted service codes. Missing or
malformed codes return a controlled `400`. Missing contexts return `404`, while
database/configuration failures return controlled `503` responses without SQL,
credentials, table names, or stack traces. Responses use `Cache-Control: no-store`.

### Intentionally unimplemented

This layer does not create registrations or bookings, reschedule, cancel, clear,
reserve, perform admin mutations, authenticate website users, expose participant
reads publicly, call Apps Script, import Sheets, or switch bot traffic. The legacy
compatibility proxy remains separate.

## Legacy Behavior Not Carried Forward

The native model intentionally rejects:

- unlocked slot claims and race-dependent duplicate bookings;
- deleting an old booking before a replacement slot is secured;
- partial reschedule writes;
- representing an admin-added player as the `RESERVED` sentinel;
- public browser identity based only on a typed player ID;
- plaintext join passwords, state keys, admin keys, or service credentials;
- arbitrary profile or destination selection from request payloads;
- enforcement of the unused legacy maximum-bookings setting.

Legacy duplicate/corrupt rows will need staging or quarantine during import rather
than weaker native constraints.

## Decisions Before Native Operations

Before implementing booking commands or website mutations, decide and verify:

1. Production timezones, slot duration, daylight-saving policy, and editable slot
   label rules for each profile.
2. Authentication and player-ownership requirements for website bookings.
3. Exact cancellation, clearing, closed-window, and reservation-removal policy.
4. Reschedule response semantics while acquiring the new slot and ending the old
   booking atomically.
5. Requirement definitions, numeric validation, and Kingshot terminology.
6. Idempotency-key lifetime, request hashing, response retention, and retry policy.
7. Audit/outbox retention, sensitive-data minimization, and notification consumers.
8. Runtime and migration database roles, grants, RLS verification, backups, and
   Railway release-command behavior.
9. Import quarantine/reconciliation tables and a rollback projection design.
