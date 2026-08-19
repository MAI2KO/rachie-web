# Minister Booking Migration Analysis

Status: analysis and planning only. No replacement has been implemented.

Initial analysis date: 2026-08-14

Legacy source reassessment date: 2026-08-14

Bot source revision inspected: `33e3e7ef56ffa0002e2802de47532f968ad6f28d`

## Evidence labels and limits

This document uses the following labels:

- **Verified (bot source):** directly visible in the checked-out Discord bot source.
- **Verified (legacy source):** directly visible in the immutable Apps Script
  snapshots under `legacy-reference/`.
- **Verified (project documentation):** stated by the bot repository documentation.
- **Verified (provided architecture):** supplied as production context for this analysis.
- **Proposed:** a future design, not current behaviour.
- **Unknown:** the available source does not establish the behaviour.

The Apps Script source was recovered after the initial analysis and copied into the
immutable `legacy-reference/rachie-apps-script/` and
`legacy-reference/peggie-apps-script/` directories. Every recovered file was read
and compared for this reassessment. Secret values are intentionally omitted from
this document.

The snapshots prove most application-level behavior, but they do not include Apps
Script manifests, deployment settings, Script Properties, the template
spreadsheets, live per-location spreadsheets, or registry exports. Exact slot
values, formulas, protections, file/script timezones, deployed revisions, and
manual operating practices therefore remain unknown.

The two recovered projects contain byte-identical application logic and HTML. Their
`Constants.gs` values select separate template/registry infrastructure and separate
admin credentials. R.A.C.H.I.E additionally contains a small manual `99Tests.gs`;
P.E.G.G.I.E does not. `Registry.gs` differs only by a final newline.

## Executive summary

**Verified (provided architecture):** R.A.C.H.I.E and P.E.G.G.I.E share bot code but
run as separate Discord applications and deployments. R.A.C.H.I.E uses profile
`wos`; P.E.G.G.I.E uses profile `kingshot`. Each has a separate Apps Script URL,
admin key, deployment, booking Sheet, master Sheet, and registry Sheet.

**Verified (bot source):** the bot sends JSON over HTTP POST to one configured
`APPS_SCRIPT_URL`. Almost all durable booking, registration, state-linking, and
booking administration is delegated to action names in that JSON body. The bot
holds booking/admin selection sessions in process memory with a 15-minute TTL.

**Critical finding:** the Apps Script payload does not contain `game_profile`.
Current profile isolation is achieved operationally by the two separate bot
deployments, Apps Script URLs, keys, and Sheet estates. A shared replacement must
derive the profile from a trusted hostname, endpoint, or credential and must never
trust an arbitrary profile supplied by a client.

**Critical finding:** `APPS_SCRIPT_URL` is not a booking-only boundary. It also
serves state setup/linking, Discord management-role lookup, announcement-channel
configuration, sheet access, and banter settings. Pointing an unchanged bot at a
compatibility API is feasible only if the full action surface used by that bot is
preserved, or if the bot is first changed to use separate service URLs.

**Recommended direction after source recovery:** first split the Discord bot's
single Apps Script client into booking, state/registry, configuration, and banter
clients without changing behavior. Then place only booking traffic behind a
profile-scoped compatibility adapter while the legacy state/Drive operations remain
on Apps Script. Full endpoint emulation remains possible, but is no longer the
preferred first cut because it would unnecessarily reproduce Drive sharing,
spreadsheet lifecycle, registry dashboard, join-password, and banter behavior.

## Sources inspected

### New website repository

- `brands/types.ts`
- `brands/config.ts`
- `brands/resolve.ts`
- `brands/server.ts`
- `brands/presentation.ts`
- `app/layout.tsx`
- `app/booking/page.tsx`
- `components/app-shell.tsx`

These establish that the website resolves `wos` or `kingshot` from the hostname and
passes an already-resolved brand into shared components.

### Discord bot repository

Repository: `/home/mark/VSCode/R-A-C-H-I-E`

- `index.js` (complete current Discord and Apps Script interaction surface)
- `README.md`
- `docs/architecture.md`
- `docs/deployment.md`
- `docs/player-gift-codes.md`
- `src/banterConfig.js`
- `src/botSetupInteractions.js`
- `src/botSetupService.js`
- `src/interactionResponses.js`
- `src/giftCodes/playerMirror.js`
- `src/giftCodes/playerRepository.js`
- `src/giftCodes/playerService.js`
- `src/giftCodes/terminology.js`
- `migrations/011_player_accounts_and_gift_codes.sql`
- `migrations/013_gift_code_community.sql`
- `migrations/015_gift_code_guild_enrolment.sql`
- `migrations/017_bot_managed_discord_setup.sql`
- `migrations/018_player_account_ownership_release.sql`
- `PRIVACY_POLICY.md`
- `TERMS_OF_SERVICE.md`

The bot worktree was read only and clean when inspected.

### Apps Script and Sheets

Immutable snapshot roots:

- `legacy-reference/rachie-apps-script/`
- `legacy-reference/peggie-apps-script/`

Files inspected in each root were `booking.html`, `Constants.gs`, `Setup.gs`,
`Config.gs`, `Registry.gs`, `Booking.gs`, `DiscordAdmin.gs`, and `WebApi.gs`.
R.A.C.H.I.E additionally contains `99Tests.gs`; P.E.G.G.I.E does not.

No manifest, template Sheet, registry export, per-location booking Sheet export, or
deployment configuration is present. No live endpoint or production Sheet was
called. Constants contain production identifiers and an admin credential; their
values are not reproduced here.

## Recovered source comparison

### File-by-file result

| File | Comparison | Migration significance |
| --- | --- | --- |
| `booking.html` | **Verified:** byte-identical | Both snapshots expose the same Whiteout Survival wording and client behavior. The P.E.G.G.I.E page is not Kingshot-localized. |
| `Booking.gs` | **Verified:** byte-identical | Booking, reservation, cancellation, date, resource, and slot-cell logic are the same in the recovered files. |
| `Config.gs` | **Verified:** byte-identical | Both use the same two-column `bot_config` lookup/update behavior. |
| `Setup.gs` | **Verified:** byte-identical | Both copy a profile-specific template and create the same tabs/config defaults. Both use `State` terminology. |
| `DiscordAdmin.gs` | **Verified:** byte-identical | State linking, settings, registration, banter, and bot-admin storage behave the same in source. |
| `Registry.gs` | **Verified:** logically identical | The only difference is a final newline; there is no behavior difference. |
| `Constants.gs` | **Verified:** differs | Template spreadsheet ID, registry spreadsheet ID, and hard-coded admin credential differ. Values are redacted. All non-secret constants are the same. |
| `WebApi.gs` | **Verified:** byte-identical | Both contain the same HTTP dispatcher, public HTML-service entry point, and web helper functions. |
| `99Tests.gs` | **Verified:** R.A.C.H.I.E only | Contains one manually invoked state-creation test with test values. It is not a trigger or automated suite. |

No recovered application logic branches on game profile. Separation comes from the
different constants/deployments and their separate Google files. All shared source
uses `State`, `Minister`, `Construction`, `Research`, and `Troop`. The identical
HTML and server validation messages use Whiteout Survival resource names: Fire
Crystals, Refined Fire Crystals, and Fire Crystal Shards. This is a verified
terminology defect for the recovered P.E.G.G.I.E source, not a Kingshot logic
variant. The Discord bot compensates in some UI paths by relabeling the legacy
`fc`, `rfc`, and `shards` payload fields.

### Apps Script entry points

**Verified (legacy source):** both projects define:

- `doGet(e)` serves `booking.html` for `?state=<code>`, or the authenticated legacy
  JSON `times` GET action for `sheetId`, `key`, and `day`.
- `doPost(e)` parses JSON and dispatches admin/bot and state-key public actions.
- `webGetBookingConfig`, `webGetAvailableTimes`, `webBookMultiple`, and `webBook`
  are directly callable from `booking.html` through `google.script.run`.
- `createBookingSpreadsheetFromTemplate` and `refreshRegistryDashboard` are public
  global maintenance functions that may be run manually from Apps Script.

R.A.C.H.I.E additionally defines `testCreateStateSheet` for manual execution. It
contains no assertions and is not an automated trigger.

**Unknown:** whether either production deployment currently runs the exact source
revision represented by these snapshots.

### API action handlers

All bot/admin POST actions call `validateAdminApiKey_` using the profile deployment's
hard-coded credential before dispatch:

- state/guild: `setup_state`, `link_state`, `unlink_state_server`,
  `unlink_state_server_by_id`, `get_linked_servers_for_current_state`,
  `reset_state_password`, `set_announcement_channel`,
  `grant_sheet_access_for_server`, `get_sheet_link_for_server`, and
  `get_booking_link_for_server`;
