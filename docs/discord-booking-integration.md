# Discord booking integration

## Player appointment times

Player confirmation, manual approval, reschedule, cancellation, and 30-minute reminder work items include the canonical appointment instant derived from the booked `appointment_slots` row. Reschedules include both the replaced and replacement instants. PostgreSQL `timestamptz` remains the source of truth; no display conversion changes appointment or reminder scheduling.

The bot presents the familiar UTC date/time and a Discord-native `<t:UNIX:F>` value. Discord renders that tag in each recipient's configured locale and timezone, including daylight-saving changes. The platform therefore does not infer a timezone, store fixed offsets, or require a player timezone preference. Invalid or absent legacy timing data produces a bounded `Your time: unavailable` line rather than malformed Discord markup.

PostgreSQL and the website booking domain remain authoritative. The website decides which Discord notification exists and stores durable work; each profile-specific bot only discovers current managers, delivers or edits Discord DMs, handles button interactions, and reports bounded outcomes over HTTPS. The bot receives no website database credentials and contains no duplicate approval SQL.

## Trust boundary and authentication

Every internal endpoint is `POST`-only and bound to the hostname-derived profile. Requests carry `X-Booking-Profile`, a Unix timestamp, a unique nonce, and an `X-Booking-Signature` HMAC. The canonical input is version, HTTP method, path, timestamp, nonce, and the SHA-256 hash of the exact body. The website permits five minutes of clock skew and persists used nonces, so a signed request cannot be replayed. WOS and Kingshot use separate secrets; a valid R.A.C.H.I.E signature cannot authorize a P.E.G.G.I.E operation.

Website variables (server-only, 32 or more characters):

- `RACHIE_BOOKING_INTEGRATION_SECRET`
- `PEGGIE_BOOKING_INTEGRATION_SECRET`

Each corresponding bot deployment uses:

- `BOOKING_WEBSITE_INTEGRATION_ENABLED=true`
- `BOOKING_WEBSITE_BASE_URL=https://<that-profile-hostname>`
- `BOOKING_WEBSITE_INTEGRATION_SECRET=<matching-profile-secret>`
- optional `BOOKING_WEBSITE_POLL_INTERVAL_MS` (default 10000; minimum 5000)

Never place these values in a browser variable, URL query, repository, or log.

## Notification lifecycle

Migration `0006` adds a profile-scoped durable notification queue and replay nonces. The bot's claim call transactionally materializes supported `booking_outbox` events and claims due work with `FOR UPDATE SKIP LOCKED` and a lease. Stable uniqueness keys prevent two logical jobs. Send, retry, terminal failure, edit, and superseded reminder state survive restarts.

Materialisation is deliberately lazy: guest submission writes `booking.approval.requested` to `booking_outbox` in the same transaction as the pending request. The authenticated bot claim endpoint first converts pending supported outbox events into `booking_discord_notifications`, marks those outbox events delivered, and then claims due notification rows. There is no separate bridge process to start. If the bot never polls, the authoritative outbox event remains pending; the absence of a notification row alone does not mean guest submission failed.

- `booking.created` queues a confirmed-player DM and a reminder when the booking has a Discord user.
- `booking.rescheduled` queues old/new details, supersedes the old reminder, and schedules the replacement reminder.
- `booking.cancelled` queues the cancellation and suppresses an unsent reminder.
- approval requested queues manager discovery; confirmed, denied, and expired events queue edits for every stored manager message.
- an approved Discord-linked request queues an attributed player DM; a guest with no Discord ID does not.

Discord forbidden/closed-DM errors become permanent delivery failures. Temporary Discord or network failures use bounded persisted backoff. Neither failure changes booking state. Sends use a stable Discord nonce with nonce enforcement, reducing the ordinary send-before-ack duplicate window without exposing queue or booking identifiers in the DM.

## Manager discovery and buttons

The bot fetches current members of every Discord guild linked to the community. It selects the guild owner, members whose current permissions include Administrator, and members holding that guild's configured `bot_manager_role_id`, then deduplicates Discord users across guilds. Successfully sent copies are recorded in `booking_approval_discord_messages`.

This requires the privileged **Server Members Intent** (`GuildMembers`) on each Discord application. Enable it later under Discord Developer Portal → Application → Bot → Privileged Gateway Intents before enabling this integration. The code requests that intent only when the integration has complete, explicitly enabled configuration. Do not enable notification delivery without it: discovering only cached members would silently miss authorised managers.

An Approve/Deny custom ID carries only an opaque request UUID and action. It is not authorization. The website authenticates the bot request, resolves the request and community inside the hostname profile, then live-checks the actor through any currently linked guild using the existing owner/Administrator/manager-role verifier. The existing transactional approval service performs the first-transition-wins mutation and audit. Duplicate clicks return the authoritative approved, denied, or expired state. Final jobs edit every recorded copy and remove its buttons; failed edits remain retryable.

## Reminders and profile isolation

The appointment instant is derived from the canonical slot (`starts_at`, or booking date plus local start time in the slot IANA timezone). One reminder per confirmed booking becomes due 30 minutes before that instant. It is not created for past appointments or bookings without a canonical Discord user. Reschedule/cancel state changes operate only on that profile's reminder rows.

Every table uses forced RLS and every key, query, claim, nonce, and API request includes `game_profile`. A WOS bot ignores Kingshot work even if incorrectly returned by a mock or intermediary. Use the WOS hostname and secret only on R.A.C.H.I.E, and the Kingshot hostname and secret only on P.E.G.G.I.E.

The website logs the first successfully authenticated claim per profile and non-zero claim counts. It records each authentication failure category once per process and uses only static operation/profile/category fields. Empty ten-second polls are not logged repeatedly, and signatures, nonces, secrets, headers, or private work payloads are never logged.

## Staged rollout and degraded operation

1. Apply migration `0006` with the migration role and apply the updated named runtime grants.
2. Deploy the website with both independent profile secrets. Booking operations continue even while bots are disabled; work remains durable.
3. Enable Server Members Intent for both Discord applications and confirm the bots can view every linked guild.
4. Configure one bot profile at a time with its matching hostname/secret, then set `BOOKING_WEBSITE_INTEGRATION_ENABLED=true`.
5. Exercise a guest approval, automatic booking, reschedule, cancellation, reminder, forbidden DM, duplicate click, and two-manager convergence in staging.

For immediate rollback, set `BOOKING_WEBSITE_INTEGRATION_ENABLED=false` on the affected bot. Do not reverse migration `0006` or delete queue rows. Website bookings continue and pending work can resume after the integration is re-enabled. If Discord or the website is temporarily unavailable, the bot logs only profile, static work type, and bounded error code—never bodies, credentials, tokens, or booking payloads.

## Local tests

Website tests use a disposable PostgreSQL 18.6 database through `TEST_DATABASE_URL`. Bot tests use mocked Discord and HTTP boundaries and must never use a real token or URL.

```bash
# website
npm run lint
npx tsc --noEmit --pretty false
TEST_DATABASE_URL=postgresql://... npm test

# bot repository
npm run check
npm test
```
