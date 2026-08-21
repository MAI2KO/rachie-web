# Booking community bootstrap

This operator-only command creates the initial native booking configuration for
one community. It is not an application startup task, deployment hook,
player/booking importer, or replacement for migrations. Review the JSON and
database target before every run.

Do not use `scripts/seed-development.mjs` or `npm run db:seed` outside the local
development database. Those protections remain separate and unchanged.

## Create a configuration with the wizard

You do not need to know PostgreSQL or edit JSON. From the project directory, run:

```bash
npm run db:bootstrap-config
```

Choose R.A.C.H.I.E / Whiteout Survival or P.E.G.G.I.E / Kingshot, then answer
the plain-language questions. Press Enter at `Keep bookings closed initially?
[Y/n]` to use the safer default. The wizard validates each answer, previews the
appointment schedule, prints a complete summary, and asks before writing.

By default it creates the directory `/home/mark/rachie-staging-config/` and
writes one of these files:

- `staging-wos-booking-community.json`
- `staging-kingshot-booking-community.json`

It never silently replaces an existing file. It asks for a separate explicit
confirmation if the selected file already exists. After writing, it reads the
file back and runs the existing bootstrap configuration validator locally. This
step does not use `DATABASE_URL`, connect to PostgreSQL, contact Railway, or make
any Discord change.

The recovered legacy source proves that the old template used 48 rows
(`A12:A59`), but the repository does not contain the spreadsheet template's
actual times or interval. The wizard therefore asks for a first time, interval,
and number of slots and does not invent a legacy schedule. The schedule is used
for Construction, Research, and Troop.

These files are configuration, not a place for secrets. They must **not**
contain bot tokens, OAuth secrets, database passwords, or session secrets. Keep
the files outside the repository and share them only through an appropriate
private channel.

## What the generated file contains

Version 1 requires:

- `profile`: exactly `wos` or `kingshot`;
- `community`: code, public display name, Discord guild ID and public guild name;
- `booking.enabled`: initial active/archived state;
- `booking.open`: whether the community and its booking window accept bookings;
- `timeZone`: an IANA zone used with every local slot time;
- `services`: exactly one `construction`, `research`, and `troop` entry, each
  with a date, required requirement codes, and an ordered non-empty slot list;
- each slot: a public label and 24-hour `HH:MM` local start time.

Community codes and Discord guild IDs are unique **within a game profile**, not
globally across R.A.C.H.I.E and P.E.G.G.I.E. For example, WOS community `9999`
and Kingshot community `9999` are independent and valid. The same Discord guild
may be mapped once in WOS and once in Kingshot so that it can host both bots.
Within one profile, a location code still identifies only one community and a
Discord guild still maps to only one community.

Supported requirements are `fc`, `rfc`, and `speedups` for construction;
`shards` and `speedups` for research; and `speedups` for troop. Omit a supported
code to make it optional. The stable `speedups` code means a positive whole
number of **days**; bootstrap stores only whether the answer is required.

The wizard shows profile-specific names and handles these codes for you. WOS
uses Fire Crystals, Refined Fire Crystals, Fire Crystal Shards, and Speed-ups
(days). Kingshot uses Truegold, Tempered Truegold, Truegold Dust, and Speed-ups
(days).

Unknown fields/profiles, malformed identifiers, dates, times or zones, missing
fields, duplicates, and unsupported requirement codes are rejected before a
database connection is opened.

## Open or close bookings manually

Bootstrap normally creates a community with bookings closed. Operators can open
or close an existing community later without editing SQL or rerunning bootstrap.
This is the immediate/manual operator control; it does not change appointment
dates, slots, services, Discord guild mappings, registrations, or bookings.

Open WOS community `9999`:

```bash
npm run db:booking-window -- --profile wos --community 9999 --open
```

Close it again:

```bash
npm run db:booking-window -- --profile wos --community 9999 --close
```

Use `--profile kingshot` for the independent Kingshot community. The command
requires `DATABASE_URL` to use the migration/operator role. The restricted
website runtime role is deliberately refused. It selects only the requested
profile and community, coordinates the community and current-window open state
in one transaction, prints no connection details, and rolls back on failure.
Running an already-satisfied `--open` or `--close` is safe and reports `no
change`. The command does not create or alter optional `opens_at`/`closes_at`
window bounds. Bootstrap-created windows have no such bounds; if future tooling
adds them, those bounds will remain effective.

Operationally, bookings will typically be opened four to five days before the
first appointment day. Automatic scheduled opening is not implemented yet;
until that separate feature is designed and approved, an operator must run this
manual command at the chosen time.

To deliberately exercise the server-side Discord membership refresh path in
staging, make an existing user's stored membership timestamp one hour old:

```bash
npm run db:stale-membership -- --profile wos --community 9999 --discord-user-id 123456789012345678
```

This operator/test command changes only existing membership freshness evidence.
It cannot add or remove Discord membership and refuses the website runtime role.
See the staging deployment guide for the positive and negative smoke-test steps.

## Role, dry run, and remote safeguards

Creating the JSON is the only step covered by the wizard. Later, when a database
operator has supplied the reviewed migration-role connection securely, dry-run
the generated file before applying anything. For example, the WOS command shape
is:

```bash
npm run db:bootstrap -- \
  --config /home/mark/rachie-staging-config/staging-wos-booking-community.json \
  --dry-run \
  --confirm-remote-bootstrap
```

That later command also needs `BOOKING_BOOTSTRAP_ENABLED=true` and the correct
administrative `DATABASE_URL`; do not guess either value. A dry run does connect
to the selected database, so stop and ask the database operator if those terms
or the target are unfamiliar.

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
profile-scoped query/write, and plans everything before writing. Profile-local
constraints reject identity collisions without treating an identity in the
other game profile as a conflict. New object UUIDs are deterministic, so the
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