- registration/booking: `register_player_for_server`,
  `get_registered_player_for_server`, `delete_registered_player_for_server`,
  `get_times_for_server`, `get_booking_config_for_server`, `book_for_server`,
  `remove_booking_for_server`, `get_my_bookings_for_server`,
  `admin_add_booking_for_server`, `admin_remove_booking_for_server`,
  `clear_bookings_for_server`, `admin_reserve_slots_for_server`,
  `get_reserved_times_for_server`, and
  `admin_remove_reserved_slots_for_server`;
- dates/settings: `get_booking_date_for_server`, `set_booking_date_for_server`,
  `open_bookings_for_server`, `close_bookings_for_server`,
  `get_settings_for_server`, and `update_setting_for_server`;
- bot configuration: `get_bot_admin_role_for_server`,
  `set_bot_admin_role_for_server`, `clear_bot_admin_role_for_server`,
  `get_banter_channel_for_server`, `set_banter_channel_for_server`,
  `clear_banter_channel_for_server`, `get_banter_spice_for_server`, and
  `set_banter_spice_for_server`.

After all admin action checks, POST also supports `book`, `unbook`, and `register`
using caller-supplied `sheetId` plus the matching plaintext `state_api_key`. GET
supports `action=times` with the same Sheet ID/key authentication.

Unknown actions return `{ok:false,error:<message>}`. For POST, an unknown action
still falls through to require/open `sheetId` and validate its state key first.

### Configuration and triggers

**Verified (legacy source):** no source file calls `PropertiesService`, creates an
installable trigger, or defines `onOpen`/`onEdit`. No `appsscript.json` is present.
The visible dependencies are Google Sheets, Drive, HTML Service, Content Service,
Script Service, and one script-wide lock used only during state creation. Profile
template ID, registry spreadsheet ID, and the bot-wide admin credential are
hard-coded constants. Per-state API keys, join passwords, Discord IDs, and runtime
configuration are stored in Sheets.

**Unknown:** deployed manifest/scopes, execution identity, web-app access policy,
script and spreadsheet timezones, any triggers configured outside source, and any
Script Properties belonging to unrecovered versions.

## Current architecture

```text
R.A.C.H.I.E Discord application                 P.E.G.G.I.E Discord application
  GAME_PROFILE=wos                                GAME_PROFILE=kingshot
  separate BOT_TOKEN / CLIENT_ID                  separate BOT_TOKEN / CLIENT_ID
  separate APPS_SCRIPT_URL                        separate APPS_SCRIPT_URL
  separate ADMIN_API_KEY                          separate ADMIN_API_KEY
              |                                                |
              v                                                v
  R.A.C.H.I.E Apps Script deployment             P.E.G.G.I.E Apps Script deployment
              |                                                |
              v                                                v
  R.A.C.H.I.E booking/master/registry Sheets      P.E.G.G.I.E booking/master/registry Sheets
```

**Verified (bot source):** `postToAppsScript(payload)` performs an Axios POST to the
configured URL with `Content-Type: application/json` and returns `response.data`.
There is no explicit timeout, retry, idempotency key, response validation, profile
field, or version field.

**Verified (project documentation):** the optional PostgreSQL scheduler and player
account systems are intentionally separate from legacy booking. Existing
`/register`, `/my-info`, and `/unregister` booking identities remain in Apps Script.
The current player mirror is a no-op and makes no Sheet write.

## R.A.C.H.I.E data flow

**Verified (provided architecture and bot source):**

1. A Whiteout Survival Discord user invokes a shared slash command or persistent
   minister-registration button in the R.A.C.H.I.E Discord application.
2. The R.A.C.H.I.E process is expected to run with `GAME_PROFILE=wos` and its own
   Discord credentials, Apps Script URL, and admin key.
3. The bot performs Discord-side permission or basic input validation where
   applicable.
4. The bot sends an action JSON body to the R.A.C.H.I.E Apps Script URL. The body
   does not say `wos`; URL/key/deployment isolation supplies that context.
5. **Verified (provided architecture):** the R.A.C.H.I.E Apps Script reads or writes
   its separate Whiteout Survival booking/master/registry Sheets.
6. Apps Script returns JSON. The bot formats an ephemeral interaction response and,
   after successful user booking/removal, attempts a direct message.
7. Opening or closing bookings causes the bot to obtain all linked servers for the
   state and send a fixed announcement to each configured channel.

Steps 4-7 are also implemented by the recovered, shared Apps Script handler.

Whiteout Survival resource labels used by Discord are Fire Crystals (payload key
`fc`), Refined Fire Crystals (`rfc`), and Fire Crystal Shards (`shards`).

## P.E.G.G.I.E data flow

**Verified (provided architecture, bot source, and legacy source):** the flow is
structurally the same as R.A.C.H.I.E, but the P.E.G.G.I.E process is expected to use
`GAME_PROFILE=kingshot` and its own Discord credentials, Apps Script URL, admin key,
deployment, and Sheets. The Apps Script payload again contains no profile field.

Kingshot resource labels used by Discord are Truegold (payload key `fc`), Tempered
Truegold (`rfc`), and Truegold Dust (`shards`). Payload names are legacy protocol
names and do not change with the user-facing labels.

The shared booking commands currently use the words "minister" and "State" for
both profiles in many places. Profile-aware State/Kingdom terminology exists in the
newer PostgreSQL player/gift-code subsystem, but it is not applied consistently to
legacy booking. P.E.G.G.I.E's future "minister appointment" wording can therefore
be a presentation choice, but changing legacy bot text is not part of this phase.

## End-to-end booking flows

### Player registration

**Verified (bot source):** `/register` and the persistent Minister Sign-Up button
open the same modal. It collects:

- alliance tag: exactly three ASCII letters or digits after uppercasing;
- in-game name: required by Discord, maximum 30 characters;
- player ID: digits only, maximum 20 characters.

The bot sends `discordServerId`, `discordUserId`, legacy `discordTag`, in-game name,
player ID, and alliance to `register_player_for_server`. `/my-info` reads the record
and `/unregister` deletes it.

**Verified (legacy source):** registration is stored in the state booking
spreadsheet's `bot_users` tab and is unique only by Discord user ID within that
state Sheet. A second registration for the same Discord user throws instead of
updating. Player ID is not checked for uniqueness, so multiple Discord users can
register the same player ID. Deleting registration deletes the row and does not
remove existing bookings. The Apps Script helper itself requires only Discord user
ID, in-game name, and player ID; it does not validate numeric player ID, alliance
shape, or field lengths. Discord supplies the stronger validation described above.

### Player booking and rescheduling

**Verified (bot source):**

1. `/book` requires one of `Construction`, `Research`, or `Troop`.
2. The bot concurrently requests `get_times_for_server` and
   `get_booking_config_for_server`.
3. Available times are held in an in-memory session for 15 minutes and displayed in
   pages of 25 Discord select options.
4. The selected menu is bound to the initiating Discord user.
5. Depending on configuration, a modal requires resource/speed-up fields. Each is
   a one-to-six digit whole number. No negative or decimal value is accepted.
6. `book_for_server` receives the guild, Discord user, day, selected time, and
   optional `fc`, `rfc`, `shards`, and `speedups` values.
7. A successful response may contain `moved=true` and `oldTime`; the bot presents
   that as "Booking changed". There is no separate user edit command. Rebooking the
   same minister day is the observed rescheduling path.
8. The bot responds ephemerally and attempts a DM containing state, day, booking
   date, and UTC time. DM failure is logged and does not roll back the booking.

**Verified (legacy source):** submission rereads the target slot, but the check and
writes are not atomic and use no lock. Two concurrent submissions can both observe
an empty cell. The replacement must provide the atomicity that the legacy service
does not.

### Availability and booking dates

**Verified (bot source):** `/times` concurrently reads the available time strings
and the configured date for a selected day. It labels every returned time as UTC.
Admins set a date using year (2024-2100), month (1-12), and day (1-31); the bot
constructs `YYYY-MM-DD` and sends it to Apps Script. The response is expected to
provide `display_date` and `iso_date`.

**Verified (legacy source):** Apps Script does not generate slots. It reads 48
display strings from `Minister Appointments!A12:A59` in template row order. A slot
is available when the day-specific player-ID cell on that row is blank. It does not
filter past times, dates, or closed status when listing availability. Consequently,
the actual values, spacing, and sorting come from the unavailable template Sheet.
All three days share the same time column. Booking matches a requested string after
normalizing two colon-separated components with integer parsing (for example,
zero-padded hours become unpadded); it does not validate hour/minute ranges. Empty
time cells can appear in availability output when their ID cell is blank, although
the booking writer rejects an empty requested time.

