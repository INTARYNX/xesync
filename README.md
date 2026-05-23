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
                                          ├─ ftms_integration.js  (session tracking, UI)
                                          ├─ rowing_display.html  (WebGL scene)
                                          └─ config.js            (endpoints)

Server
  ├─ PostgreSQL (xesync schema, SECURITY DEFINER functions)
  ├─ PostgREST  (auto-generated REST API on /rpc/*)
  └─ Mail worker (cron → SMTP for verification emails)
```

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
app.html              # Main shell: routing, login, BLE bridge
app.css               # App styles
config.js             # Runtime configuration (URLs)
rowing_display.html   # WebGL rowing scene (injected at build time)
rowing_display.css    # Styles for the rowing display
rowing_display.js     # WebGL init, animation loop, uniforms
ftms_integration.js   # FTMS session tracking, state machine, save flow
ftms_captured.js      # Real FTMS packets for debug mode
test_app.html         # Browser-based test harness (simulates the Android bridge)
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
var XEsync_CONFIG = {
  apiBaseUrl: 'https://your-server/api',   // PostgREST root
  homeUrl:    'https://your-server/',
  logRawData: false                        // set true to POST every FTMS packet (debug only)
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
| POST | `/rpc/log_rawdata`         | `{date, data}` → raw FTMS frame (debug, guarded by `logRawData`) |

All endpoints return a JSON array with a `status` field (`"success"` / `"error"`). See [API.md](API.md) for full schemas.

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
2. Inlines `config.js`, `ftms_integration.js`, `ftms_captured.js`
3. Writes `dist/app.html` (UTF-8, no BOM)
4. Copies static assets to `dist/`
5. SCPs `dist/` to the remote server
6. Commits and pushes to GitHub

---

## Local testing

Open `test_app.html` in a browser. It simulates the Android BLE bridge with buttons for scan, connect, FTMS data packets, disconnect, and save. No Android device needed to test the full session flow.

For the WebGL shader standalone (no metrics UI), open the file in `inline/` if present, or use the debug mode button in the app after building.

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
- [ ] Multi-session history view
- [ ] Password reset by email
- [ ] LISTEN/NOTIFY-based mail worker (no cron lag)

---

## License

MIT — see [LICENSE](LICENSE)

---

## Contributing

PRs welcome. Open an issue first for anything beyond a bug fix.