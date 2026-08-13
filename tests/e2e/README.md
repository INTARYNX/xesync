# End-to-end tests

Real Chromium, real DOM, real `ftms_integration.js` state machine and real
`rowing_display.js` WebGL scene — `debug_sim.js` stands in for the BLE
hardware, and (for the `db-integration` project only) a local Postgres +
PostgREST stand in for the production backend.

## Why a build step exists

`app.html` ships from `deploy.ps1` with `rowing_display.html`'s markup
inlined at a `<!-- ROWING_DISPLAY -->` marker, and every `<script src>` /
`<link>` inlined too. The raw source `app.html` in the repo root has none of
that — `#screen-rowing` is just two overlay `<div>`s. `controller.js`'s
`enterRowing()` calls `initRowing()` unconditionally (no feature check), and
that function only exists once `rowing_display.js` is inlined, so testing
raw source directly throws a `ReferenceError` on the very first screen
transition.

`build-app.js` reproduces that inlining step — nothing else. It does not
touch `dist/`, does not SCP, does not push to git; those are `deploy.ps1`'s
job and stay there. Output goes to `tests/e2e/.build/<project>/app.html`.

It also patches two `config.js` values before inlining:

- `apiBaseUrl` — overridden per project (see below), so tests never depend
  on whatever happens to be in the committed `config.js`.
- `apexHomeUrl` — always forced to `about:blank`. The real value points at
  production (`xesync.enlistia.com/home.html`), and `showHome()` sets it as
  an `<iframe src>` directly; without this override, a successful login in
  a test would fetch the live production site.

## Two projects, two backends

| Project          | Backend                          | `apiBaseUrl` baked in                     |
|-------------------|-----------------------------------|--------------------------------------------|
| `client`          | none                               | `http://127.0.0.1:1` (nothing listens there) |
| `db-integration`  | `dev/docker-compose.yml`           | `http://localhost:3001` (local PostgREST)  |

Every `client` spec drives the app via `?debug=true[&offline=true]`, which
never calls `Api.*` — `client`'s bogus `apiBaseUrl` is a tripwire, not a
real dependency: if a future test regresses into an actual network call, it
fails immediately instead of quietly reaching out to the internet.

`db-integration` specs need the stack up:

```bash
podman compose -f ../../dev/docker-compose.yml up -d
```

They check reachability in `beforeAll` and call `test.skip()` if it's down,
so `npm run test:e2e` (which runs both projects) doesn't hard-fail for
someone who hasn't started Postgres. The fixture user
(`e2e_test_user` / `E2eTestPass123!`) is seeded by
`dev/db-init/70-seed.sql` — keep the two in sync if either changes.

## Running

```bash
npx playwright test                        # both projects
npx playwright test --project=client       # no backend needed
npx playwright test --project=db-integration
npx playwright test --ui                   # interactive
```

`workers: 1` is deliberate, not conservative-by-default: `rowing-session.spec.js`
runs a real WebGL context, and running more than one in parallel was
confirmed (by hand, logging Chromium's own `GPU stall due to ReadPixels`
warnings) to delay `debug_sim.js`'s `setInterval` ticks past any reasonable
timeout. Serial execution costs wall-clock time, not correctness.

## What's covered where

Timing edge cases (pause threshold, activity predicate, sample-rate cap,
counter-reset math, pace derivation) have fast, deterministic coverage
already in `tests/*.test.js` via a fake clock — no browser needed. These
specs exist to prove the real page wires it all together: debug packets to
visible DOM text, screen transitions, the pause → save/exit → post-workout
chain, and (in `db-integration`) the real login form through to a row that's
actually retrievable from Postgres afterward.
