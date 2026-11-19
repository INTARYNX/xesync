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

It also patches three `config.js` values before inlining:

- `apiBaseUrl` — overridden per project (see below), so tests never depend
  on whatever happens to be in the committed `config.js`.
- `apexHomeUrl` — always forced to `about:blank`. The real value points at
  production (`xesync.enlistia.com/home.html`), and `showHome()` sets it as
  an `<iframe src>` directly; without this override, a successful login in
  a test would fetch the live production site.
- `renderMode` — forced to `phases` (see "The scene" below).

## The scene: phases instead of the shader

The rowing scene is a ~900-line GLSL fragment shader. It needs a GPU: on a
machine without one (CI, a container, a software rasterizer) Chromium falls
back to SwiftShader, every frame costs a software rasterization of a
fullscreen shader, and the renderer main thread ends up busy enough to
starve the event loop. The page then stops answering Playwright's queries
and the spec times out waiting for a screen that is, in fact, already there —
the failure looks like the app never reached the rowing screen, but it did.

So the test build runs `renderMode: 'phases'` instead of `'webgl'`. That
renderer keeps the entire stroke cycle — the tracker that locks the cycle
onto the rower's stroke ticks, the pose track, the surge, the drive-fraction
easing — and replaces only the rasterization: the four phases of the stroke
(Catch, Drive, Finish, Recovery) are drawn as a strip instead of pixels, and
the current phase is exposed as `data-phase` on `#phase-strip`.

`APP_RENDER_MODE=webgl` (or `--render-mode=webgl`) puts the real scene
back, for a machine that has a GPU.

The phase table itself is pinned by `tests/rowing_phases.test.js`, which
runs without a browser.

## The shader is still tested

The `phases` renderer means the shader itself is never drawn by this suite.
That is not a reason to leave it unchecked: `shader.spec.js` compiles and
links the **real GLSL** from `rowing_display.html` in a headless WebGL
context (a compile is cheap, a fullscreen draw is not), asserts there is no
GLSL error, checks that `u_chain` is an *active, settable* uniform — an
unused uniform gets optimised away and the scene would silently ignore the
chain — and then draws the same scene twice, identical in every respect but
`u_chain`, and compares the pixels. It proves the chain has a visible effect
on the image, not merely a presence in the source.

The same method is used for the ghost and for the dressing: the scene is
drawn twice, identical in every respect but `u_ghostOn` or but the
livery's colours, and the pixels are compared. A livery that changes
nothing is not a livery.

`scene-shot.js` is the companion tool: it renders the scene by hand
(uniforms set explicitly) and saves the "without chain / with chain / with
the tier-up swell / the ghost / the livery" pictures in `docs/images/`.
Those are stills of the shader, not screenshots of the running app.

One thing to know if you touch the shader: a WebGL uniform starts at
zero, and the theme's grade multiplies the whole frame. A draw that
forgets it produces a black picture, not a wrong one - which is how the
offline pictures caught it. The shader now treats an unset grade as "no
grade", but any tool that draws the scene by hand still has to dress the
boat.

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

No container runtime? `dev/dev-stack.sh` brings the same stack up natively
(PostgreSQL 16 + PostgREST 12.2.3, same ports, same schema, same seed):

```bash
../../dev/dev-stack.sh up      # or: down / reset / status
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
chain, the chain level reaching the scene packet after packet, the ghost of
the best run being placed in the scene, the shader compiling and both the
chain and the ghost changing the pixels, and (in `db-integration`) the real
login form through to a row that's actually retrievable from Postgres
afterward.
