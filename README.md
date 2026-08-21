# R.A.C.H.I.E and P.E.G.G.I.E web

One Next.js application serves both bot brands. The incoming hostname selects the
brand configuration on the server.

## Local development

Start the development server:

```bash
npm run dev
```

Load either local hostname in a browser:

- R.A.C.H.I.E: [http://localhost:3000](http://localhost:3000)
- P.E.G.G.I.E: [http://peggie.localhost:3000](http://peggie.localhost:3000)

Modern browsers resolve `*.localhost` to the loopback interface, so no hosts-file
or production DNS change is required.

The deployment-ready staging pair is `staging.r-a-c-h-i-e.com` and
`peggie-staging.r-a-c-h-i-e.com`. See the
[staging deployment guide](docs/staging-deployment.md) for variables, database
roles, migrations, Railway settings, smoke tests, and rollback.

Discord booking notifications and manager approval buttons use a narrow signed
website/bot boundary with durable PostgreSQL work. See the
[Discord booking integration guide](docs/discord-booking-integration.md) for
profile secrets, required Server Members Intent, retries, reminders, rollout,
and degraded operation.

## Brand architecture

- `brands/types.ts` defines the shared, strongly typed configuration contract.
- `brands/config.ts` contains brand-specific identity, game, copy, asset paths,
  hostnames, theme identifiers, and semantic presentation tokens.
- `brands/resolve.ts` performs pure hostname normalization and brand selection.
- `brands/server.ts` reads request headers using the App Router server API and
  returns the active brand context.
- `brands/presentation.ts` maps configured theme values to stable CSS variables.
- `components/app-shell.tsx` owns the shared header, navigation, main content,
  footer, and the boundary reserved for future brand visual layers.

Shared pages consume the shell and semantic styles without knowing which brand is
active. Brand-specific effects and assets can therefore evolve behind the theme
and visual-layer boundaries without changing booking, events, or help features.

The shared shell currently exposes `/`, `/booking`, `/events`, and `/help` under
both configured hostnames.

Unrecognized hostnames fall back to R.A.C.H.I.E. This includes standard localhost
and keeps local development predictable.

## Legacy booking compatibility

The server exposes profile-scoped compatibility routes that forward approved
booking actions to the existing Apps Script deployments. Apps Script remains the
authoritative booking system; the proxy does not store or reinterpret bookings.

- WOS: `POST /api/compat/booking/wos`
- Kingshot: `POST /api/compat/booking/kingshot`

Configure the server-only `RACHIE_LEGACY_BOOKING_URL` and
`PEGGIE_LEGACY_BOOKING_URL` environment variables. A route is usable only when
its path profile, recognized request hostname, and configured profile backend all
agree. See [docs/booking-compatibility-proxy.md](docs/booking-compatibility-proxy.md)
for the action allowlist and operating constraints.

## Native booking database foundation

Native booking infrastructure uses the server-only `DATABASE_URL` setting. The
ordinary website and legacy compatibility proxy continue to start when it is not
configured; native booking repositories are then unavailable instead of opening a
connection implicitly.

Apply ordered PostgreSQL migrations with:

```bash
npm run db:migrate
```

Migrations are checksummed, transactionally recorded, and serialized with a
PostgreSQL advisory lock. Never edit an applied migration; add a new ordered file.
For optional database integration tests, point `TEST_DATABASE_URL` only at a safe
disposable PostgreSQL database. See
[docs/native-booking-postgresql.md](docs/native-booking-postgresql.md).

The first native read-only API is available at:

- `GET /api/v1/booking/context`
- `GET /api/v1/booking/availability?service=construction`
- `GET /api/v1/booking/me`

The hostname selects the profile, and the authenticated session supplies its
selected verified community. The old environment community codes are not used by
these routes.

## Discord authentication foundation

Server-side Discord OAuth and profile-scoped community selection are available
under `/api/v1/auth/*`. The hostname chooses the OAuth application and database
profile; Discord guild IDs are matched against `booking_discord_guilds`, and only
those verified choices can be selected. Access tokens are never stored or exposed.

This foundation has no public login UI and does not authorize booking writes yet.
See [docs/discord-authentication.md](docs/discord-authentication.md) for routes,
required server environment variables, scopes, session security, and remaining
work.

Native booking reads now require that authenticated session and its selected,
recently verified Discord community. `GET /api/v1/booking/me` returns only the
current Discord user's registration and confirmed bookings. See
[docs/authenticated-booking-context.md](docs/authenticated-booking-context.md) for
the trust boundary, membership lease, and PostgreSQL-backed rate limits.

The first native mutation is `PUT /api/v1/booking/me/registration`. It creates or
updates only the authenticated Discord user's selected-community registration and
requires fresh membership, CSRF, rate limiting, validation, and an idempotency
key. See
[docs/native-participant-registration.md](docs/native-participant-registration.md).

Native appointment creation is available at `POST /api/v1/bookings`. It requires
the same trusted context plus an active registration and atomically records the
booking, requirement answers, audit event, outbox event, and idempotency result.
See [docs/native-booking-creation.md](docs/native-booking-creation.md).

Owned appointment rescheduling and cancellation are available through
`PATCH`/`DELETE /api/v1/bookings/{bookingId}`. See
[docs/native-booking-mutations.md](docs/native-booking-mutations.md) for lineage,
locking, closed-booking policy, idempotency, audit, and outbox semantics.

The shared public booking workflow is now available at `/booking`. See
[docs/public-booking-interface.md](docs/public-booking-interface.md) for user
states, native API integration, accessibility, mobile behavior, and the boundary
with future visual work.

For persistent local PostgreSQL, real Discord OAuth setup, idempotent development
seed data, and the manual booking checklist, see
[docs/local-manual-booking-testing.md](docs/local-manual-booking-testing.md).

For reviewed initial staging/production community configuration, see
[docs/booking-community-bootstrap.md](docs/booking-community-bootstrap.md).
