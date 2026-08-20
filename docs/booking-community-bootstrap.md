# Booking community bootstrap

This operator-only command creates the initial native booking configuration for
one community. It is not an application startup task, deployment hook,
player/booking importer, or replacement for migrations. Review the JSON and
database target before every run.

Do not use `scripts/seed-development.mjs` or `npm run db:seed` outside the local
development database. Those protections remain separate and unchanged.

## Configuration file

Copy `config/bootstrap/example-booking-community.json` to an untracked,
access-controlled location and replace every angle-bracket placeholder. Never
put real guild IDs, player data, credentials, or secrets in source.

Version 1 requires:

- `profile`: exactly `wos` or `kingshot`;
- `community`: code, public display name, Discord guild ID and public guild name;
- `booking.enabled`: initial active/archived state;
- `booking.open`: whether the community and its booking window accept bookings;
- `timeZone`: an IANA zone used with every local slot time;
- `services`: exactly one `construction`, `research`, and `troop` entry, each
  with a date, required requirement codes, and an ordered non-empty slot list;
- each slot: a public label and 24-hour `HH:MM` local start time.

Supported requirements are `fc`, `rfc`, and `speedups` for construction;
`shards` and `speedups` for research; and `speedups` for troop. Omit a supported
code to make it optional. The stable `speedups` code means a positive whole
number of **days**; bootstrap stores only whether the answer is required.

Unknown fields/profiles, malformed identifiers, dates, times or zones, missing
fields, duplicates, and unsupported requirement codes are rejected before a
database connection is opened.

## Role, dry run, and remote safeguards

Use the direct, unpooled migration/bootstrap administrative `DATABASE_URL`.
That role must own or have `INSERT` and `UPDATE` on every bootstrap table. The
restricted website runtime role deliberately lacks structural writes and is
refused; its grants are not changed.

`BOOKING_BOOTSTRAP_ENABLED=true` is required for every run. A non-loopback
database also requires `--confirm-remote-bootstrap`, including for dry runs.
The command never prints the URL or credentials.

Dry-run the exact reviewed file and target first:

```bash
BOOKING_BOOTSTRAP_ENABLED=true \
DATABASE_URL='<migration-role-direct-database-url>' \
npm run db:bootstrap -- \
  --config '<path-to-reviewed-community.json>' \
  --dry-run \
  --confirm-remote-bootstrap
```

After peer review, apply by removing only `--dry-run`:

```bash
BOOKING_BOOTSTRAP_ENABLED=true \
DATABASE_URL='<migration-role-direct-database-url>' \
npm run db:bootstrap -- \
  --config '<path-to-reviewed-community.json>' \
  --confirm-remote-bootstrap
```

Prefer secret injection that avoids shell history. Never put the administrative
URL on the web service; the value above is a placeholder only.

## Idempotency and reconciliation

The command takes a transaction advisory lock, sets `app.game_profile` for each
profile-scoped query/write, checks both profiles for identity collisions, and
plans everything before writing. New object UUIDs are deterministic, so the
same file reruns without duplicate communities, mappings, windows, dates or
slots.

Safe reconciliation updates public community/guild names, booking open/closed
state, and requirement flags. It never silently changes profile/community or
guild ownership, enabled/archived state, global services, window identity,
dates, or slot order/time/label/status. Missing or extra existing structure is
drift. Drift fails clearly, and existing booking history is explicitly reported;
there is no force flag.

`--dry-run` performs validation, permission and RLS checks, locking, inspection,
and conflict reporting, then rolls back. Conflicts exit unsuccessfully. Apply is
one transaction, so any error rolls back every create/update.

## Verification and rollback

Retain the reviewed JSON and concise summary in the private change record. Verify
the chosen profile and code using the same RLS context:

```sql
BEGIN;
SELECT set_config('app.game_profile', '<wos-or-kingshot>', true);
SELECT c.location_code, c.display_name, c.status, c.bookings_open,
       g.discord_guild_id, g.discord_guild_name
FROM booking_communities AS c
JOIN booking_discord_guilds AS g
  ON g.game_profile = c.game_profile AND g.community_id = c.id
WHERE c.game_profile = '<wos-or-kingshot>'
  AND c.location_code = '<community-code>';
ROLLBACK;
```

Also verify service dates/slot counts, matching Discord bot membership, and the
two-brand staging smoke checklist. Do not publish results containing guild IDs.

A failed command needs no rollback because it is atomic. There is intentionally
no automatic reverse after success: deletion could destroy trust mappings and
history. Before production, verify a backup, peer-review the exact target/file,
dry-run, and start closed when practical. If an error committed before any user
data exists, prepare a separate narrowly reviewed repair. With participants or
bookings, close booking and use a forward repair or verified backup restore.
