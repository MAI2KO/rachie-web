# Booking Compatibility Proxy

## Purpose and status

The compatibility proxy is a server-side forwarding boundary between a future
website or bot booking client and the existing profile-specific Google Apps
Script booking deployment:

```text
Website or bot booking client
        -> Next.js profile route
        -> existing profile-specific Apps Script
```

Apps Script and its Sheets remain authoritative. This foundation does not add a
booking UI, authentication, PostgreSQL persistence, payload translation, or a
new booking implementation.

## Routes and profile isolation

The routes accept JSON via `POST` only:

| Profile | Route | Required hostname brand | Legacy backend setting |
| --- | --- | --- | --- |
| `wos` | `/api/compat/booking/wos` | R.A.C.H.I.E | `RACHIE_LEGACY_BOOKING_URL` |
| `kingshot` | `/api/compat/booking/kingshot` | P.E.G.G.I.E | `PEGGIE_LEGACY_BOOKING_URL` |

The route profile is static, and the active profile is resolved independently
from the trusted server-side request hostname using the existing brand
configuration. Both must match. Unknown hostnames and cross-profile route calls
fail closed instead of using the website's normal R.A.C.H.I.E page fallback.

Fields in the request body, including `game_profile`, never select a backend.
They are retained only because the complete JSON request body is forwarded
unchanged after validation. A destination URL supplied in the request is never
used.

The two environment variables are server-only and must contain the corresponding
Apps Script deployment URLs. They have no `NEXT_PUBLIC_` equivalents. A missing
or blank value returns a controlled `503` response and does not forward traffic.

## Supported actions

The central allowlist contains exactly these legacy actions:

- `admin_add_booking_for_server`
- `admin_remove_booking_for_server`
- `admin_remove_reserved_slots_for_server`
- `admin_reserve_slots_for_server`
- `book_for_server`
- `clear_bookings_for_server`
- `close_bookings_for_server`
- `delete_registered_player_for_server`
- `get_booking_config_for_server`
- `get_booking_date_for_server`
- `get_booking_link_for_server`
- `get_my_bookings_for_server`
- `get_registered_player_for_server`
- `get_reserved_times_for_server`
- `get_times_for_server`
- `open_bookings_for_server`
- `register_player_for_server`
- `remove_booking_for_server`
- `set_booking_date_for_server`

`get_booking_config_for_server` is included because booking flows use its
resource-requirement flags. `get_booking_link_for_server` is included because it
is assigned to the booking client even though its legacy implementation reads
registry linkage.

The proxy rejects every action not listed above. In particular, it does not
forward state setup/linking, registry administration, Sheet/Drive lifecycle,
general setting updates, bot-admin-role storage, announcement configuration, or
banter actions. The legacy public `book`, `unbook`, `register`, and GET `times`
contracts are also outside this bot-facing compatibility boundary.

## Transport behavior

After parsing the body only to validate its object shape and `action`, the proxy
sends the original request text to the configured Apps Script URL as
`application/json`. It returns a successful legacy response body and HTTP status
without reserializing the JSON. Responses are marked `no-store`.

Legacy calls have a ten-second timeout. Timeouts, network failures, and invalid
legacy JSON produce controlled proxy errors without returning backend URLs,
credentials, or underlying exception details. The proxy does not log request
bodies or secrets.

The existing Apps Script `adminKey` contract is unchanged in this phase. Clients
must continue sending the same action payloads they use with Apps Script; the
proxy neither adds nor removes credentials.
