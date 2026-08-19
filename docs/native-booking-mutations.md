# Native booking rescheduling and cancellation

## Routes and ownership

- `PATCH /api/v1/bookings/{bookingId}` reschedules an owned active booking.
- `DELETE /api/v1/bookings/{bookingId}` cancels an owned active booking.

Both require the established CSRF token, five-minute Discord membership freshness,
mutation rate limit, and `Idempotency-Key`. The hostname profile, selected verified
community, Discord identity, and active participant registration are authoritative.
The opaque path ID identifies only a candidate. Foreign-profile, foreign-community,
and other-user IDs all return `booking_not_found` without confirming existence.

## Rescheduling

PATCH accepts only a new `slotId` and current `requirements`. The target must be in
the original booking's service and window. Community bookings must be open, the
window and service active, and the target slot available and unblocked. Requirement
answers are revalidated against current settings, not the historical settings from
the original booking.

The immutable lineage column is `rescheduled_from_booking_id`; it means the current
row replaces that prior row. After acquiring a per-booking transaction advisory
lock, community row lock, participant lock, current-booking lock, and target-slot
lock, one data-modifying CTE marks the old row `replaced` and inserts the confirmed
successor as a single SQL statement. If insertion or any later audit/outbox write
fails, PostgreSQL restores the original confirmed row. Historical snapshots and
requirement answers are never edited. The successor captures the participant's
current registration snapshot and current requirement answers.

A same-slot request with unchanged canonical requirement answers is a `200`
`unchanged` no-op. It completes idempotency but creates no booking, audit, or outbox
history. Changed valid answers on the same slot create a meaningful replacement.

## Cancellation

DELETE transitions the owned confirmed row to `cancelled`; it never deletes the
row or its snapshots. The partial active-slot index immediately frees the slot on
commit. Cancellation is deliberately allowed while `bookings_open` is false or the
window is closed, while rescheduling is blocked. An archived/missing community or
foreign booking still fails as `booking_not_found`.

An identical DELETE retry with the same key replays the original `200` result.
A later request with a different key receives the stable `booking_not_active`
conflict because the row is already historical.

## Idempotency, audit, and outbox

Keys are scoped to profile, community, and Discord user and bound to operation,
target booking, and canonical PATCH data. Reuse for different data or another
mutation returns `409 idempotency_conflict`.

Successful changes atomically write bounded `booking_rescheduled` or
`booking_cancelled` audit events and pending `booking.rescheduled` or
`booking.cancelled` outbox events. Delivery remains unimplemented. Exact no-op
reschedules do not emit events.

Public reschedule responses reuse the booking confirmation model. Cancellation
returns only booking reference, service code/label, date, display time, and
`cancelled` status.

## Remaining work

Admin add/remove, clear-bookings, slot reservation, notification delivery, legacy
import, bot switching, unregister, and public booking UI remain out of scope.
