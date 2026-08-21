# Public State and Kingdom appointment board

Non-Discord submission links are documented in
[`guest-booking-links.md`](./guest-booking-links.md).

Each active community has a public board which needs no Discord sign-in:

- R.A.C.H.I.E: `/state/<state-code>` (for example, `/state/9999`)
- P.E.G.G.I.E: `/kingdom/<kingdom-code>` (for example, `/kingdom/9999`)

The hostname selects the game profile. A URL parameter or request body cannot switch profiles. The State or Kingdom code is resolved only inside that hostname-derived profile.

## Public field boundary

The anonymous response has a dedicated public query and serializer. It contains only the State/Kingdom code and public display name, service names and configured dates, appointment times, and `Available`, `Pending`, or a confirmed in-game name.

An active unexpired guest hold appears as `Pending`. An expired hold appears as `Available` even before a worker transitions its retained request row. Denied and expired requests and cancelled or replaced bookings do not occupy a slot.

The public path does not fetch or serialize Player IDs, Discord IDs, requirements (including speed-ups), internal request/booking IDs, guild IDs, manager identities, or audit history. Protected data is not sent to React and hidden with CSS.

Only the current explicit booking window is shown. An open non-archived window takes priority, followed by a draft window and the newest closed non-archived window. The schema has no named cycle/archive catalogue yet, so older-cycle browsing is intentionally deferred.

## Layout

On desktop, configured service panels appear side by side. Each has its own date and vertical timeline. Names and order come from `minister_services`, not brand-specific UI copies. On phones, panels retain a readable width and horizontally scroll and snap for left/right swiping.

## Manager authorization and fields

The board checks the existing Discord session in the background. Anonymous users and ordinary guild members keep the public view. A manager view is returned only after live, bounded server verification proves that the user qualifies in at least one Discord guild linked to that State/Kingdom by either:

- being the guild owner or holding a live role with Discord's `Administrator` permission; or
- holding the live role configured in `booking_discord_guilds.bot_manager_role_id`.

The bot checks the current guild member role list. Administrator checks also compare those roles with current guild role permissions and check current ownership. No stored login-time manager claim is trusted. Unavailable or malformed Discord responses fail closed. Any linked guild may qualify, but authority remains scoped to that community and profile.

The manager serializer may return in-game name, Player ID, alliance, requirements, pending/confirmed state, action IDs, and recent activity. It does not return linked guild IDs. Every manager read and mutation repeats server authorization.

## Copy Mode, Edit Mode, and audit

The manager board starts in **Copy Mode**. Each service uses a compact operator
table with one appointment per row: time, player, Player ID, and only the
requirement columns enabled for that service in `booking_settings`. Column
definitions reuse the same requirement-code, profile-label, and unit metadata as
booking validation; the React UI does not hard-code resource names. Disabled
requirements do not create empty columns, and different services may therefore
have different table shapes.

Clicking a player name or Player ID copies only that value. The most recently
copied field has a green outline and accessible copied feedback. If the booking's
canonical Discord owner is the signed-in manager, a visually separate `YOU`
badge appears beside the player-name control. Only a server-produced boolean is
sent for this marker, and `YOU` is never included in copied text. There is no
long-press or bulk copy.

On narrow screens the operator table scrolls horizontally inside its service
panel instead of stacking fields vertically. Normal scroll chaining is retained
so a user can reach the table edge and continue swiping between service panels.

Mutation controls appear only after **Edit appointments** is selected. This phase supports approve and deny through the existing atomic approval service. Both retain first-transition-wins concurrency, record the acting Discord user ID/display name, require same-origin CSRF validation, and use a dedicated rate limit.

Authorized managers can expand **Recent manager activity** to see action, player, manager display name, timestamp, and previous/resulting state. This history is never public.

Confirmed cancellation and manager rescheduling are deferred. The existing mutation service is participant-owner scoped and cannot safely be reused as manager authority. Remaining product work also includes the World Map, Discord DM/approval delivery, and a first-class historical-cycle browser.