Dates live in `B7` (Construction), `G7` (Research), and `K7` (Troop). Input must be
a real `YYYY-MM-DD` calendar date. Validation uses `Date.UTC`, but writing uses the
script-local `new Date(year, month - 1, day)`, and reading converts the resulting
value with UTC getters. Display text comes from the Sheet's formatted value using
`d mmmm yyyy`. This mixed local-write/UTC-read behavior can shift the ISO date when
the script timezone is west of UTC. The manifest and Sheet timezone remain
**Unknown**. No booking horizon or automatic open/close timestamps exist in source.
Changing a date simply overwrites the date cell and leaves every booking/reservation
row intact, effectively moving the displayed date for all existing slots in that
day block.

### Cancellation, clearing, and administrative booking

**Verified (bot source):**

- `/remove-booking` cancels the initiating Discord user's selected day and attempts
  a cancellation DM.
- `/admin-add-booking` selects an available time, then accepts alliance, name, and
  player ID without a Discord user. It does not collect resource fields.
- `/admin-remove-booking` removes one day or `ALL` days by player ID.
- `/clear-bookings` requires the admin to type `CLEAR` exactly, then asks Apps Script
  to clear all booking entries for the state.
- `/admin-reserve-slots` selects up to five currently available times from one
  Discord page and may return partial success plus per-time errors.
- `/admin-remove-reserved` selects up to five reserved times and may also return
  partial success.

**Verified (legacy source):** cancellation clears the full day-specific cell block
for the first matching player ID and retains no source-visible history. Clear
bookings clears `B12:F59`, `G12:J59`, and `K12:M59`, including reservations, but
preserves time cells, dates, configuration, and registrations. A reserved slot has
both display name and ID set to `RESERVED`. Normal cancellation refuses it; a
dedicated admin action is required.

The recovered `adminAddBookingForDiscordServer_` contains a significant defect: it
validates the supplied alliance, player name, and player ID, but then calls the
booking function with `RESERVED` identity and returns the supplied identity only in
the response. The Sheet therefore contains a reservation, not the requested admin
player. Admin add/reserve do not bypass `booking_open` or resource requirements,
so enabled requirements can make reservation creation fail. They also do not use
the configured booking-limit value.

### State setup and linked Discord servers

**Verified (bot source):**

- `/setup` sends a state code, Discord guild ID/name, and creator username. A
  successful response provides a state code, Sheet URL, booking URL, and join
  password.
- `/link-state` sends state code, join password, guild ID/name, and creator. Apps
  Script can report `already_linked`.
- `/linked-servers` reads linked guild names.
- `/unlink-state` selects one of at most the first 25 returned guilds, then sends
  only the target guild ID to the unlink action. A successful response can indicate
  that this was the last link, the state record was deleted, and the Sheet was moved
  to trash.
- `/reset-state-password` rotates the join password without affecting existing
  links.
- `/set-announcements` stores a Discord text-channel ID for a linked server.
- `/grant-access` sends a syntactically validated email address so Apps Script can
  grant Sheet edit access.

**Verified (legacy source):** one registry spreadsheet contains `state_registry`,
`state_discord_links`, and a derived `dashboard` tab. Each active registry row maps
one state code to one copied booking spreadsheet. Multiple guild-link rows may map
to that state. Announcement channel belongs to the guild-link row, while bot-admin
role and banter settings are state-wide values in the booking spreadsheet's
`bot_config`. No distinct master spreadsheet is referenced by the recovered source.

State setup is protected by a profile-deployment-wide script lock with a 30-second
wait. It rejects an existing state or already-linked creating guild, copies the
template, makes the file anyone-with-link viewable, initializes it, registers it,
and links the guild. On error it attempts to trash the new copy, but registry/link
writes are not transactionally rolled back.

Join passwords are randomly generated 16-character strings from a reduced
alphanumeric alphabet, stored and compared in plaintext in `state_registry`, and
returned in setup/reset responses. Comparison is exact after trimming. Reset does
not revoke links. State API keys are separately generated 24-character
alphanumeric strings and stored in both registry and `bot_config`. The generation
uses `Math.random`, not a cryptographic API. Values are intentionally omitted here.

A guild ID is globally link-unique within one profile registry. Linking an existing
state requires the plaintext join password and enforces `max_linked_servers` by row
count. An already-linked guild for the same state succeeds without rechecking the
join password. Announcement channel is per guild-link row. Bot-admin role and
banter channel/spice are per state booking Sheet, so all linked guilds resolve the
same stored role/channel settings even though Discord role IDs are guild-specific.

### Opening, closing, and announcements

**Verified (bot source):** admins call `open_bookings_for_server` or
`close_bookings_for_server`. After Apps Script succeeds, the bot separately calls
`get_linked_servers_for_current_state` and sends fixed messages through Discord.
Each send is best effort. Missing channels and individual send failures are skipped;
the admin receives sent and total counts. Announcement delivery is not transactional
with the open/close mutation.

No per-booking public announcement is sent by the inspected bot or Apps Script
paths. Successful bot bookings and removals receive ephemeral responses plus
best-effort DMs. The public page only displays local success/error text.

## Existing booking rules

| Rule | Evidence and status |
| --- | --- |
| Minister categories | **Verified:** exact server values are Construction, Research, and Troop. Unknown values throw. |
| UTC | **Verified:** bot-facing copy says UTC. Apps Script uses template display strings, local-time date construction, and UTC date extraction. Deployment/Sheet timezone is **Unknown**, so actual UTC correctness is not proven. |
| Registration | **Verified:** Discord booking resolves the state through guild link, then requires a `bot_users` row matching Discord user ID. Public HTML booking does not use registration. |
| Registration uniqueness | **Verified:** one active row per Discord user per state Sheet. Player ID is not unique. Re-register throws; delete does not cancel bookings. |
| One booking per category | **Verified:** the first matching player-ID row within a day is treated as the existing booking. A different requested slot clears it and writes the new row. |
| Slot exclusivity | **Verified but race-prone:** a nonblank day-specific ID cell blocks another player, but the read/check/write sequence has no lock or transaction. |
| Duplicate prevention | **Verified:** player ID, not Discord user, is the booking owner. Only the first existing occurrence is found, so manual duplicate rows are not fully repaired or prevented. |
| Booking limit | **Verified defect:** `max_bookings_per_player_per_day` is initialized, displayed, and update-validated for 6/9/12/15/18, but is never read by booking code. It has no effect. Actual code permits one current slot per player ID per category, with unlimited rescheduling while changes are allowed. |
| Linked-server limit | **Verified:** link creation counts all link rows for the state and rejects at `max_linked_servers`; permitted settings are 5/10/15/20. Status is not filtered from the count. |
| Booking open/closed | **Verified:** closed status blocks initial bookings, reschedules, admin add, and reservations. It does not block availability reads, registration, cancellation, clear, reservation removal, date changes, or page loading. |
| Booking changes | **Verified:** `allow_booking_changes=false` blocks moving an existing booking, but not initial booking or cancellation. |
| Construction requirements | **Verified:** FC, RFC, and speed-ups can each be independently required. |
| Research requirements | **Verified:** shards and speed-ups can each be independently required. |
| Troop requirements | **Verified:** speed-ups can be required. |
| Resource values | **Verified:** required FC/RFC/shards values are checked only for nonblank server-side. Speed-ups, if provided, must be 1-6 digits and are stored with `Days` appended. Bot/HTML provide stronger numeric controls for the other resources, but direct API callers can bypass them. |
| Config typing | **Verified:** native config setters store booleans, but requirement checks and web config responses use raw truthiness. A manually entered text value such as `false` is truthy and can unexpectedly enable a requirement. Settings display uses a separate boolean parser. |
| Player identity | **Verified:** bookings store a formatted `[alliance]name` snapshot and numeric-string player ID in cells. Discord identity is stored only in `bot_users`, not the booking row. |
| Alliance | **Verified:** booking service permits blank or 1-3 case-sensitive alphanumeric characters. Discord user/admin modals apply stricter rules before the request. |
| Session ownership | **Verified:** booking/admin menus are bound to initiating Discord user and expire after 15 minutes in process memory. |
| Cancellation | **Verified:** removes the first player-ID match for one day by clearing that day's cell block. Admin `ALL` repeats this for all three days. Closed status and `allow_booking_changes` do not block cancellation. |
| Rescheduling | **Verified:** old cells are cleared before target cells are written and response returns `moved`/`oldTime`. No history is retained in Sheets. |
| Reserved slots | **Verified:** name and ID are both `RESERVED`; they are excluded from availability and cannot be booked/cancelled normally. Reserve/remove actions process each requested time independently and return partial success. |
| Bulk web booking | **Verified:** each selected day is attempted independently; the top-level response is `ok:true` even when individual day results fail. It is not atomic. `__REMOVE__` cancels that day. |

