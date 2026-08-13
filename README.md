# XEsync

Real-time Bluetooth rowing tracker for Xebex air rowers. Connects via a native Android app (App Inventor) that bridges BLE FTMS data to a WebView running this app.

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

---

## What it does

- Connects to a Xebex air rower over Bluetooth Low Energy (FTMS protocol)
- Displays live metrics: SPM, distance, watts, pace, calories, heart rate, elapsed time
- Animated WebGL rowing scene (day/night cycle, weather, reflections)
- Tracks sessions with automatic workout detection (starts on first stroke, ends after 5s inactivity)
- Saves workout data to a PostgreSQL + PostgREST backend
- Offline mode: hands the payload to the native Android app if no token is available

---

## Architecture

```
Android App (App Inventor)
  └─ BLE FTMS packets → WebView bridge → app.html
                                          ├─ state.js             (app state)
                                          ├─ view.js              (DOM rendering)
                                          ├─ api.js               (network calls)
                                          ├─ bridge.js            (App Inventor messaging)
                                          ├─ debug.js             (debug-mode fakes)
                                          ├─ ftms_integration.js  (FTMS session tracking)
                                          ├─ controller.js        (orchestration)
                                          ├─ rowing_display.html  (WebGL scene)
                                          └─ config.js            (endpoints)

Server
  ├─ PostgreSQL (xesync schema, SECURITY DEFINER functions)
  ├─ PostgREST  (auto-generated REST API on /rpc/*)
  └─ Mail worker (cron → SMTP for verification emails)
```

The frontend is split into single-responsibility modules with one-way
dependencies (`controller` is the only module that knows the others).
See [ARCHITECTURE.md](ARCHITECTURE.md) for the full breakdown.

The build process (`deploy.ps1`) inlines all CSS and JS into a single self-contained `app.html` for deployment. No bundler, no npm, no framework.

---

## Stack

- **Frontend**: Vanilla JS, WebGL (GLSL fragment shader)
- **Native bridge**: MIT App Inventor (Android)
- **Backend**: PostgreSQL + PostgREST
- **Mail worker**: Python (psycopg) + local MTA, cron-driven
- **Deploy**: PowerShell + SSH/SCP

See [API.md](API.md) for the full API reference.

---

## Project structure

```
app.html              # Main shell: screens, overlays, markup
app.css               # App styles
config.js             # Runtime configuration (URLs)
state.js              # Application state (the `ui` object) + id maps
view.js               # All DOM rendering; render() syncs UI to state
api.js                # Network calls (login, save, ...) returning Promises
bridge.js             # App Inventor messaging (send + dispatch)
debug.js              # Debug-mode fakes (fake scan/connect)
controller.js         # Orchestration: actions, bridge messages, state changes
ftms_integration.js   # FTMS session tracking, state machine, save flow
debug_sim.js          # Fake FTMS data generator for debug mode
rowing_display.html   # WebGL rowing scene (injected at build time)
rowing_display.css    # Styles for the rowing display
rowing_display.js     # WebGL init, animation loop, uniforms
ARCHITECTURE.md       # Module breakdown, state model, screen flow
deploy.ps1            # Build + deploy script
deploy.config.ps1.example  # Deploy config template (copy → deploy.config.ps1)
site/                 # Static landing pages

server/
  xesync_schema.sql   # Full PostgreSQL schema (idempotent)
  install.sh          # First-time install
  migrate.sh          # Apply schema changes to existing DB
  setup_worker.sh     # Set up the mail worker (venv, cron, DB user)
  mail_worker.py      # Email queue worker (local MTA)
```

---

## Configuration

### Runtime (`config.js`)

```js
var XESYNC_CONFIG = {
  apiBaseUrl:  'https://your-server/api',   // PostgREST root
  apexHomeUrl: 'https://your-server/',      // home dashboard loaded in the iframe
  logRawData:  false                        // set true to POST every FTMS packet (debug only)
};
```

The app calls PostgREST RPC endpoints under `apiBaseUrl/rpc/*`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/rpc/register`            | `{username, email, password}` → queues verification email |
| POST | `/rpc/verify_email`        | `{token}` → activates account |
| POST | `/rpc/resend_verification` | `{email}` → re-issues verification token |
| POST | `/rpc/login`               | `{username, password}` → `{token, username_out}` |
| POST | `/rpc/validate_token`      | `{token}` → `{status, username}`; extends expiry |
| POST | `/rpc/save_workout`        | `{token, workout, data}` → persists summary + samples |
| POST | `/rpc/list_workouts`       | `{token}` → workouts for the user, newest first |
| POST | `/rpc/log_rawdata`         | `{token, date, data}` → raw FTMS frame (debug, guarded by `logRawData`) |

All endpoints return a JSON array with a `status` field (`"success"` / `"error"`). See [API.md](API.md) for full schemas.

Every endpoint that writes resolves its token before the first write, and the
schema grants `EXECUTE` on an allowlist basis rather than revoking case by
case — see the Security notes in [API.md](API.md).

### Deploy (`deploy.config.ps1`)

Copy `deploy.config.ps1.example` to `deploy.config.ps1` and fill in your values:

```powershell
$SSH_USER   = 'your-user'
$SSH_HOST   = 'your.host'
$SSH_KEY    = "$env:USERPROFILE\.ssh\id_rsa"
$REMOTE_DIR = '/path/on/server'
$SITE_URL   = 'https://your-site.example'
```

`deploy.config.ps1` is gitignored and stays local.

---

## Server setup

On the server, from the `server/` directory:

```bash
# 1. Create the DB and roles (one-time, manual)
sudo -u postgres createdb xesync
sudo -u postgres psql -c "CREATE ROLE web_anon NOLOGIN;"

