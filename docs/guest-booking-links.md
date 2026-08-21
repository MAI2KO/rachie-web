# Guest booking links

Guest links let players request an appointment without Discord. PostgreSQL remains the source of truth and every request requires manager approval.

## Operator commands

Use the migration/operator `DATABASE_URL`. The website runtime role is explicitly refused.

```bash
npm run db:guest-link -- --profile wos --community 9999 --create --base-url https://staging.example
npm run db:guest-link -- --profile wos --community 9999 --rotate --base-url https://staging.example
npm run db:guest-link -- --profile wos --community 9999 --revoke
npm run db:guest-link -- --profile wos --community 9999 --status
```

Create makes one opaque 256-bit token. Rotate revokes the active link atomically and creates another. Revoke disables the active link. Status shows only state and a short token hint. The complete plaintext URL is printed once by create/rotate and cannot be recovered later. Only its SHA-256 hash is stored. `--base-url` is mandatory when a URL is created; the command never guesses a production hostname.

Treat the URL as a submission capability: share it only in the intended in-game community and rotate it if disclosed unexpectedly. It grants no login or manager access.

## Player flow

The route is `/book/<opaque-token>`. The hostname selects WOS or Kingshot, and the token must resolve inside that same forced-RLS profile. Invalid, expired, revoked, and cross-profile tokens receive the same safe unavailable response.

The mobile-first form shows the State/Kingdom code and name, configured services/dates, and current slots. It asks for in-game name, numeric Player ID, three-character alliance abbreviation, and only requirements enabled for the chosen service. Labels, units, and server validation reuse the native booking requirement metadata.

Submission creates a pending approval request and configured-duration hold (normally 30 minutes), requirement answers, audit event, and outbox record in one transaction. It does not create `minister_bookings`. Approval later creates the confirmed booking; denial or expiry releases the slot.

## Abuse and request security

Guest page-data reads are limited to 120 per minute, and submissions to five attempts per ten minutes, for each active-link hash plus trusted client/network subject. The plaintext token is never placed in the rate-limit subject. The token itself scopes the community. A transaction advisory lock plus a live database check allows only one active pending request for the same Player ID, community, and service; an expired hold is transitioned and no longer blocks a new request. This protects concurrent submissions without adding fingerprinting or CAPTCHA.

Browser POST requests require a matching Origin when one is supplied. The unguessable token, hostname profile, explicit server validation, idempotency key, rate limit, row locks, and forced RLS remain authoritative. Request bodies cannot override profile or community. Success responses omit internal request IDs and all manager fields.

Discord approval-message/DM delivery is still outstanding. Managers approve or deny through the existing website manager board.

## Later staging procedure

After the reviewed code is deployed in a separate approved change:

1. Confirm migration 0005 and runtime grants are present.
2. Set the shell's `DATABASE_URL` to the migration/operator connection, never the website runtime connection.
3. Run create with the explicit staging public origin.
4. Copy the one-time URL to the intended test player.
5. Submit a request, verify `Pending` on the public/manager boards, then approve or deny it.
6. Use `--status` for safe checks and `--rotate` or `--revoke` when testing is complete.