## Current Apps Script API contract

### Transport envelope

**Verified (bot and legacy source):** every bot request is an HTTP POST
with a JSON body. Every observed bot call includes `adminKey`, including ordinary
user reads and writes. P.E.G.G.I.E compares it to a deployment-wide hard-coded
constant. The bot expects a JSON object response. Most actions use `ok` plus
optional `error`, but a few rely directly on `found` or `deleted`.

There is no contract version, profile, bot-instance identifier, request ID,
idempotency key, authorization header, or typed error code.

The tables below list fields sent by the bot and fields actually consumed by it.
Apps Script may return additional fields.

### State, guild, and authorization actions

| Action | Request fields after `action`, `adminKey` | Consumed response fields |
| --- | --- | --- |
| `get_bot_admin_role_for_server` | `discordServerId` | `bot_admin_role_id` |
| `set_bot_admin_role_for_server` | `discordServerId`, `roleId` | `ok`, `error` |
| `clear_bot_admin_role_for_server` | `discordServerId` | `ok`, `error` |
| `setup_state` | `stateCode`, `discordServerId`, `discordServerName`, `createdBy` | `ok`, `error`, `state_code`, `sheet_url`, `booking_url`, `join_password` |
| `link_state` | `stateCode`, `joinPassword`, `discordServerId`, `discordServerName`, `createdBy` | `ok`, `error`, `already_linked`, `state_code`, `sheet_url`, `booking_url` |
| `get_linked_servers_for_current_state` | `discordServerId` | `ok`, `error`, `state_code`, `links[]` with `discord_server_id`, `discord_server_name`, `announcement_channel_id` |
| `unlink_state_server_by_id` | `targetDiscordServerId` | `ok`, `error`, `removed`, `state_deleted`, `state_code`, `discord_server_name` |
| `reset_state_password` | `discordServerId` | `ok`, `error`, `state_code`, `join_password` |
| `set_announcement_channel` | `discordServerId`, `channelId` | `ok`, `error` |
| `get_sheet_link_for_server` | `discordServerId` | `ok`, `error`, `state_code`, `sheet_url`, `booking_url` |
| `get_booking_link_for_server` | `discordServerId` | `ok`, `error`, `state_code`, `booking_url` |
| `grant_sheet_access_for_server` | `discordServerId`, `email` | `ok`, `error`, `email`, `state_code` |

### Settings and schedule actions

| Action | Request fields | Consumed response fields |
| --- | --- | --- |
| `get_settings_for_server` | `adminKey`, `discordServerId` | `ok`, `error`, `state_code`, `sheet_name`, nested `settings` |
| `update_setting_for_server` | `adminKey`, `discordServerId`, `key`, string `value` | `ok`, `error` |
| `set_booking_date_for_server` | `adminKey`, `discordServerId`, `day`, `date` (`YYYY-MM-DD`) | `ok`, `error`, `day`, `display_date`, `iso_date` |
| `get_booking_date_for_server` | `adminKey`, `discordServerId`, `day` | `ok`, `error`, `display_date` |
| `open_bookings_for_server` | `adminKey`, `discordServerId` | `ok`, `error`, `state_code` |
| `close_bookings_for_server` | `adminKey`, `discordServerId` | `ok`, `error`, `state_code` |

Observed settings are `max_bookings_per_player_per_day`, `max_linked_servers`,
`construction_fc_required`, `construction_rfc_required`,
`construction_speedups_required`, `research_shards_required`,
`research_speedups_required`, and `troop_speedups_required`.

`get_booking_config_for_server` returns `ok`/`error` and the six requirement flags
at the response top level, unlike `get_settings_for_server`, which nests them under
`settings`. A compatibility adapter must preserve that distinction.

### Player and booking actions

| Action | Request fields | Consumed response fields |
| --- | --- | --- |
| `register_player_for_server` | `adminKey`, `discordServerId`, `discordUserId`, `discordTag`, `inGameName`, `playerId`, `alliance` | `ok`, `error`, `alliance`, `inGameName`, `playerId` |
| `get_registered_player_for_server` | `adminKey`, `discordServerId`, `discordUserId` | `found`, `alliance`, `inGameName`, `playerId` |
| `delete_registered_player_for_server` | `adminKey`, `discordServerId`, `discordUserId` | `deleted` |
| `get_times_for_server` | `adminKey`, `discordServerId`, `day` | `ok`, `error`, `times[]` |
| `get_booking_config_for_server` | `adminKey`, `discordServerId` | `ok`, `error`, six top-level requirement flags |
| `book_for_server` | `adminKey`, `discordServerId`, `discordUserId`, `day`, `time`, nullable `fc`, `rfc`, `shards`, `speedups` | `ok`, `error`, `state_code`, `day`, `playerName`, `time`, `moved`, `oldTime`, `booking_date_display` |
| `get_my_bookings_for_server` | `adminKey`, `discordServerId`, `discordUserId` | `ok`, `error`, `playerName`, `bookings.{Construction,Research,Troop}`, `dates.{Construction,Research,Troop}` |
| `remove_booking_for_server` | `adminKey`, `discordServerId`, `discordUserId`, `day` | `ok`, `error`, `removed`, `oldTime`, `state_code` |
| `admin_add_booking_for_server` | `adminKey`, `discordServerId`, `day`, `time`, `alliance`, `inGameName`, `playerId` | `ok`, `error`, `state_code`, `day`, `time`, `alliance`, `playerName`, `playerId` |
| `admin_remove_booking_for_server` | `adminKey`, `discordServerId`, `playerId`, `day` or `ALL` | `ok`, `error`, `removed`, `removed_count` |
| `clear_bookings_for_server` | `adminKey`, `discordServerId` | `ok`, `error`, `state_code` |
| `get_reserved_times_for_server` | `adminKey`, `discordServerId`, `day` | `ok`, `error`, `times[]` |
| `admin_reserve_slots_for_server` | `adminKey`, `discordServerId`, `day`, `times[]` | `ok`, `error`, `day`, `count`, `times[]`, `failed[]` (`time`, `error`) |
| `admin_remove_reserved_slots_for_server` | same as reserve | same partial-success response shape |

### Non-booking actions sharing the same URL

Any drop-in replacement for `APPS_SCRIPT_URL` must also account for:

- `get_banter_channel_for_server`
- `get_banter_spice_for_server`
- `set_banter_channel_for_server`
- `clear_banter_channel_for_server`
- `set_banter_spice_for_server`

The two reads are cached in the bot for five minutes. This is a separate feature,
but it shares the deployment boundary and therefore affects compatibility planning.

### Public HTTP and HTML-service contract

**Verified (legacy source):**

| Entry/action | Authentication | Behavior |
| --- | --- | --- |
| `GET ?state=<stateCode>` | No page credential; state must exist and be active | Embeds the registry row's Sheet ID into `booking.html`; allows framing from any origin. |
| `GET ?action=times&sheetId=...&key=...&day=...` | Plaintext per-state API key from `bot_config` | Returns currently available display strings. |
| `POST action=book` | Caller-supplied Sheet ID plus state API key | Books/reschedules directly without Discord registration. |
| `POST action=unbook` | Caller-supplied Sheet ID plus state API key | Cancels the first matching player-ID booking. |
| `POST action=register` | Caller-supplied Sheet ID plus state API key | Adds a `bot_users` row using the weak Apps Script validation. |
| `google.script.run.webGetBookingConfig` | Apps Script page execution context only; no explicit application credential | Reads requirement flags for the supplied Sheet ID. |
| `google.script.run.webGetAvailableTimes` | Same | Reads availability for the supplied Sheet ID/day. |
| `google.script.run.webBookMultiple` | Same | Books, reschedules, or cancels up to three day selections independently. |
| `google.script.run.webBook` | Same; unused by recovered HTML | Books one day directly. |

The HTML page stores alliance, in-game name, and player ID in browser
`localStorage`. It does not authenticate a player, register them, verify ownership
of a player ID, display booking dates, or read current bookings. Each dropdown
always contains `Remove existing booking`; cancellation therefore depends only on
the entered player ID. It submits directly to Apps Script server functions, which
write Sheet cells. It does not call the JSON POST endpoint.

The page loads all three availability lists and requirement flags, conditionally
shows resource inputs, and submits only day dropdowns with nonblank selections.
It reloads availability after a response. Identity HTML constraints are alliance
1-3 alphanumeric and numeric player ID; resource inputs strip non-digits and cap
at six characters. Server-side validation remains authoritative and is weaker for
FC/RFC/shards.

