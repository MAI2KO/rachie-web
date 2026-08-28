# Alliance access, cycle overrides, and points

Migration `0009_access_overrides_points.sql` adds three native foundations.

Alliance website access is represented by an active, profile/community/user/
source-guild `community_access_grants` row. Migration `0009` labels every
pre-existing guild link `unclassified` and conservatively backfills
`legacy_session` grants only where the parent website session is unrevoked and
unexpired. Those grants preserve existing access without conferring alliance or
State topology authority. New grants use active, explicitly classified alliance
guilds; shared State/Kingdom guild membership alone is topology and
administration context, not a participant grant. Booking Admin may soft-
revoke an alliance link only after the profile bot's signed internal listener
confirms that the actor owns that exact alliance Discord or the configured
shared State/Kingdom Discord. The normal bot-manager role and Discord
Administrator permission are insufficient. Revocation also revokes every grant
from that source, repoints sessions with an independent active alliance grant,
and removes the remaining source sessions. The shared guild itself cannot be
unlinked through this flow.

State/Kingdom classification is a separate administrative bootstrap operation.
It never revokes grants or changes session-community rows. Active grants that
were labelled `alliance_discord` for the newly classified State guild are
reconciled to `legacy_session` so existing users retain access without creating
State-derived alliance authority. A reviewed configuration explicitly supplies
`stateGuild` or `null`; it never guesses from a guild name, the number of links,
or cross-profile reuse.

`booking_cycle_schedule_overrides` stores a WOS community and cycle-index-
specific open/close pair. Defaults remain Wednesday 00:00 through Sunday 12:00
UTC. Service dates remain fixed. The automatic reconciler applies the effective
times to availability, one window-bound guest link, and one idempotent opening
announcement. `booking_communities.bookings_open` remains an independent manual
master switch.

The append-only ledgers derive balances from `SUM(points_delta)`; no mutable
balance exists. Initial defaults are centralized in `server/points/domain-core.mjs`:

- new canonical player registration: **100** player points, once per participant;
- initial confirmed appointment: **25** player points, once per participant,
  cycle, and service (so cancel/recreate cannot farm the award);
- first valid booking from one active alliance in a cycle: **50** community
  points, once per community/window/source guild.

Updates to registration, pending/rejected guest requests, reschedules, and a
linked but inactive guild do not create awards. Deterministic profile-scoped
idempotency keys make retries and restarts safe. Negative entries are supported
for future spending, while triggers reject update and delete of historical rows.
