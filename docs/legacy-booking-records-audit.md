# Legacy booking records audit

## Result

No Legacy tab is enabled yet. The two reviewed Apps Script deployments do not
provide a safe manager-wide historical-record endpoint, and the source snapshots
in `legacy-reference/` are explicitly immutable deployment references. Exposing
the Sheets directly or reusing a player-scoped endpoint would either weaken
access control or provide an incomplete, misleading history.

## Architecture found

- R.A.C.H.I.E (WOS) and P.E.G.G.I.E (Kingshot) have separate Apps Script
  deployments, registry spreadsheets, and per-community spreadsheets.
- `doGet?state=...` renders the legacy public booking page. Its only JSON-like
  read action is `action=times`, scoped by a sheet ID and sheet API key.
- Bot `doPost` requests use the shared admin API key. Public `book`, `unbook`,
  and `register` actions use the per-sheet state API key.
- A registry maps State/Kingdom codes and Discord guilds to a community Sheet.
  Each community Sheet contains `Minister Appointments`, `bot_users`, and
  `bot_config` data. Booking rows occupy a fixed grid rather than an append-only
  history table.
- Booking cycles clear or overwrite that grid. Consequently the Sheets contain
  only whatever legacy records were retained at the time; they are not a
  complete historical ledger.
- `get_my_bookings_for_server` is scoped to one Discord user and returns only
  their current three appointment cells. `get_times_for_server` returns
  availability. Neither can support a manager history view.

The reviewed WOS and Kingshot `WebApi.gs` files have the same endpoint shape.
Profile isolation currently comes from using different deployments and
registries, not from a profile parameter accepted by one shared endpoint.

## Safe read-only design

The smallest safe live adapter would require an intentionally deployed Apps
Script change for each profile:

1. Add a narrow admin-key-protected read action that resolves the caller's
   Discord guild to exactly one registry community. It must not accept an
   arbitrary spreadsheet ID from the website.
2. Return a bounded, sanitized read-only projection of retained appointment
   cells: community code, service/date, time, player display name/alliance, and
   legacy status. Do not return API keys, passwords, email access lists, Discord
   IDs, sheet IDs, or config cells.
3. Call that action only from a website server route after the existing Discord
   manager authorization has resolved the exact profile and community. Sign or
   authenticate the server-to-server request, apply timeouts/rate limits, and
   never expose the Apps Script admin key to the browser.
4. Render the result as read-only; do not add mutation methods to the adapter.

Because the grid is mutable and incomplete, the preferred archival design is a
one-time, profile-aware snapshot/import into dedicated PostgreSQL legacy tables.
Rows should carry `game_profile`, the native `community_id`, source Sheet
identity, source row coordinates, imported-at time, and a deterministic source
fingerprint. Apply forced RLS using `app.game_profile`, expose only a bounded
manager read repository, and keep the tables outside every native booking write
service. Preserve the original Sheets until the import is reconciled and signed
off.

No public iframe, public Sheet permission, browser-held admin key, or
write-capable legacy website route is acceptable.

## Retention and authority

- PostgreSQL remains authoritative for all new registrations and bookings.
- The old appointment grids and `bot_users` rows are historical-only once bot
  command migration is deployed.
- The legacy registry/`bot_config` data is not yet wholly archival: current
  banter configuration and the custom bot-admin-role lookup still call Apps
  Script. Those dependencies must move to PostgreSQL before either deployment or
  its Sheets can be archived.
- Nothing should be deleted now. Eventual deletion/archival requires a verified
  import, retention decision, removal of the remaining config dependencies, and
  separate operator approval.