### Error envelopes and partial writes

**Verified (legacy source):** `doGet` and `doPost` catch thrown errors
and serialize `{ok:false,error:String(...)}` as JSON through `ContentService`;
source does not set HTTP status codes or structured error identifiers. Unauthorized
requests use the message `Unauthorized`. The HTML RPC uses `google.script.run`
success/failure callbacks.

Bulk web booking returns top-level `{ok:true,results:[...]}` and records failures
per day. Reservation operations likewise return successful and failed time arrays.
Neither is transactional. More seriously, a booking/reschedule clears the old row
and writes target name/ID before `formatSpeedupsForSheet_` can reject an invalid
speed-up value. A direct caller can therefore lose the old booking and leave a
partially populated target row even though the action reports failure.

## Relevant Sheets and data structures

### Registry spreadsheet

**Verified (legacy source):** each profile points to a different registry
spreadsheet. The source expects:

- `state_registry`, with positional columns: `state_code`, booking `sheet_id`,
  `sheet_name`, plaintext `state_api_key`, `booking_url`, plaintext
  `join_password`, `created_at`, `created_by`, `status`, and `notes`;
- `state_discord_links`, created on demand with `state_code`, guild ID/name,
  link timestamp/actor, status, notes, and `announcement_channel_id`;
- `dashboard`, destructively rebuilt from the preceding two tabs with state,
  status, Sheet name, joined guild names, booking URL, and creation metadata.

The code never creates `state_registry`; it assumes that tab and its positional
schema already exist. It adds the announcement column to an older links tab if
missing. It does not reference a distinct "master" spreadsheet or tab, despite the
provided production description. Whether "master" refers to the registry file,
the template, or another operational file remains **Unknown**.

State code must be a nonempty digit string and is unique per profile registry by a
linear scan. A Discord guild ID can have at most one link row per profile. State
and link status must be `active` for normal guild resolution, but link listings and
linked-server limit counts do not filter inactive rows.

### Per-state booking spreadsheet

**Verified (legacy source):** setup takes the profile-specific template file,
creates a Drive copy named `Minister Booking - State <code>`, and makes it
viewable to anyone with the link. It clears only booking ranges, ensures two
support tabs, writes access/configuration, registers the copy, links the creating
guild, and rebuilds the dashboard.

The copy contains or receives:

- `Minister Appointments`, required from the template;
- `bot_users`, with columns `discordUserId`, `discordTag`, `gameName`, `gameId`,
  `alliance`, and `updatedAt`;
- `bot_config`, a positional two-column key/value store.

Default config keys are the six resource requirement flags, `booking_open`,
`allow_booking_changes`, `max_bookings_per_player_per_day`,
`max_linked_servers`, plaintext `state_api_key`, `state_code`, and `booking_url`.
Banter channel/spice and bot-admin role keys are appended later when first set.

The appointment grid uses template time values in `A12:A59` and the following
day blocks:

| Day | Date cell | Data block | Name | Player ID | Extra columns |
| --- | --- | --- | --- | --- | --- |
| Construction | `B7` | `B12:F59` | B | C | D=FC, E=RFC, F=speed-ups |
| Research | `G7` | `G12:J59` | G | H | I=shards, J=speed-ups |
| Troop | `K7` | `K12:M59` | K | L | M=speed-ups |

Availability and ownership derive directly from these cells. This means manual
edits to time, player-ID, name, resource, date, or config cells immediately affect
API behavior; there is no separate database, revision, audit log, or formula-level
validation in the recovered code. Editor access can be granted through Drive using
only a basic `@` check. The source does not reconcile or validate manual edits.

### Copy, cleanup, and destructive behavior

State creation uses a script-wide lock with a 30-second wait. If setup throws after
opening the copy, it attempts to trash that copy, but it does not transactionally
undo any registry/link rows already written. All other flows are unlocked.

Unlink by guild ID deletes the link row. When it was the last link, it removes the
state registry row and attempts to trash the booking spreadsheet; trash failure is
silently ignored and registry deletion still proceeds. The older unlink-by-name
action removes only the link and never performs last-link state cleanup. Clear
bookings permanently blanks all three booking blocks. No archive/history is
created by either operation.

### Remaining Sheet unknowns

The absent template and live exports leave actual time values, formulas,
validation, formatting beyond dates, named/protected ranges, hidden tabs, direct
cross-Sheet formulas, file timezones, and existing malformed/duplicate data
unknown. Manual editing is technically supported by the cell-backed design and
Drive editor grants, but actual staff procedures are not proven by source.

## Differences between profiles

| Concern | R.A.C.H.I.E | P.E.G.G.I.E | Evidence |
| --- | --- | --- | --- |
| Profile | `wos` | `kingshot` | Verified provided/source |
| Game | Whiteout Survival | Kingshot | Verified provided/source |
| Deployment | Separate bot and Apps Script | Separate bot and Apps Script | Verified provided/docs |
| Sheets | Separate booking/master/registry | Separate booking/master/registry | Verified provided |
| Primary location term in newer systems | State | Kingdom | Verified source |
| Legacy booking location copy | Mostly State | Also mostly State | Verified source |
| Resource payload `fc` | Fire Crystals | Truegold | Verified source |
| Resource payload `rfc` | Refined Fire Crystals | Tempered Truegold | Verified source |
| Resource payload `shards` | Fire Crystal Shards | Truegold Dust | Verified source |
| Booking wording | Minister slot | Currently same shared wording; may become minister appointment | Verified source / requested direction |
| Template/registry identifiers and admin credential | Profile-specific constants (values redacted) | Different profile-specific constants (values redacted) | Verified legacy source |
| Booking/config/setup/admin/HTML logic | Same recovered source | Same recovered source | Verified hashes/diff |
| Apps Script HTTP/API handler | Same full `doGet`/`doPost` and web helpers | Same full `doGet`/`doPost` and web helpers | Verified legacy source |
| Test file | One manual creation function in `99Tests.gs` | File absent | Verified legacy source |
| Public HTML resource copy | Whiteout Survival names | Incorrectly also Whiteout Survival names | Verified legacy source |

The recovered files prove no intentional profile-specific booking logic. Resource
meaning is carried by deployment context and Discord presentation while the legacy
field/cell names remain WOS-centric. Deployment and template exports are still
required before assuming the live systems are operationally identical.

## Error handling and concurrency

### Verified bot behaviour

- API business failures are usually HTTP-success JSON with `ok=false` and `error`.
- Network, non-2xx, malformed response, and unexpected runtime errors reach a global
  interaction handler, which logs the error and shows "Something went wrong".
- The Apps Script client has no explicit timeout or retry.
- No request carries an idempotency key. A timeout after a committed write can lead
  to an ambiguous retry.
- Available times are snapshots held for up to 15 minutes. The write endpoint must
  recheck availability.
- Booking/admin component sessions are held only in memory with a 15-minute TTL. A
  process restart expires them; sessions are not shared across bot instances.
- The separate unlink-state map is also in memory and user-bound, but it is not in
  the booking-session TTL cleanup list. Its entries are removed on successful
  selection or process restart, not by the observed 15-minute cleanup.
- DM and announcement sends are best effort and occur after persistence responses.
- Open/close plus announcement is not atomic. Partial Discord delivery is expected.

### Verified Apps Script behaviour

- Only state spreadsheet creation takes a script-wide `LockService` lock. Booking,
  cancellation, reservation, registration, linking, settings, clear, and unlink
  operations have no concurrency protection.
- Slot conflict detection and player rescheduling are separate cell reads/writes;
  they are vulnerable to races and partial failures.
- There is no idempotency, compare-and-swap, audit log, or transaction boundary.
- Bulk booking and multi-reservation deliberately allow partial success.
- Registry uniqueness is enforced by unlocked scans except during the locked setup
  path. Linking and registration can race into duplicate rows.
- All endpoint errors are JSON with `ok:false` and a free-text `error` in the
  recovered shared handler. Source does not set corresponding HTTP statuses.

### Required future behaviour

**Proposed:** PostgreSQL booking/reschedule/cancel operations should run in a
transaction, lock the target slot and current participant booking, and rely on
profile-scoped unique constraints as the final race guard. Mutations should require
an idempotency key and return the original result on safe retry. Outbound Discord
work should use a durable outbox rather than share the booking transaction.

## External dependencies and contracts to preserve

- Two Discord applications and their distinct guild/user/channel/role IDs.
- Discord slash command names, choices, modal fields, component ownership, and
  ephemeral response timing.
- The legacy JSON action names, request field casing, response field casing, and
  inconsistent success envelopes.
