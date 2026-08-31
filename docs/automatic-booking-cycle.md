# Automatic WOS Booking Cycle

The website reconciles Whiteout Survival booking cycles from the fixed
`2026-08-05T00:00:00Z` historical anchor at exact 28-day intervals. Automated
generation starts with the 2 September 2026 cycle. The platform fallback opens
Wednesday at 00:00 UTC and closes Sunday at 12:00 UTC. A community may store a
recurring opening minute and closing offset from that same Wednesday anchor in
`booking_community_window_defaults`; absence of a row preserves the fallback.
Construction, Research, and Troop appointments remain fixed to the following
Monday, Tuesday, and Thursday.

Booking Admin can store a community recurring default and one explicit
`opens_at`/`closes_at` override for the displayed WOS cycle. It cannot edit
service dates or a global schedule. A recurring close must be after opening and
at most 14 days later. An
override is bounded to the cycle's pre-appointment interval, cannot rewrite a
closed cycle, and requires confirmation when the cycle is already open. The
following cycle uses the community recurring default, or the platform fallback
when no community row exists, unless it has its own override row.

At Node.js server startup and every minute thereafter, the reconciler ensures
the current and next cycle exist for each active WOS community. It clones that
community's latest existing slot template into deterministic window, date, and
slot identities. PostgreSQL uniqueness constraints, a community-scoped advisory
lock, and conflict-safe inserts make restarts and overlapping instances
idempotent. A delayed run derives the correct cycle from the anchor and closes
timed-out open windows; it never schedules relative to the process run time.

At the effective opening (default or override), the same transaction rotates to one window-bound guest link and
inserts one `booking_window_open` Discord work item. The opaque token is derived
from the profile-specific integration secret and window identity so a claimed
retry can reproduce it, while only its SHA-256 hash and hint are persisted.
The bot uses the signed work API to post in the managed minister sign-up channel
and DM a manager copy. Reconciliation at the effective close closes the window and
revokes its guest link. Work missed until after closing is superseded rather
than posted stale. Changing an override after the opening work item exists
updates window and guest-link lifecycle timestamps but cannot duplicate the
window-scoped announcement.

`booking_communities.bookings_open` remains the manager-controlled emergency
override. Reconciliation never changes it. Participant availability therefore
requires both manager enablement and an automatically open window. Kingshot is
not reconciled by this WOS-specific rule.

Migrations `0008_booking_window_announcements.sql`,
`0009_access_overrides_points.sql`, and
`0013_community_booking_window_defaults.sql` are required. Deployment must refresh the documented runtime
role grants so the website can insert windows, service dates, and slots and can
update only the reviewed booking-window lifecycle columns.
