# XeSync

Real-time Bluetooth rowing tracker for Xebex air rowers. Connects via a native Android app (App Inventor) that bridges BLE FTMS data to a WebView running this app.

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

---

## What it does

- Connects to a Xebex air rower over Bluetooth Low Energy (FTMS protocol)
- Displays live metrics: SPM, distance, watts, pace, calories, heart rate, elapsed time
- Animated WebGL rowing scene (day/night cycle, weather, reflections)
- Tracks sessions with automatic workout detection (starts on first stroke, ends after 5s inactivity)
- Saves workout data to a backend (APEX REST or any REST API)
- Offline mode: hands the payload to the native Android app if no token is available

---

## Architecture

```
Android App (App Inventor)
  └─ BLE FTMS packets → WebView bridge → app.html
                                          ├─ ftms_integration.js  (session tracking, UI)
                                          ├─ rowing_display.html  (WebGL scene)
                                          └─ config.js            (endpoints)
```

The build process (`deploy.ps1`) inlines all CSS and JS into a single self-contained `app.html` for deployment. No bundler, no npm, no framework.

---

## Stack

- **Frontend**: Vanilla JS, WebGL (GLSL fragment shader)
- **Native bridge**: MIT App Inventor (Android)
- **Backend**: Oracle APEX REST (can be replaced — see [Configuration](#configuration))
- **Deploy**: PowerShell + SSH/SCP

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
```

---

## Configuration

### Runtime (`config.js`)

```js
var XESYNC_CONFIG = {
  apexBaseUrl: 'https://your-server/apex/your-workspace/xesync',
  apexHomeUrl: 'https://your-server/apex/r/your-workspace/xesync/home',
  logRawData:  false   // set true to POST every FTMS packet to /rawdata (debug only)
};
```

Replace with your own REST backend. The app expects these endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/login` | `{username, password}` → `{token}` |
| POST | `/validate_token` | `token=...` (form) → `{status, username}` |
| POST | `/workout` | `{token, workout, data}` → `{status}` |
| POST | `/rawdata` | `{date, data}` → (debug only, guarded by `logRawData`) |

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

## Build & deploy

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

- [ ] Migrate backend to PostgreSQL + PostgREST
- [ ] Multi-session history view

---

## License

MIT — see [LICENSE](LICENSE)

---

## Contributing

PRs welcome. Open an issue first for anything beyond a bug fix.