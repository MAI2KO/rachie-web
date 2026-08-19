# Authenticated Native Booking Context

## Trust Boundary

All native booking reads use one server-only context resolved in this order:

```text
request Host / trusted forwarded host
  -> brand and game profile
  -> host-only opaque session cookie
  -> profile-scoped session under forced PostgreSQL RLS
  -> session's selected community
  -> recorded Discord guild/community mapping
  -> bounded membership verification age
```

The resulting context contains the hostname-derived profile, hashed session
identity, authenticated Discord identity, selected internal community ID, public
community labels, matching Discord guild ID, and membership verification time.
Only server modules receive this object. Booking services never parse cookies,
OAuth tokens, profile query values, community IDs, player IDs, or guild IDs from
the request.

`WOS_NATIVE_BOOKING_COMMUNITY_CODE` and
`KINGSHOT_NATIVE_BOOKING_COMMUNITY_CODE` remain development-only helpers for old
isolated read-service work. The authenticated `/api/v1/booking/*` routes do not
read them and never use them as authorization.

## Authenticated Read Routes

- `GET /api/v1/booking/context`
- `GET /api/v1/booking/availability?service=construction`
- `GET /api/v1/booking/me`

All require a valid session and selected verified community. Missing, expired, or
revoked sessions return `401` with `authentication_required`. Stale membership
returns `401` with `membership_refresh_required`. A valid session without a
selection returns `409` with `community_selection_required`. Responses use
`Cache-Control: no-store`.

`/me` returns only the selected community summary, the active registration owned
by the authenticated Discord user in that community, and that participant's
confirmed bookings. The ownership key is always:

```text
authenticated Discord user ID
+ hostname-derived game profile
+ selected verified community
```

Player ID alone is never ownership authority. No registration produces an
explicit `unregistered` state. The repository reads at most two matching active
records; if malformed imported data ever contains duplicates, the service rejects
the result as ambiguous instead of choosing one.

## Membership Freshness

Discord guild membership is verified during OAuth login and recorded in
`website_auth_session_communities.verified_at`. OAuth access and refresh tokens
are not retained, so periodic background Discord calls are intentionally
impossible.

Authenticated reads accept that membership lease for 30 minutes. Once stale, the
user must sign in through Discord again; a normal session lookup alone does not
extend membership authority. This avoids a Discord request on every read while
bounding how long removed guild membership remains usable.

Future booking mutations must call the exported mutation freshness assertion,
which uses a stricter five-minute lease. It fails closed with
`membership_refresh_required`. No mutation route exists yet.

## Rate Limiting

Migration `0003_rate_limit_foundation.sql` adds profile-scoped, forced-RLS
`website_rate_limit_buckets`. Fixed-window counters are updated atomically with
PostgreSQL upserts, so limits remain consistent across multiple Railway instances.
Subjects are HMAC-SHA-256 hashes; raw session tokens and network addresses are not
stored.

Current policies are:

| Policy | Limit |
| --- | --- |
| OAuth login | 10 per 10 minutes per network subject |
| OAuth callback | 20 per 10 minutes per network subject |
| Auth session reads | 120 per minute per session/network subject |
| Community changes | 10 per 10 minutes per session |
| Logout | 10 per 10 minutes per session |
| Native booking reads | 120 per minute per session |
| Future booking mutations | 10 per minute per session/community subject |

The future mutation policy exists as a shared definition but is not attached to
an endpoint. Database or limiter failure returns a controlled unavailable response
rather than silently disabling protection. Production network subjects rely on
the deployment proxy supplying the client address in `X-Forwarded-For`; the
application never uses it for profile or community authorization.

## Data Exposure

Authenticated booking responses do not expose OAuth tokens, raw session tokens,
session hashes, internal participant/community IDs, Discord guild IDs, other
communities, other participants, audit events, or outbox data. Slot and booking
UUIDs are returned only as opaque identifiers where the booking workflow requires
them, and booking IDs are limited to the authenticated participant's own confirmed
bookings.

## Remaining Before Appointment Writes

- define idempotent create, reschedule, and cancellation service transactions;
- bind the five-minute membership assertion and future mutation rate policy to
  every mutation entry point;
- add CSRF, request-id, idempotency, audit-event, and outbox requirements to those
  entry points;
- decide whether a community-link change should proactively revoke affected
  sessions instead of waiting for the membership lease to expire;
- configure production runtime and migration roles without superuser or
  `BYPASSRLS` privileges;
- build the public booking UI.

Authenticated participant create/update is now implemented as the first native
mutation. Its ownership, validation, replay, and audit contract is documented in
[native-participant-registration.md](native-participant-registration.md).