# 2. Install the schema
sudo bash install.sh

# 3. Set up the mail worker (creates venv, DB user, cron job)
sudo bash setup_worker.sh
```

To update an existing installation after pulling schema changes:

```bash
sudo bash migrate.sh
```

Both scripts are idempotent.

---

## Build & deploy (client)

```powershell
.\deploy.ps1
```

The script:
1. Inlines `rowing_display.html` body, CSS and JS into `app.html`
2. Inlines all `<script src>` (config, state, view, api, bridge, debug, ftms_integration, controller, debug_sim) and `<link>` stylesheets
3. Writes `dist/app.html` (UTF-8, no BOM)
4. Copies static assets to `dist/`
5. SCPs `dist/` to the remote server
6. Commits and pushes to GitHub

---

## Local testing

Open the app with `?debug=true` in the URL. Debug mode runs the full flow
with no Android device or rower: it fakes a found device and a successful
connection, and `debug_sim.js` feeds realistic FTMS data so the session,
metrics, and save flow all work in a plain browser.

Add `?offline=true` to start in the offline (no-login) flow. The two flags
can be combined: `?debug=true&offline=true`.

All debug behaviour lives in `debug.js` and `debug_sim.js`.

### Unit tests

```bash
node --test "tests/*.test.js"
```

No npm install, no build step, no dependencies — Node's built-in test runner
against the source files as they ship. `tests/harness.js` loads the browser
IIFEs into a `vm` sandbox with a fake clock, a fake DOM and a captured
`setInterval`, so session timing is deterministic rather than wall-clock
dependent.

Covered: packet decoding against a hand-checked fixture frame, malformed-frame
rejection, activity detection, session start/pause/resume, mid-session counter
resets, the sampling rate limit and cap, pace derivation, workout-id
uniqueness, payload shape, and bridge message dispatch.

### End-to-end (Playwright)

```bash
npm install                      # once
npx playwright install chromium  # once
npm run test:e2e
```

Drives a real Chromium against the debug simulator (`?debug=true`) — the
actual `app.html`, actual `rowing_display.js` WebGL scene, actual
`ftms_integration.js` state machine, with `debug_sim.js` standing in for BLE.
`tests/e2e/build-app.js` reproduces `deploy.ps1`'s inlining step (without its
SCP/git-push side effects) so the page under test has the same DOM shape
production ships, not raw unbuilt source.

Two projects:

- **`client`** — no backend. Covers the login-screen overscroll fix and the
  full connect → row → pause → save/exit lifecycle. `apiBaseUrl` is baked in
  as an address nothing listens on, so a test that accidentally triggers a
  real network call fails loudly instead of quietly hitting production.
- **`db-integration`** — needs the local stack below running. Logs in through
  the real form, runs a debug session, saves it through the real
  `save_workout()`, then confirms via `list_workouts()` that it actually
  landed in Postgres. Skips itself if the stack isn't up.

Run one project at a time with `npx playwright test --project=client` /
`--project=db-integration`. See [tests/e2e/README.md](tests/e2e/README.md)
for how the two Chromium builds and the fake-vs-real backend split work.

### Local database (`dev/docker-compose.yml`)

A disposable Postgres 16 + PostgREST 12.2.3 stack, pinned to the exact
versions running in production, for testing schema changes and for the
`db-integration` Playwright project:

```bash
podman compose -f dev/docker-compose.yml up -d      # start
podman compose -f dev/docker-compose.yml down -v    # stop, wipe data
```

`dev/db-init/` mirrors the manual prod setup (roles, schema, grants — see
[pgsql/API.md](pgsql/API.md#security-notes)) and seeds one pre-verified user
(`e2e_test_user`) for the Playwright specs, since there's no local SMTP to
complete real email verification. PostgREST comes up on `localhost:3001`,
Postgres on `localhost:5433`.

Applying `pgsql/xesync_schema.sql` against this stack is exactly what
`pgsql/migrate.sh` does against production — reapply the whole idempotent
file — so it's a faithful rehearsal of a real migration, permission checks
included.

---

## FTMS packet format

Xebex air rowers use a non-standard 20-byte FTMS payload where 16-bit values are encoded as `high * 255 + low` (not standard little-endian `* 256`).

| Bytes (1-indexed) | Value |
|---|---|
| 3 | SPM × 0.5 |
| 5, 4 | Stroke count |
| 7, 6 | Distance (m) |
| 10, 9 | Pace (s/500m) |
| 12, 11 | Watts |
| 14, 13 | Calories |
| 17 | Heart rate (255 = no sensor) |
| 20, 19 | Elapsed time (s) |

---

## Roadmap

- [x] Migrate backend to PostgreSQL + PostgREST
- [x] Email verification flow
- [x] Password reset by email (`request_password_reset` / `reset_password_with_token`)
- [x] Workout history view (`home.html` — card list + detail modal via `list_workouts`/`get_workout`)
- [x] Default-deny permissions + auth-before-write on every mutating RPC
- [x] Automated tests: `tests/*.test.js` (Node, no deps) + `tests/e2e/` (Playwright)
- [x] Local dev stack (`dev/docker-compose.yml`) for rehearsing schema changes before prod
- [ ] Android beta track release (versioning policy: [pgsql/API.md](pgsql/API.md#versioning-policy))
- [ ] LISTEN/NOTIFY-based mail worker (no cron lag)

---

## License

MIT — see [LICENSE](LICENSE)

---

## Contributing

PRs welcome. Open an issue first for anything beyond a bug fix.