# Public State/Kingdom Alliance Events

The Discord bot scheduler remains the only source of truth. The website does not copy or edit schedules. Each bot profile exposes an optional, signed, read-only internal endpoint; the website calls that endpoint from the server and converts its response again into a deliberately small public model.

The bot scheduler and booking website currently use separate configured PostgreSQL databases. This integration therefore avoids giving the public website scheduler-database credentials. Configure `RACHIE_ALLIANCE_EVENTS_INTERNAL_URL` and `RACHIE_ALLIANCE_EVENTS_INTEGRATION_SECRET` for WOS, and the equivalent `PEGGIE_...` values for Kingshot. URLs must use HTTPS (loopback HTTP is accepted for local testing), and secrets must be at least 32 characters. Use a distinct random secret for each profile.

Routes are `/state/{code}/events` and `/kingdom/{code}/events`. Their parent appointment pages remain `/state/{code}` and `/kingdom/{code}`. Both share the **Appointments / Alliance Events** navigation. `GET /api/v1/communities/{code}/alliance-events` is anonymous; the hostname, never a query parameter or request body, selects WOS or Kingshot.

Only active `scheduled_events` belonging to an enabled profile-scoped State destination/link are eligible. The read never queries canonical `state_events`, so State-wide events are excluded by their authoritative table/scope rather than by names. Paused and soft-deleted alliance events are excluded. Multiple linked alliances are grouped and sorted by alliance name; their events are sorted by next occurrence, then name. The scheduler's existing recurrence engine calculates exactly three upcoming occurrences, including group streams.

The public model contains only profile, community code, alliance display name/optional abbreviation, event name, recurrence days/summary, optional group name, and UTC occurrence timestamps. It excludes every Discord guild/channel/message ID, database ID, delivery/claim record, manager/audit detail, image, secret, and bot setting. No transfer metadata or comparison behavior is present.

UTC is canonical. Server-rendered content shows UTC; a small client component uses the browser's `Intl.DateTimeFormat` after hydration for **Your time**, including browser-managed DST. No timezone is stored or inferred from IP.

The website caches successful profile-and-community reads in-process for 30 seconds. The public response permits 30 seconds of shared caching and 60 seconds of stale revalidation. Failures are not cached. If configuration, the bot endpoint, or scheduler PostgreSQL is unavailable, only Alliance Events shows a bounded unavailable message/503; appointments and the World Map use independent paths and continue working.

The existing top-level `/events` page remains separate and reserved for future website-wide events. Scheduler reminder images are intentionally omitted pending a public asset ownership design. Transfer Helper, Transfer Information, comparison UI, and Transfer Chat are intentionally deferred.
