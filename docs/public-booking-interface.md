# Public booking interface

## Shared flow

`/booking` renders one shared `BookingExperience` for both hostnames. The server
passes the resolved brand configuration; the browser never chooses a profile.
The interface moves through these states without full-page navigation:

1. unauthenticated Discord sign-in;
2. verified community selection when no community is selected;
3. player registration when the selected community has no owned participant;
4. the registered booking dashboard.

The dashboard shows the selected State or Kingdom, player identity, booking-window
state, current appointments, all active services and dates, deterministic available
slots, and only the resource inputs enabled for the selected service.

## Components and model

`components/booking/booking-experience.tsx` owns the client workflow and contains
small reusable controls for notices, buttons, and requirement fields. Keeping the
closely related interaction state together prevents coordination across many thin
components. `booking-ui-model.mjs` contains independently tested profile language,
requirement selection, slot ordering, UI-state resolution, error guidance, and
idempotency-key generation.

WOS presents State, Fire Crystals, Refined Fire Crystals, and Fire Crystal Shards.
Kingshot presents Kingdom, Truegold, Tempered Truegold, and Truegold Dust. Brand
names and profile selection do not appear as literals in the shared component.

## API integration and mutations

The browser uses only `/api/v1/auth/*`, `/api/v1/booking/*`, and
`/api/v1/bookings`. Cookies remain same-origin. Every authenticated mutation sends
the session-provided CSRF token. Mutation attempt keys are generated with
`crypto.randomUUID()` and cached by operation plus canonical user choice. A network
failure retains the same key for a safe retry; a definite HTTP response retires it.
Unrelated requests never share a key.

Creation and rescheduling refresh both `/booking/me` and availability only after a
successful atomic backend response. Cancellation requires an explicit confirmation
step and then refreshes both views. Rescheduling leaves the old appointment visible
until the backend confirms its replacement.

## Errors and accessibility

Stable API codes map to concise guidance. Stale membership and expired
authentication lead to Discord re-authentication. Slot conflicts refresh
availability. Rate limits use `Retry-After`; outages provide a recoverable state.
Error and success notices receive programmatic focus and use alert/status semantics.

Forms use labels, fieldsets, legends, native validation, radio inputs, and keyboard
usable controls. Focus rings are visible, cancellation is never one-click, state is
not communicated by colour alone, and the global reduced-motion rule suppresses
the loading animation for users who request it.

## Mobile behavior

The page starts with a single-column flow. Service controls use three stable tracks,
slot choices use two columns on narrow screens, resource inputs collapse to one
column, and appointment actions remain full-size touch targets. Summary information
reflows without horizontal scrolling. Wider screens add density without changing
the interaction order.

## Remaining visual work

This is the production-oriented functional interface, not the final cinematic
skin. Brand assets, particles, WebGL effects, richer transition choreography, and
notification delivery remain deliberately separate from booking behavior.