- Separate profile credentials and routing; current requests lack profile context.
- Existing Apps Script URLs/admin keys during coexistence.
- Existing booking, master, and registry Sheets, including possible manual edits.
- Google Drive behaviours: Sheet creation/copying, editor grants, URLs, and trashing
  the final unlinked state's file.
- Existing public booking URLs and any user bookmarks or Discord messages that
  contain them.
- UTC date/time display and exact legacy time strings expected by Discord.
- Resource payload keys (`fc`, `rfc`, `shards`, `speedups`) despite profile-specific
  meanings.
- State linking, join passwords, linked-server limits, announcement channels, and
  bot-admin roles.
- Booking-open/closed state and announcement fan-out semantics.
- Best-effort DMs and the response fields needed to format them.
- Existing PostgreSQL `player_accounts`, which is profile-scoped but currently
  independent from booking registration.
- Privacy, retention, deletion-request, and audit obligations for Discord IDs,
  player IDs, names, alliances, bookings, and email access grants.
- Google and Discord quotas/rate limits during coexistence and bulk migration.

## Compatibility API feasibility and recommendation

**Feasibility:** yes, the existing bot can temporarily consume a complete
compatibility API without rewriting booking interactions. The bot already treats
Apps Script as one JSON-over-HTTP action endpoint, so changing only
`APPS_SCRIPT_URL` per deployment could redirect it.

This is conditional on all of the following:

1. Expose separate trusted routes or credentials, for example
   `/api/compat/apps-script/wos` and `/api/compat/apps-script/kingshot`.
2. Bind each admin key to exactly one profile. Never accept `game_profile` as an
   authority from the body.
3. Preserve the action body and response shapes exactly, including top-level versus
   nested settings and legacy camel/snake casing.
4. Preserve non-booking actions on the same URL, or first change the bot to split
   booking/state/banter clients.
5. Return ordinary JSON in a way Axios follows exactly as it does today.
6. Keep legacy time strings and error text compatible until bot rendering is moved
   to a typed client.
7. Characterize the public Apps Script booking page separately; redirecting the bot
   does not migrate that page.

**Reassessed recommendation:** do not make full endpoint emulation the first
production cut. First refactor the bot internally, with no user-visible behavior
change, so booking, state/registry, configuration/admin-role, and banter calls use
separate client interfaces and separately configurable URLs. Keep state setup,
Drive copying/sharing/trashing, editor grants, registry dashboard, join passwords,
and banter on Apps Script initially. Point only the booking client at a compatibility
adapter backed first by legacy forwarding and later by PostgreSQL.

This reduces the contract to registration, availability, booking/reschedule,
cancellation, current bookings, dates, booking settings/open state, reservations,
admin booking/removal/clear, and any deliberately retained booking link behavior.
It avoids reproducing unrelated fragile Google lifecycle behavior merely to change
booking persistence. The split must be deployed and verified before changing the
booking endpoint; no bot change is made in this analysis phase.

Full endpoint emulation remains a valid fallback when even a behavior-preserving
bot client split cannot be released safely. In either approach, initial proxy mode
forwards to the correct Apps Script and returns its response unchanged while
recording redacted telemetry. Writes must not be blindly replayed because the
protocol has no idempotency key and legacy writes can be partial.

## Replacement risks

1. **Cross-profile leakage:** the most severe risk. Profile is implicit in the
   current endpoint, so a wrong credential/route mapping can expose or mutate the
   other game's data.
2. **Deployment drift:** snapshots are identical except infrastructure constants,
   but deployed Apps Script versions are not recorded here. A live deployment may
   lag the recovered files.
3. **Unavailable templates/live Sheets:** actual slot values, formulas, timezone,
   malformed rows, and distinct master infrastructure remain unverified.
4. **Manual Sheet writes:** editors granted through `/grant-access` may change the
   source outside the bot/API. A proxy alone will not observe those writes.
5. **Unauthenticated public identity:** the HTML page writes through direct server
   helpers, trusts browser-entered player ID, and permits cancellation by that ID.
   Migrating it unchanged would preserve an account-takeover-like weakness.
6. **No idempotency:** retries and dual writes can duplicate bookings or consume a
   slot twice.
7. **Stale availability races:** the 15-minute Discord menu means service-side
   atomic validation is mandatory.
8. **Registration-model mismatch:** legacy booking registration appears
   state/guild scoped; PostgreSQL `player_accounts` is global per profile and allows
   multiple characters. Merging without reconciliation can assign the wrong player.
9. **Admin bookings without Discord identity:** a schema that requires a Discord
   user would reject valid legacy operations.
10. **Destructive semantics:** clear bookings and unlinking the final server may
    erase/trash data. A new audited model will behave differently unless the API
    adapter emulates the visible result.
11. **Date/time conversion:** Sheets serial dates, script timezone, and display
    formatting may not match UTC `timestamptz` without explicit tests.
12. **Profile-specific resource meaning:** renaming legacy payload keys can break the
    unchanged bot.
13. **Open/close notification split:** persistence can succeed while announcements
    fail. Changing this behaviour can cause duplicate or missing messages.
14. **Authorization regression:** Discord `ManageGuild`, a configured role, and the
    deployment admin key form the current trust chain. Website admin authorization
    must not broaden it accidentally.
15. **Link deletion scope:** `unlink_state_server_by_id` sends only the target guild
    ID. A replacement must scope lookup by the authenticated profile and verify the
    caller is authorized for the containing state.
16. **Unversioned contract:** the bot consumes loose response objects. Small casing,
    nullability, or error-status changes can break commands.
17. **Existing links:** Sheet and booking URLs already posted in Discord may remain
    in circulation long after cutover.
18. **Stale unlink sessions:** unlink selections are stored in process memory without
   the booking-session TTL cleanup and should not be copied into the new design.
19. **Legacy races:** no booking lock protects slot claims, registration, or links.
   Characterization must allow existing duplicate/corrupt data even though the new
   database prevents new races.
20. **Partial write behavior:** invalid speed-ups can fail after old-row deletion and
   target identity writes. A transactional replacement will be safer but will not
   reproduce this failure side effect; compatibility tests must approve that change.
21. **Unused limit setting:** enforcing `max_bookings_per_player_per_day` in the new
   service would introduce behavior not present today. It must be deprecated,
   redefined, or explicitly launched as a policy change.
22. **Broken admin-add semantics:** current source stores `RESERVED` despite returning
   the submitted player. Import and contract tests must distinguish actual Sheet
   state from the optimistic Discord response.
23. **Plaintext legacy secrets:** admin credential, state keys, and join passwords
   are stored in source or Sheets. They must not enter logs/import tables and should
   be rotated when legacy access is retired.
24. **Profile terminology defect:** identical P.E.G.G.I.E HTML/server errors expose
   WOS resource names. Exact emulation preserves bad copy; the native API/UI should
   use profile presentation while compatibility retains field names only.

## Proposed PostgreSQL domain model

This is a logical model only. No migration should be created until both Apps Script
deployments and Sheet structures have been recovered and characterized.

### Isolation rules

Every booking-owned table should contain `game_profile` with a check for `wos` or
`kingshot`. Every parent should expose a unique `(id, game_profile)` key, and every
child should use a composite foreign key containing both values. Natural uniqueness
must also include `game_profile`.

Repositories should be constructed for one profile, following the bot's existing
PostgreSQL pattern. API context should derive profile from trusted hostname or
credential. Row-level security with transaction-local profile context is recommended
as defence in depth. Separate database roles per bot profile can further limit a
credential-routing failure.

### Proposed entities

#### `booking_communities`

Represents one State or Kingdom booking domain.

- `id`, `game_profile`, `location_code`
- `display_name`
- `status` (`active`, `archived`)
- `bookings_open`
- `join_password_hash` and rotation timestamp; never store the raw password
- timestamps and optimistic `version`
- optional legacy Sheet/registry identifiers during migration
- unique `(game_profile, location_code)` and `(id, game_profile)`

#### `booking_discord_guilds`

Maps a Discord guild to exactly one booking community in one profile.

- `game_profile`, `discord_guild_id`, `community_id`
- guild display name
- `announcement_channel_id`
- link creator and timestamps
- primary key `(game_profile, discord_guild_id)`
- composite FK `(community_id, game_profile)`

The same Discord ID must not be able to resolve across profiles through one request.
The recovered legacy `bot_admin_role_id` is stored in state-wide `bot_config`, not
on the guild link. Preserve that value separately during import; the native design
should intentionally migrate to a guild-scoped role because Discord role IDs belong
to guilds.

#### `booking_settings`

One current rule set per community, with a history/audit record for changes.

