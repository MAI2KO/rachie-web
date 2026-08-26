# Booking Admin v1

Booking Admin is available to an existing authorized community manager at
`/state/{communityCode}/admin` for WOS and `/kingdom/{communityCode}/admin` for
Kingshot. It reuses the appointment-board manager authorization check against
the exact profile and community: Discord guild owner, Discord Administrator,
or the configured bot-manager role.

The manager-only endpoint is `GET` and `PATCH`
`/api/v1/booking-admin/{communityCode}`. Mutations require the authenticated
session CSRF token, are rate-limited, accept one strictly validated boolean
change, run in a profile-scoped transaction, and add a
`booking_admin_updated` entry to `booking_change_events`.

Booking enablement reuses `booking_communities.bookings_open`. Requirement
controls reuse the six existing boolean columns in `booking_settings`, retaining
their per-community and per-service meanings. Service enablement required the
additive `booking_community_services` table because
`minister_services.active` is a profile-wide catalog default and must not be
mutable by one State or Kingdom manager on behalf of other communities. Missing
override rows inherit the catalog default; the migration snapshots that default
for existing communities.

Booking Admin v1 lists existing non-archived booking windows and service dates
read-only. Creating dates, generating slots, changing slot availability, and
deleting configuration are deferred to v2.

For WOS, the page also shows the current or next deterministic automatic cycle,
including its UTC opening/closing instants and the three appointment dates. The
automatic schedule remains separate from the manager-controlled booking toggle.
