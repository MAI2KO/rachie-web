# Public World map

The shared website exposes a public World at `/world` and a public-safe JSON read model at `GET /api/v1/world-map`. Neither requires Discord authentication. The request hostname is the only profile selector: R.A.C.H.I.E hosts show Whiteout Survival States, while P.E.G.G.I.E hosts show Kingshot Kingdoms. Query parameters cannot override the profile.

## Public data boundary

A registered map community is an authoritative `booking_communities` row whose `status` is `active` in the hostname-selected `game_profile`. These are the same community records created by booking bootstrap. Archived rows do not appear, and there is no duplicate map-registration table.

The API returns only:

- `code`: State or Kingdom location code
- `displayName`: public community name
- `href`: profile-correct public appointment-board path

It does not return database UUIDs, Discord guild or role IDs, bookings, players, identities, settings, audit data, or secrets. Reads run in a read-only transaction with transaction-local `app.game_profile`, so identical codes remain isolated between WOS and Kingshot.

## Layout and interaction

Communities are sorted numerically by code and assigned row-major coordinates in a compact grid with `ceil(sqrt(count))` columns. Lines connect each occupied cell to its immediate occupied neighbour on the right and below. Coordinates are calculated at read/render time and are not stored in PostgreSQL. The pure layout layer can later accept custom or persisted positions without changing the public data or renderer contracts.

The renderer is HTML Canvas with no additional graphics dependency. One lightweight draw surface handles nodes and connections, which avoids a heavyweight positioned React card per node and remains appropriate for thousands of communities. Community data, layout, camera state, drawing, hit testing, and navigation are separate modules or functions, so Canvas can later be replaced by WebGL and decorative effects cannot affect booking logic.

The initial camera fits the network where practical, caps the close zoom for one or a few communities, and observes fixed minimum and maximum zoom levels. Mouse or one-finger dragging pans the surface. Wheel/trackpad input zooms around the pointer, and two Pointer Events implement pinch zoom. Camera movement is bounded around the registered network. Tapping a node without dragging opens its existing `/state/{code}` or `/kingdom/{code}` appointment board.

Search accepts a State/Kingdom number only. A match smoothly centres and highlights the node and provides a normal link to open it. An unknown number reports that it is not currently registered. Empty profiles display an explicit no-States/no-Kingdoms message instead of an empty canvas.

Canvas is decorative from an accessibility perspective. The search is labelled and keyboard-operable, results are announced through a live region, zoom buttons are focusable, and an accompanying expandable DOM directory contains a meaningful, focusable link for every registered community. The public header also includes `World` navigation.

## Future visual work

Particles, terrain, richer node art, or a WebGL renderer should consume the existing public community and layout/camera contracts. They must not introduce private fields, change registered-community eligibility, or move booking/business logic into graphics code.