- profile/community composite key
- legacy maximum-booking value (informational/disabled until policy is defined) and
  enforced maximum-linked-guild value
- the six observed requirement flags
- future versioned rule metadata only after behaviour is verified

The legacy maximum-booking setting name should be retained in the adapter, but it
must not drive a constraint: recovered booking code never reads it.

#### `booking_windows`

Preserves each booking cycle rather than overwriting one Sheet forever.

- `id`, `game_profile`, `community_id`
- status (`draft`, `open`, `closed`, `archived`)
- optional `opens_at_utc` and `closes_at_utc`
- created/opened/closed actor and timestamps
- version

Current behaviour may only have a boolean open state; window history is proposed
for safe migration and rollback.

#### `minister_services`

Profile-aware definitions for the observed `construction`, `research`, and `troop`
categories.

- `game_profile`, stable service code, display label, active flag, sort order
- presentation wording such as "minister" versus "minister appointment"
- requirement definitions/labels for each profile

Compatibility maps stable codes back to exact legacy values `Construction`,
`Research`, and `Troop`.

#### `booking_service_dates`

One configured UTC calendar date per window/service.

- `id`, `game_profile`, `window_id`, `service_code`, `booking_date` (`date`)
- unique `(game_profile, window_id, service_code)`

#### `appointment_slots`

Materialized slots make concurrency and reservation state explicit.

- `id`, `game_profile`, `community_id`, `window_id`, `service_code`
- template ordinal and exact legacy time label
- nullable resolved `starts_at_utc`/`ends_at_utc` only after timezone and duration
  rules are approved
- lifecycle status and version
- unique profile/window/service/template ordinal; optionally also unique resolved
  start time once it is non-null and trustworthy

The legacy importer should create slots from rows 12-59 in template order and
retain source row/cell identity. It must not infer UTC instants or duration from a
display string until template and timezone evidence is available.

#### `booking_slot_blocks`

Represents admin-reserved/unavailable slots independently from bookings.

- `id`, profile and slot composite ownership
- reason, actor, active/cancelled timestamps
- partial unique constraint allowing only one active block per slot

#### `booking_participants`

Represents the legacy minister-booking identity within a community.

- `id`, `game_profile`, `community_id`
- nullable `discord_user_id` and legacy Discord tag
- player ID, in-game name, alliance tag
- nullable `(player_account_id, game_profile)` link to existing canonical
  `player_accounts`
- active state, source, timestamps

Discord user must be nullable for imported/manual booking identities. Enforce at
most one active registration for `(game_profile, community_id, discord_user_id)`;
do not make player ID unique because source permits multiple Discord registrations
for it.

#### `minister_bookings`

- `id`, `game_profile`, community/window/service/slot ownership
- nullable participant and Discord user; required player-ID snapshot for legacy
  confirmed bookings
- immutable snapshots of player ID, player name, alliance, and date/time display
- status (`confirmed`, `cancelled`, `replaced`, `cleared`)
- source (`discord`, `website`, `admin`, `legacy_import`, `compatibility`)
- `replaces_booking_id` for rescheduling
- actor, timestamps, cancellation reason, optimistic version
- idempotency key and correlation ID

A partial unique index should permit only one active booking per slot. Native writes
also need one active booking per
`(game_profile, community_id, window_id, service_code, player_id_snapshot)`, because
legacy rescheduling searches by player ID rather than participant/Discord identity.
Import duplicate cell states into staging/quarantine before enabling this constraint.

#### `booking_answers`

Stores typed requirement answers without confusing profile-specific terminology.

- profile and booking composite ownership
- stable requirement code (`fc`, `rfc`, `shards`, `speedups` for compatibility)
- raw legacy text, nullable parsed numeric value, unit, and captured display label
- unique per booking/requirement

#### `booking_change_events`

Append-only audit events for registration, booking, reschedule, cancel, clear,
reserve, open/close, settings, links, and imports. Store profile, aggregate IDs,
actor type/ID, source, correlation ID, timestamps, and bounded before/after data.
Sensitive values must be minimized and retention-defined.

#### `booking_outbox`

Durable pending Discord notifications and integration events with profile,
community, event type, payload, attempts, idempotency key, next attempt, and delivery
status. Booking commits and outbox inserts occur in one transaction; Discord sends
remain at least once.

#### `legacy_booking_mappings`

Maps imported profile/Sheet/tab/row identifiers to PostgreSQL IDs, records source
checksums and import batch, and supports reconciliation and reverse projection
during rollback. Never use a Sheet row number alone as a durable identity.

#### `compatibility_requests`

Records redacted action name, profile, request/correlation/idempotency identifiers,
response classification, latency, backend (`legacy` or `postgres`), and timestamps.
Do not store admin keys, raw join passwords, or unrestricted payloads.

### Relationship to existing `player_accounts`

The existing table is already strongly profile-scoped and can eventually provide
canonical ownership, Player ID, and State/Kingdom number. It does not currently
store the legacy booking alliance and its identity lifecycle differs:

- it permits multiple characters per Discord user;
- it is globally unique by `(game_profile, player_id)`;
- booking registration appears tied to a state/community and guild resolution;
- legacy admin bookings may have no Discord owner.

Therefore, migrate booking participants independently and link them to
`player_accounts` only after deterministic reconciliation or explicit user/admin
confirmation. Do not automatically overwrite either store.

### Model changes required by recovered source

The initial proposal remains directionally sound, with these now-required changes:

1. Store booking service dates as SQL `date`, not a value named UTC. Resolve a
   timestamp only when the deployment/Sheet timezone and slot duration are known.
2. Preserve slot ordinal, display label, source row, and source cells. The legacy
   system has no generated start/end records.
3. Make active-booking ownership unique by player-ID snapshot per community,
   window, and service, not solely by participant ID.
4. Make active registration unique by Discord user within a community; explicitly
   allow duplicate player IDs across registrations.
5. Keep raw answer text because FC/RFC/shards are not numerically validated by Apps
   Script and existing Sheets may contain arbitrary/manual values.
6. Treat `max_bookings_per_player_per_day` as an inert legacy setting. Do not add a
   booking-count constraint until product policy deliberately replaces it.
7. Import `RESERVED` sentinels as slot blocks, not participants/bookings. Record the
   original cells in legacy mappings.
8. Model the legacy state-wide bot-admin role for faithful import, then migrate to
   a separately approved per-guild role model. Do not silently reinterpret it.
9. Represent current Sheet overwrite semantics as one imported booking window, but
   retain the proposed window/history tables for the future design.
10. Import registry/link statuses and raw source rows even though normal lookup
    requires active status; inactive rows affect current link counts/listings.
11. Include source tab, row, and column block in `legacy_booking_mappings`; a row
    number alone is ambiguous across three day blocks.
12. Quarantine actual duplicates and partial rows before applying native unique and
    not-null constraints. The unlocked/partial legacy writer can create both.

## Proposed future API boundaries

### Profile context

- Website requests derive profile from the resolved hostname.
- Discord native API clients authenticate with a profile-bound service credential.
- Compatibility routes are separate per profile and bind the legacy admin key to
  that profile.
- Resource IDs are always looked up with profile and community scope.

### User/website API

Suggested versioned boundaries, subject to authentication design:

- `GET /api/v1/booking/context`
- `GET /api/v1/booking/availability?service=...`
- `GET/PUT /api/v1/me/booking-profile`
- `GET /api/v1/me/bookings`
- `POST /api/v1/bookings` with `Idempotency-Key`
- `PATCH /api/v1/bookings/{id}` for rescheduling with expected version
- `DELETE /api/v1/bookings/{id}` for cancellation

The website must not accept a profile or community ID that can override the trusted
host/session context.

### Admin API

- booking-window open/close and service dates;
- rule/settings management;
- slot block/reservation management;
- add/remove/clear booking operations with mandatory audit reason;
- guild link, announcement channel, and admin-role management;
- import/reconciliation diagnostics.

Discord OAuth and guild authorization will eventually be needed for website admin
operations, but authentication is outside this analysis and must not be inferred
from the current shared admin key.

### Bot API

After the compatibility period, introduce a typed bot client with explicit version,
profile-bound authentication, request IDs, idempotency, stable error codes, and
separate booking/state/config namespaces. Keep legacy text formatting in Discord,
not in the domain service.

### Integration events

Publish profile-scoped events such as booking created/rescheduled/cancelled and
window opened/closed through the transactional outbox. Discord workers consume
them and record delivery attempts. Website reads the same source of truth rather
than receiving mirrored data.

## Staged migration plan

### Stage 0: complete and validate recovered evidence

1. Verify both snapshots against their deployed versions/IDs without exposing
   credentials.
