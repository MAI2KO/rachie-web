# Automatic WOS Booking Cycle

The website reconciles Whiteout Survival booking cycles from the fixed
`2026-08-05T00:00:00Z` historical anchor at exact 28-day intervals. Automated
generation starts with the 2 September 2026 cycle. Every cycle opens Wednesday
at 00:00 UTC, closes Sunday at 12:00 UTC, and assigns Construction, Research,
and Troop appointments to the following Monday, Tuesday, and Thursday.

At Node.js server startup and every minute thereafter, the reconciler ensures
the current and next cycle exist for each active WOS community. It clones that
community's latest existing slot template into deterministic window, date, and
slot identities. PostgreSQL uniqueness constraints, a community-scoped advisory
lock, and conflict-safe inserts make restarts and overlapping instances
idempotent. A delayed run derives the correct cycle from the anchor and closes
timed-out open windows; it never schedules relative to the process run time.

`booking_communities.bookings_open` remains the manager-controlled emergency
override. Reconciliation never changes it. Participant availability therefore
requires both manager enablement and an automatically open window. Kingshot is
not reconciled by this WOS-specific rule.

No schema migration is required. Deployment must refresh the documented runtime
role grants so the website can insert windows, service dates, and slots and can
update only the reviewed booking-window lifecycle columns.
