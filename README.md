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