2. Export both manifests, deployment settings, version identifiers, execution
   identities, property names (not values), and configured triggers.
3. Export both profile templates and representative registry/booking Sheets,
   including headers, values, formulas, protections, validation, hidden tabs,
   file timezone, and sharing model.
4. Identify what production operators call the "master" Sheet; it is absent from
   recovered source references.
5. Produce redacted representative requests/responses and corrupted/manual-edit
   examples for every action.
6. Measure manual Sheet-edit practices and identify all editors/automations.

Exit gate: every current rule and mutation has a verified source or a deliberately
approved behaviour change.

### Stage 1: characterization tests

1. Build an offline contract fixture suite from redacted requests/responses.
2. Test valid/invalid dates, closed bookings, missing registration, limits,
   duplicates, reschedules, cancellations, reserved slots, and concurrent claims.
3. Test the two Apps Script deployments independently.
4. Record exact response nullability, error text/codes, and public page behaviour.

Do not point tests at production Sheets.

### Stage 2: additive PostgreSQL and service foundation

1. Create reviewed migrations only after Stages 0-1.
2. Add composite profile ownership, constraints, RLS, transactions, audit, outbox,
   and idempotency.
3. Implement domain/service tests for both profiles, including deliberate attempts
   to read and mutate cross-profile IDs.
4. Keep all production traffic on Apps Script.

### Stage 3: importer and reconciliation

1. Import read-only snapshots into staging tables per profile and source file.
2. Validate row counts, checksums, duplicate reports, date/time conversions, and
   registry/master/booking referential integrity.
3. Resolve identity conflicts explicitly; do not auto-merge legacy registration
   with `player_accounts`.
4. Repeat imports until deterministic and idempotent.
5. Rehearse full restore and rollback on disposable infrastructure.

### Stage 4: split bot clients without changing behavior

1. Introduce separate internal bot clients/configuration for booking, state/Drive,
   settings/admin-role, and banter actions.
2. Initially point every client to the same existing profile-specific Apps Script
   URL and preserve request/response behavior exactly.
3. Characterize and canary the refactor independently for WOS and Kingshot.
4. Keep a one-variable rollback to the original single-client configuration.

Apps Script remains source of truth and no API route changes in this stage.

### Stage 5: booking compatibility proxy in legacy-forward mode

**Implemented foundation (not deployed):** the website now has separate
`/api/compat/booking/wos` and `/api/compat/booking/kingshot` POST routes. Each
requires the route profile to match the server-resolved hostname profile and uses
only its profile-specific server environment setting. A central booking-action
allowlist excludes state, Drive/Sheet lifecycle, general configuration, admin
role, and banter operations. Requests and valid legacy JSON responses are
forwarded without reserialization; Apps Script remains authoritative.

1. Deploy separate WOS and Kingshot booking compatibility routes with distinct,
   profile-bound credentials.
2. Route only the bot's booking client through the proxy; continue state/Drive and
   banter traffic directly to the matching Apps Script.
3. Forward booking actions unchanged, redact secrets/PII in telemetry, and shadow
   only safe reads against PostgreSQL.
4. Canary a non-production/test deployment, then one production profile behind a
   quick booking-client URL rollback flag.

Full endpoint forwarding may substitute for Stages 4-5 only if the bot cannot be
safely refactored first. That fallback must implement every action listed above.

### Stage 6: capture and shadow persistence

1. Route bot writes through the proxy so acknowledged mutations can be journalled.
2. Account separately for public booking page and manual Sheet writes; use an
   audited change feed or periodic reconciliation until those writers are retired.
3. Project legacy mutations into PostgreSQL idempotently and compare resulting
   availability/bookings.
4. Do not expose website writes while Sheets remain uncontrolled writers.

### Stage 7: one-profile pilot cutover

1. Choose one profile and a controlled state/kingdom; do not cut over both together.
2. Announce a short mutation freeze, close the legacy public page/manual editing,
   take a final export, and reconcile.
3. Switch the compatibility backend for that scoped tenant to PostgreSQL while the
   unchanged bot continues using the legacy action contract.
4. Enable website booking only for the same scoped tenant.
5. Maintain a verified PostgreSQL-to-legacy projection during the rollback window.
6. Monitor availability conflicts, API errors/latency, DMs, announcements, profile
   scope violations, and reconciliation counts.

### Stage 8: expand independently

Expand one state/kingdom and one profile at a time. Require an explicit go/no-go and
reconciliation report at each step. Repeat the full process for the second profile;
do not assume the first profile proves the second.

### Stage 9: native clients and legacy retirement

1. Move the website and bots to the typed versioned API.
2. Separate banter and unrelated configuration from the booking compatibility URL.
3. Redirect or retire old booking URLs with clear user messaging.
4. Make Sheets read only, export immutable archives, revoke unnecessary editor
   access, and retain them for the agreed rollback/retention period.
5. Remove the compatibility adapter only after access logs show no callers.

## Rollback strategy

Rollback must be profile- and tenant-scoped.

Before cutover:

- retain both Apps Script deployments, keys, Sheet files, and bot endpoint values;
- take timestamped, checksum-recorded exports;
- use feature flags to choose `legacy`, `shadow`, or `postgres` backend per profile
  and community;
- test the endpoint switch and credential mapping without writes.

During the reversible cutover window:

- journal every PostgreSQL mutation and project it to the matching legacy system;
- alert and fail closed if the legacy projection cannot catch up;
- preserve original legacy IDs and source values;
- prevent direct legacy/manual writes or continuously ingest and reconcile them;
- never roll back one profile through the other profile's endpoint or Sheet set.

Rollback procedure:

1. Put the affected profile/community into maintenance and stop new mutations.
2. Drain notifications and the PostgreSQL-to-legacy projection.
3. Reconcile bookings, registrations, slots, open state, dates, and settings.
4. If reconciliation is exact, switch that scope's compatibility backend to legacy.
5. Restore/redirect its public booking URL and reopen writes.
6. Keep PostgreSQL and audit data for diagnosis; do not drop additive schema.

If reverse projection has not been proven, an immediate write-enabled rollback is
not safe. The fallback is maintenance mode plus forward repair, not choosing one
copy and losing acknowledged bookings.

## Open technical questions

### Source and deployment

1. Do the deployed versions match these snapshots, particularly the verified
   shared admin-add defect and unlocked booking behavior?
2. What manifest, OAuth scopes, web-app access/execution settings, triggers, and
   deployment version IDs are active for each profile?
3. What does the production description's separate "master" Sheet mean? No such
   file is referenced by recovered source.
4. Are there additional source files, libraries, or client pages not captured here?

### Sheets and time

5. What exact values, formulas, formatting, validation, protections, and hidden
   content exist in each profile's template and live booking Sheets?
6. Are the two templates structurally and behaviorally identical?
7. What are each script and spreadsheet's configured timezone, and has the
   local-write/UTC-read date path caused observed date shifts?
8. Are `A12:A59` values always UTC, what interval/duration do they represent, and
   can operators edit or reorder them?
9. What malformed, duplicate, partially written, or nonnumeric resource data
    already exists in production?
10. Which direct Sheet edits are normal operating procedure, and must any remain
    supported during coexistence?

### Product policy and identity

11. Was `max_bookings_per_player_per_day` intended as an attempt/rebooking limit,
    and should the replacement deprecate it or introduce new enforcement?
12. Is the admin-add reservation behavior intentional, tolerated, or a production
    defect to correct during migration?
13. Should closed bookings continue allowing cancellation and reservation removal?
14. Should the website require Discord authentication and verified ownership of a
    player ID, replacing the public page's browser-entered identity?
15. Can the same player ID legitimately be registered by multiple Discord users or
    appear in multiple communities/alliances?
16. How should legacy booking participants map to multiple profile-scoped
    PostgreSQL `player_accounts`?
17. Should bot-admin roles become guild-scoped, correcting the legacy state-wide
    storage model?
18. What Kingshot terminology and resource validation should replace the WOS copy
    in P.E.G.G.I.E's public flow?

### Security and operations

19. How are the hard-coded admin credentials and plaintext state/join keys rotated,
    and which callers besides the inspected bot use them?
20. Are old public booking URLs bookmarked or embedded elsewhere, and what redirect
    or retirement period is required?
21. Who currently has Sheet editor access, and can direct writes be frozen for a
    profile/community cutover?
22. How long must booking history, audit events, exports, and access records be
    retained?
23. What traffic, quota, peak-concurrency, availability, and notification service
    levels must the replacement meet?
24. Which profile/community is suitable for the first controlled pilot?

Until these questions are resolved, implementation should remain limited to
non-production contract fixtures and reversible infrastructure planning.
