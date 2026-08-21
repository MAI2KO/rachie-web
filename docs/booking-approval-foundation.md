# Guest booking and approval foundation

The public and manager appointment board built on this foundation is documented
in [`public-appointment-board.md`](./public-appointment-board.md).

This foundation adds PostgreSQL domain, repository, service, and API-core support
for State/Kingdom-scoped guest booking links and administrator approval. The
follow-up board phase adds public and administrator board UI. It does not add the
World Map, Discord buttons, or a Discord delivery worker.

PostgreSQL remains the sole booking source of truth. Existing authenticated
Discord bookings remain first-come-first-served and auto-approved.

## State machine

Database values are lowercase; the product states are:

```text
PENDING_APPROVAL -> CONFIRMED
PENDING_APPROVAL -> DENIED
PENDING_APPROVAL -> EXPIRED
```

No transition is permitted from a terminal state. `CONFIRMED` points to exactly
one `minister_bookings` row. `DENIED` and `EXPIRED` retain the complete request,
answers, timestamps, and audit history without occupying the slot.

Guest submissions always enter `PENDING_APPROVAL`. The configured default hold
is 1,800 seconds (30 minutes) in
`booking_settings.pending_hold_duration_seconds`; the constraint permits a
future operator policy from 60 seconds through 24 hours.

`booking_settings.booking_approval_policy` supports `auto_approve` and
`require_approval`. Existing and migrated communities default to
`auto_approve`. Guest links ignore that setting and always require approval.
The current Discord-authenticated creation endpoint intentionally remains the
existing auto-approve path; routing authenticated requests through
`require_approval` is future UI/API work, so operators must not switch that
setting yet expecting changed website behaviour.

## Holds and concurrency

Every contender locks the same `appointment_slots` row before deciding whether
the slot can be occupied:

- guest request creation;
- normal Discord-authenticated creation;
- authenticated rescheduling;
- approval, denial, and expiry.

After acquiring that lock, code checks confirmed bookings, administrative slot
blocks, and unexpired pending requests. A partial unique index permits only one
`pending_approval` request per profile/slot, and the existing partial unique
index permits only one confirmed booking per profile/slot. This combination of
transactional slot serialization and final uniqueness constraints prevents a
guest/guest or guest/authenticated double claim.

Approval inserts the confirmed booking, copies requirement snapshots, links it
to the request, transitions the request, writes the audit event, marks every
sent Discord message copy for update, and emits an outbox event in one
transaction. A failure rolls back all of those writes.

Two administrator actions serialize on the slot and request. Only the first
valid transition commits. Approval versus expiry uses the same order, so either
the booking is confirmed before the deadline or the request becomes expired;
both cannot occur.

An expired timestamp stops blocking availability immediately. Explicit expiry
and later guest claims transition the retained request to `expired` and record
an audit/outbox event. A scheduled expiry worker is deliberately not included;
it can later call the same expiry service for due request IDs.

## Guest share links

`booking_guest_share_links` stores only a SHA-256 token hash and a short
non-secret hint. Generated tokens contain 256 bits of randomness and token hashes
are globally unique, so one token resolves to exactly one profile/community.
The hostname-derived profile remains authoritative; a request cannot supply a
different profile or community in its payload.

Links are revocable, may expire, and record rotation ancestry through
`rotated_from_link_id`. Rotation means revoking the previous row and creating a
new random token; plaintext tokens are returned only at creation time by future
operator tooling and are never persisted. Link possession authorizes only guest
submission. It is not accepted by any manager service.

The guest API core consumes the dedicated `guest_booking_submission` rate-limit
policy before service execution. Its subject combines the hashed link token and
a trusted server-derived client subject; the raw token and IP are not stored in
rate-limit buckets. The initial policy is five submissions per ten-minute
window. `guest_booking_read` is separately configurable at 120 reads per minute.
CAPTCHA is not part of this foundation.

## Manager authorization boundary

Manager services accept only a trusted server-created assertion containing the
profile, authorized community ID, and canonical Discord user ID. Client payloads
cannot choose that scope. A manager assertion for one community is rejected for
another community, including communities with the same code in the other game
profile.

`booking_discord_guilds.bot_manager_role_id` stores the configured “can manage
the bot” role per linked guild. A future Discord authorization adapter must grant
the trusted assertion when the authenticated user is either:

- an administrator of any linked guild; or
- a current member of that linked guild's configured manager role.

That live Discord permission/role resolver is remaining work. Display names may
be stored for audit presentation but never establish identity; Discord user ID
is canonical.

## Public and administrator representations

The public board serializer constructs a new object containing only:

- service;
- date;
- display time;
- `available`, `pending`, or `booked`;
- confirmed alliance abbreviation and in-game player name only when booked.

Pending player names and alliances, Player IDs, Discord IDs, requirements, speed-ups, request
IDs, slot IDs, and audit data are never present, including as hidden JSON
properties. This is a server serialization boundary, not frontend filtering.

The administrator serializer requires the trusted manager assertion and may
return request/slot IDs, player name, Player ID, alliance, Discord identity for
future authenticated approval requests, requirement answers, hold/decision
timestamps, decision actor, confirmed booking ID, and audit history.

## Audit and Discord notification persistence

`booking_approval_events` records submission, approval, denial, and expiry with
profile, community, request, previous/resulting states, timestamp, correlation
ID, canonical acting Discord user ID, and optional trusted display name.

`booking_approval_discord_messages` records each future Discord delivery copy:
guild, channel, message ID, optional recipient, delivery state, attempts, and
timestamps. Approval, denial, or expiry changes every already-sent copy to
`update_pending` and emits an outbox event. A future worker can edit every row
for that request to APPROVED, DENIED, or EXPIRED and then mark it `updated`.
No bot token, OAuth credential, or other secret is stored.

## Tables and compatibility

Migration `0005_guest_booking_approval_foundation.sql` adds:

- `booking_guest_share_links`;
- `booking_approval_requests`;
- `booking_approval_request_answers`;
- `booking_approval_events`;
- `booking_approval_discord_messages`;
- approval policy and hold duration on `booking_settings`;
- guild-scoped manager role configuration on `booking_discord_guilds`;
- optional approval-request lineage on `minister_bookings`.

All new tables use forced profile RLS. Existing rows receive
`booking_approval_policy='auto_approve'` and
`pending_hold_duration_seconds=1800`; no reset or rebootstrap is required.

Remaining work includes public route/UI composition, share-link operator
creation/rotation UI, manager authorization against Discord, administrator
endpoints/UI, a scheduled expiry sweep, Discord delivery/edit workers, and the
World Map/visual booking board.
