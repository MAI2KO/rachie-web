# Local manual booking testing

This workflow uses only the persistent PostgreSQL 16 container in `compose.yaml`.
It does not use Railway, production Sheets, or either production database.

## 1. Configure local secrets

Create `.env.local` from `.env.example`. `.env.local` is ignored by Git; never
commit it. Keep the supplied local `DATABASE_URL` and
`ALLOW_DEVELOPMENT_DATABASE_SEED=true`, then replace:

- `AUTH_SESSION_SECRET` with output from `openssl rand -base64 48`;
- `RACHIE_DISCORD_OAUTH_CLIENT_ID` and `RACHIE_DISCORD_OAUTH_CLIENT_SECRET`
  from the R.A.C.H.I.E application under Discord Developer Portal > OAuth2;
- `PEGGIE_DISCORD_OAUTH_CLIENT_ID` and `PEGGIE_DISCORD_OAUTH_CLIENT_SECRET`
  from the P.E.G.G.I.E application under Discord Developer Portal > OAuth2;
- `WOS_DEV_DISCORD_GUILD_ID` with the real development guild containing the
  OAuth test user for the WOS State;
- `KINGSHOT_DEV_DISCORD_GUILD_ID` with the real development guild containing the
  OAuth test user for the Kingshot Kingdom.

Do not paste bot tokens. The website requests only Discord OAuth `identify` and
`guilds` scopes and does not need a bot token.

## 2. Register local Discord callbacks

Add these exact redirect URIs manually to their corresponding Discord applications:

```text
R.A.C.H.I.E: http://localhost:3000/api/v1/auth/callback
P.E.G.G.I.E: http://peggie.localhost:3000/api/v1/auth/callback
```

The values must exactly match `RACHIE_DISCORD_OAUTH_REDIRECT_URI` and
`PEGGIE_DISCORD_OAUTH_REDIRECT_URI` in `.env.local`. Do not assign one application's
credentials or callback to the other profile.

## 3. Start and prepare PostgreSQL

```bash
npm run db:up
npm run db:migrate
npm run db:seed
```

The container is PostgreSQL 16, listens only on `127.0.0.1:55439`, and stores data
in the named `rachie_peggie_web_postgres_data` volume. `db:seed` is idempotent and
creates no Discord identity, session, participant, or booking ownership rows. As
a safeguard, the seed refuses production mode, non-loopback database hosts, and
database names other than `rachie_peggie_dev`.

The seed creates:

- WOS `Development State 1001` with code `DEV-WOS-1001`;
- Kingshot `Development Kingdom 2002` with code `DEV-KS-2002`;
- one supplied Discord guild mapping for each profile;
- one open 30-day booking window per community;
- active Construction, Research, and Troop services;
- future service dates and six available slots per service;
- construction FC/RFC, research shards/speedups, and troop speedups requirements.

Stop the container without deleting data:

```bash
npm run db:down
```

Start it again with `npm run db:up`; the named volume preserves data.

To deliberately destroy all local development data and the named volume:

```bash
npm run db:reset
```

This command is destructive and is never run automatically. After resetting, run
`db:up`, `db:migrate`, and `db:seed` again.

## 4. Run the website

```bash
npm run dev
```

Open:

- R.A.C.H.I.E: <http://localhost:3000/booking>
- P.E.G.G.I.E: <http://peggie.localhost:3000/booking>

`peggie.localhost` resolves to loopback naturally on the current development
machine and needs no hosts-file change. If another machine does not resolve it,
add this minimal line manually to `/etc/hosts`:

```text
127.0.0.1 peggie.localhost
```

Do not change production hostname configuration.

## 5. Exercise the flow

For each hostname:

1. Select **Sign in with Discord** and complete the matching application login.
2. Select `Development State 1001` or `Development Kingdom 2002` if prompted.
3. Register a player ID, in-game name, and three-character alliance.
4. Open Construction, Research, and Troop and verify dates, slots, and the correct
   WOS/Kingshot resource terminology.
5. Create an appointment and verify its confirmation and current-booking entry.
6. Reschedule it and verify the old slot returns while the new slot disappears.
7. Cancel it through the explicit confirmation and verify the slot returns.

OAuth membership is intentionally real. If the expected community is absent, check
that the signed-in user belongs to the guild ID in `.env.local`, rerun `npm run
db:seed`, and sign in again so the membership assertion is refreshed. If the seeded
service dates have passed, use the explicit reset workflow and seed fresh data.
