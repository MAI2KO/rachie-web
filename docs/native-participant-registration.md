# Native Participant Registration

## Endpoint And Ownership

`PUT /api/v1/booking/me/registration` creates or updates the active registration
owned by the current authenticated website user. Ownership is always:

```text
authenticated Discord user ID
+ hostname-derived game profile
+ selected verified community
```

The request body cannot choose a Discord user, profile, community UUID, guild, or
participant. Extra fields with those names have no authority and are ignored. The
profile-bound repository transaction still sets local `app.game_profile`, and
forced PostgreSQL RLS applies to every participant, idempotency, and audit query.

The body contains only:

```json
{
  "playerId": "123456789",
  "inGameName": "Player Name",
  "alliance": "ABC"
}
```

The public response returns `created` or `updated` plus the current authenticated
user's resulting registration. It does not return internal participant/community
IDs, Discord IDs, session identifiers, idempotency hashes, or audit records.

## Validation And Normalization

Validation is centralized in the native registration domain and is applied again
at the service boundary:

- `playerId`: trimmed, digits only, 1–20 characters;
- `inGameName`: Unicode NFC normalized and trimmed, 1–30 JavaScript characters,
  with ASCII control characters rejected;
- `alliance`: trimmed, uppercased, and exactly three ASCII letters or digits.

These limits retain the stronger Discord registration expectations recovered from
the legacy bot while not inheriting Apps Script's weak server-side checks. Player
ID is not globally unique. Different Discord users and different communities may
legitimately use the same value.

## Create And Update Semantics

The service locks active registrations for the trusted Discord user/community. No
row creates one `website` participant; one row updates that owned participant; a
malformed duplicate state is rejected rather than choosing a record. The database
partial unique index independently permits only one active Discord registration
per profile/community/user.

Every successful create or update writes `booking_change_events` in the same
transaction. Events use `participant_registered` or
`participant_registration_updated`, the authenticated Discord actor ID, and
bounded before/after player ID, in-game name, and alliance values. They never
contain cookies, OAuth tokens, session tokens, CSRF values, or client secrets.

Registration does not enqueue `booking_outbox`: there is no Discord notification
or external consumer for this event yet, so an undeliverable integration message
would add storage and operational state without a consumer. The audit event is the
durable history required for this phase.

Existing `minister_bookings` identity fields are immutable snapshots. Updating a
registration changes only `booking_participants`; it never rewrites player ID,
name, or alliance snapshots on confirmed or historical bookings. `GET
/api/v1/booking/me` immediately reflects the updated registration while retaining
the original values on existing bookings.

## Idempotency

Every request requires `Idempotency-Key`:

- 16–128 ASCII characters;
- only letters, digits, `.`, `_`, `:`, and `-`;
- surrounding whitespace is removed.

The raw key is not stored. A SHA-256 storage key binds it to profile, selected
community, authenticated Discord user, and public key. The request fingerprint is
a separate SHA-256 digest over the operation, the same trusted ownership tuple,
and the canonical validated payload.

The service claims the existing `booking_idempotency_keys` row in the same
transaction as participant and audit changes. An identical retry returns the
original stored status and response body and adds `Idempotency-Replayed: true`.
Concurrent identical requests serialize on the database key and create/audit only
once. Reusing a key with a different payload or operation returns
`409 idempotency_conflict`. A failed transaction rolls the claim back, allowing a
safe retry.

## Request Protection

The mutation requires all of the following before validation or persistence:

- a valid hostname/profile-scoped session and selected verified community;
- Discord guild membership verified no more than five minutes earlier;
- the existing HMAC CSRF value in `X-CSRF-Token`, bound to the same raw session
  cookie and game profile;
- matching request `Origin` when that header is present;
- the PostgreSQL-backed `future_booking_mutation` limit of 10 attempts per minute,
  scoped to the session and selected community.

Stable errors include `authentication_required`, `membership_refresh_required`,
`community_selection_required`, `csrf_invalid`, `rate_limited`,
`invalid_registration`, `idempotency_key_invalid`, `idempotency_conflict`, and
controlled `unavailable`. SQL, stack traces, and database details are never
returned.

## Remaining Before Appointment Writes

- participant unregister/delete behavior;
- idempotent slot booking transactions and active-slot locking;
- resource requirement validation;
- reschedule and cancellation semantics;
- mutation audit/outbox events and Discord delivery consumers;
- abuse monitoring and production proxy verification;
- the public booking interface and profile-aware State/Kingdom presentation.
