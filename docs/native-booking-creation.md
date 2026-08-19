# Native booking creation

## Scope

`POST /api/v1/bookings` creates one new confirmed native appointment. It does not
reschedule, cancel, unregister, perform admin booking, deliver notifications, call
Apps Script, or switch either Discord bot.

Authority comes only from the hostname-derived profile, authenticated Discord
session, selected verified community, fresh membership assertion, and active
participant registration. Only `serviceCode`, `slotId`, and `requirements` are
read from the request body; ownership-like fields have no authority.

## Contract

The request requires the established mutation CSRF token and an `Idempotency-Key`:

```json
{
  "serviceCode": "construction",
  "slotId": "opaque-slot-uuid",
  "requirements": { "fc": 100, "rfc": 20 }
}
```

A successful `201` response contains only public confirmation data:

```json
{
  "booking": {
    "bookingId": "opaque-booking-uuid",
    "serviceCode": "construction",
    "serviceLabel": "Construction",
    "date": "2026-08-20",
    "displayTime": "00:00",
    "playerName": "Player Name",
    "alliance": "ABC",
    "requirements": [
      { "code": "fc", "label": "Fire Crystals", "value": 100 }
    ],
    "status": "confirmed"
  }
}
```

An identical completed retry returns the stored response and
`Idempotency-Replayed: true`. The key is server-scoped to profile, community, and
Discord user and bound to the operation and canonical request. A changed request
with the same key returns `409 idempotency_conflict`.

## Transaction and locking

Creation runs in one PostgreSQL transaction after setting `app.game_profile`. It
checks the active/open community, locks the owned participant and selected slot,
then re-checks the window state and timestamps, service, slot state, active blocks,
slot occupancy, and existing participant booking. Earlier availability output is
never authoritative.

Partial unique indexes are the final race guards. Migration `0004` adds an active
participant/service/window guard alongside the existing slot and player-snapshot
guards. A registration edit therefore cannot allow a second active booking for the
same participant and service. Creation returns `409 booking_already_exists`; it
never silently reschedules.

## Requirements

Only enabled codes are accepted: construction supports `fc`, `rfc`, and
`speedups`; research supports `shards` and `speedups`; troop supports `speedups`.
Every enabled answer is required and must be a positive base-10 whole number from
1 through 999,999. Disabled, unrelated, and unknown answers are rejected.

WOS uses Fire Crystals, Refined Fire Crystals, and Fire Crystal Shards. Kingshot
uses Truegold, Tempered Truegold, and Truegold Dust. Speedups use a neutral label
and the `days` unit.

## Atomic records

The transaction stores immutable player ID, name, alliance, date, and display-time
snapshots; typed requirement answers; a bounded `booking_created` audit event; a
pending `booking.created` outbox event; and the completed idempotency response.
Failure of any write rolls everything back. Outbox delivery is not implemented.

Controlled errors include `authentication_required`,
`membership_refresh_required`, `community_selection_required`,
`registration_required`, `bookings_closed`, `booking_window_unavailable`,
`invalid_service`, `invalid_slot`, `slot_unavailable`,
`booking_already_exists`, `invalid_requirements`, `csrf_invalid`,
`rate_limited`, `idempotency_conflict`, and `service_unavailable`.

## Related mutations

Owned rescheduling and cancellation are documented in
[native-booking-mutations.md](native-booking-mutations.md). Admin operations and
notification delivery remain unimplemented.
