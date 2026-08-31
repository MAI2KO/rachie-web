# First native booking cycle readiness

## Production authorities

Public URL generation is origin-relative or derived from the authenticated
request origin. The only accepted public production authorities are:

- WOS: `https://r-a-c-h-i-e.com`
- Kingshot: `https://peggie.r-a-c-h-i-e.com`

Railway must attach both domains to the website service and set
`TRUSTED_PROXY=railway`. The website service must set:

```text
RACHIE_DISCORD_OAUTH_REDIRECT_URI=https://r-a-c-h-i-e.com/api/v1/auth/callback
PEGGIE_DISCORD_OAUTH_REDIRECT_URI=https://peggie.r-a-c-h-i-e.com/api/v1/auth/callback
RACHIE_BOOKING_INTEGRATION_SECRET=<WOS-only secret of at least 32 characters>
PEGGIE_BOOKING_INTEGRATION_SECRET=<Kingshot-only secret of at least 32 characters>
RACHIE_ALLIANCE_EVENTS_INTERNAL_URL=<R.A.C.H.I.E private event API origin>
PEGGIE_ALLIANCE_EVENTS_INTERNAL_URL=<P.E.G.G.I.E private event API origin>
RACHIE_ALLIANCE_EVENTS_INTEGRATION_SECRET=<matching WOS event secret>
PEGGIE_ALLIANCE_EVENTS_INTEGRATION_SECRET=<matching Kingshot event secret>
```

Keep `DATABASE_URL`, `AUTH_SESSION_SECRET`, both OAuth client secrets, and both
bot tokens at their existing production values. Do not put a public website URL
in an `*_ALLIANCE_EVENTS_INTERNAL_URL`; those are server-to-server bot origins.
Remove obsolete `WOS_NATIVE_BOOKING_COMMUNITY_CODE` and
`KINGSHOT_NATIVE_BOOKING_COMMUNITY_CODE` from production if present.

Set the matching bot services independently:

```text
# R.A.C.H.I.E
GAME_PROFILE=wos
BOT_INSTANCE_NAME=rachie-wos
BOOKING_WEBSITE_INTEGRATION_ENABLED=true
BOOKING_WEBSITE_BASE_URL=https://r-a-c-h-i-e.com
BOOKING_WEBSITE_INTEGRATION_SECRET=<same value as RACHIE_BOOKING_INTEGRATION_SECRET>

# P.E.G.G.I.E
GAME_PROFILE=kingshot
BOT_INSTANCE_NAME=peggie-kingshot
BOOKING_WEBSITE_INTEGRATION_ENABLED=true
BOOKING_WEBSITE_BASE_URL=https://peggie.r-a-c-h-i-e.com
BOOKING_WEBSITE_INTEGRATION_SECRET=<same value as PEGGIE_BOOKING_INTEGRATION_SECRET>
```

In the R.A.C.H.I.E Discord application register exactly
`https://r-a-c-h-i-e.com/api/v1/auth/callback`; in P.E.G.G.I.E register exactly
`https://peggie.r-a-c-h-i-e.com/api/v1/auth/callback`. Enable Server Members
Intent for both applications. Preserve staging redirects until production smoke
checks pass; never cross-assign client IDs, secrets, callbacks, or integration
secrets.

## Existing-community onboarding

`/setup` derives the profile from the bot deployment, takes only the community
number and three-character alliance abbreviation, and reads the guild name from
Discord. Preview performs no persistent writes. Apply reuses an exact active
link or creates a fresh WOS native community with bookings initially closed,
all three services enabled, and current requirement defaults. The automatic WOS
reconciler supplies the established Wednesday 00:00 UTC to Sunday 12:00 UTC
window and Monday Construction, Tuesday Research, Thursday Troop Training dates.
With no historical slot template, it creates 48 UTC half-hour slots per service.

Creation is serialized by profile/community and profile/guild advisory locks.
It is transactionally audited and idempotent. A guild already linked elsewhere,
or an existing community already claimed by another active guild, requires
platform approval and is not remapped. Kingshot has no equivalent supported
automatic-cycle defaults, so creating a missing Kingshot community is refused
explicitly. Existing linked Kingshot communities can still be reconciled.

Rerunning `/setup` preserves valid custom gift/event/roundup destinations,
scheduled events, recurrence, event groups, publish settings, State linkage, and
scheduler configuration. It repairs only missing/deleted managed channels or
cards and reports created versus reused resources.

No historical Sheet bookings are imported. Native bookings start clean. The old
Sheet remains reachable only through `/sheet-link` as an emergency read-only
fallback for the first cycle; Sheet writes, Apps Script registration, and old
Sheet booking/open-close commands remain retired.

## Deterministic acceptance harness

Use only a disposable PostgreSQL database. The following suite is the acceptance
harness; it advances explicit timestamps and does not wait for calendar dates:

```bash
cd /home/mark/VSCode/rachie-peggie-web
TEST_DATABASE_URL='<disposable-url>' node --test --test-concurrency=1 tests/*.test.mjs
npm test
npm run lint
npx tsc --noEmit
git diff --check

cd /home/mark/VSCode/R-A-C-H-I-E
TEST_DATABASE_URL='<disposable-url>' node --test --test-concurrency=1
npm test
npm run check
git diff --check
```

Coverage is intentionally split by stable domain boundary:

- `automatic-booking-cycle-integration.test.mjs` covers before-open, overridden
  open, one announcement, window-bound guest link, close, restore-to-default,
  master switch, and restart idempotency.
- `native-booking-creation-integration.test.mjs` covers registration, member
  booking, same-service rejection, cross-profile isolation, audit, outbox, and
  idempotency.
- `booking-approval-integration.test.mjs` covers guest submission, approval,
  denial, expiry, holds, and concurrent decisions.
- `native-booking-mutation-integration.test.mjs` covers complete manager manual
  creation, duplicate races, reschedule, cancellation, immutable actor audit,
  notification transitions, and retry convergence.
- `points-ledger-integration.test.mjs` covers participant/service/window and
  community/window/guild idempotency keys and restart-safe awards.
- `discord-booking-integration.test.mjs` covers public/member/manager booking
  links, delivery materialisation, and profile-scoped Discord work.
- `runtime-booking-privileges-integration.test.mjs` covers minimum runtime
  grants, `/setup` creation/rerun/race safety, and first-template WOS cycles.

## Retired-command gap audit

Native member/guest/manager creation, availability, cancel/reschedule,
open/close overrides, setup, guild linking/unlinking, registration, manager role,
and event scheduler flows all have current replacements. `/sheet-link` remains
deliberately read-only. Retired Apps Script booking creation, removal,
availability, registration, and open/close controls must not be restored.

The only launch-critical functional gap is automatic creation of a missing
Kingshot native booking community: supported cycle defaults do not yet exist.
That is a Kingshot first-cycle blocker, but it does not block WOS or an already
provisioned and linked Kingshot community.

## First-cycle guest and member booking experience

Guest booking remains an intentional fallback for the first cycle: one request is
submitted at a time and requires manager approval. Registered Discord members keep
the smoother path with eligible native confirmation, self-service appointment
management, and registered Player ID account and gift-code benefits. Multi-appointment
guest submission is deliberately deferred; the guest path is not artificially
restricted, but it is not intended to duplicate the registered-member experience.

## Safe production order

1. Back up production PostgreSQL and record current Railway variables/domains.
2. Run the full disposable-database acceptance harness above.
3. From the exact website release, run `npm ci`, then run `npm run db:migrate`
   with the migration-owner `DATABASE_URL`. Production already has `0011`; this
   applies additive migration `0012_state_guild_link_requests.sql` without editing
   any deployed migration.
4. As the migration owner, apply the documented runtime grants in
   `docs/staging-deployment.md`, including minimum request-table privileges.
5. Deploy the website code with the runtime-role `DATABASE_URL` and verify
   `/api/health/ready` on both production
   hostnames.
6. Set the website production callback, integration, internal event, and proxy
   variables listed above; attach both production domains.
7. Add the two exact callbacks and enable Server Members Intent in the matching
   Discord applications.
8. Deploy R.A.C.H.I.E with the WOS website origin/secret, then run `/setup`,
   review Preview, and Apply. Confirm created/reused scheduler resources.
9. Reconcile the automatic WOS cycle, confirm bookings remain master-closed
   until intentionally enabled, and smoke login/member/guest/manager paths.
10. Deploy P.E.G.G.I.E with its own origin/secret only after using an existing
   linked community or resolving the Kingshot default-cycle blocker.
11. Keep `/sheet-link` available through the first successful native cycle.
