# XEsync — Capacitor port (replaces the AI2 shell)

Ports the native layer only. `state.js`, `view.js`, `api.js`,
`controller.js`, `ftms_integration.js`, `debug*.js`, `app.css`,
`rowing_display.*` are untouched — see [`ARCHITECTURE.md`](../ARCHITECTURE.md).
Only `bridge.js` changes: [`bridge.src.js`](bridge.src.js) replaces the
AI2-blocks side (WebViewString round-trip, BLE scan/connect, TinyDB,
keep-screen-on, status bar, exit) with direct Capacitor plugin calls,
behind the exact same `Bridge.send` / `Bridge.setHandlers` API.

**Status: BLE scan/connect/data/reconnect confirmed working on a real
Xebex rower + real Android phone (2026-08-08).** Every fix below was found
by actually running the app on hardware, not by reading code — several
would never have shown up otherwise. See `bridge.src.js`'s inline "FIXED"
comments for full detail on each; short version:

- **Package name matches the live AI2 app on purpose**: `appId` is
  `appinventor.ai_intarynx.XEsync` (from
  `ai2/youngandroidproject/project.properties`), not a made-up id. This
  is required for Play Store to treat future releases as *updates* to the
  existing app rather than a brand new listing — see "Publishing" below.
  `versionCode` in `android/app/build.gradle` must stay ahead of AI2's
  last shipped one (11).
- **`loginResult` no longer clears a valid token on a network blip.** AI2
  only checked `success` and cleared the token on any non-success reply,
  including a pure connectivity failure (`offline:true`). Fixed to only
  clear on a real rejection.
- **`saveData` no longer collides all offline workouts under one key.**
  AI2's block had a `join` with a dangling empty socket, so the TinyDB tag
  was always the literal string `"workout_"` — every offline save
  overwrote the last one. Fixed to use the real unique tag the web app
  already generates.
- **BLE scan uses no service-UUID filter.** The Xebex rower doesn't
  advertise the FTMS service UUID in its ADV packet, only after GATT
  connect — matches name (`XEBEX`) like the real AI2 blocks did, not a
  service filter (confirmed: filtered scan found nothing even standing
  next to the rower).
- **`BLUETOOTH_SCAN` needs `android:usesPermissionFlags="neverForLocation"`
  in the manifest**, not just the JS-side `androidNeverForLocation: true`
  flag — without it, Android's scan dispatcher silently drops every scan
  result for the app (confirmed via `BtGatt.ScanController: Skipping
  client for location deny list` in logcat). The plugin's own manifest
  declares it bare; overridden in `AndroidManifest.xml` with
  `tools:node="replace"`.
- **No FTMS byte trim.** AI2's blocks dropped the first+last byte of the
  raw notification (`segment(start=2, length=len-2)`), compensating for
  extra framing bytes that extension's own BLE API added. Capacitor's
  `DataView` here is already the clean 20-byte GATT value — trimming it
  further left 18 bytes, one under `ftms_integration.js`'s 20-byte
  minimum, so every packet was silently rejected (rowing screen stuck on
  "READY TO ROW" despite data visibly arriving).
- **Reconnect no longer stacks concurrent `connect()` calls.**
  `controller.js`'s retry loop fires every 5s regardless of whether the
  previous attempt settled; the plugin's default connect timeout is 10s.
  A `connecting` guard flag now ignores overlapping attempts. The connect
  timeout itself is 8000ms — *not* AI2's own `ConnectionTimeout` value
  (1000ms): tried that first on the theory it was proven-in-production,
  but Capacitor's JS↔native bridge adds latency AI2's direct extension
  didn't have, and 1000ms failed every attempt on-device. 8000ms is
  comfortably above the ~3s a real successful connect took.
- **First notification after (re)connecting is discarded.** The rower
  pushes its last-held reading (frozen, possibly a nonzero stroke rate)
  immediately on subscribe — a known BLE peripheral pattern, not live
  data. Without skipping it, the app would start a phantom "rowing"
  session the instant you connect, before you've touched the rower.

## Package name & Play Store continuity

`capacitor.config.json`'s `appId` and `android/app/build.gradle`'s
`applicationId`/`namespace` are **`appinventor.ai_intarynx.XEsync`** —
copied exactly from the live AI2 app
(`ai2/youngandroidproject/project.properties`, `main=appinventor.ai_intarynx.XEsync.Screen1`).
Do not change this casually: a different package name means Play Store
treats this as an unrelated new app, losing every existing install/review.

Consequence you'll hit testing on a phone that already has the real AI2
app installed: `adb install` fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`
(different signing cert) or `INSTALL_FAILED_VERSION_DOWNGRADE` (our
`versionCode` was below AI2's). `adb uninstall appinventor.ai_intarynx.XEsync`
first if you need to sideload a test build over it — this deletes the
existing app locally (not the account/server data, just anything cached
only in TinyDB/Preferences, e.g. an un-uploaded offline workout).

## One-time setup

```powershell
cd capacitor
npm install
npx cap add android   # already done - only needed again if android/ is deleted
```

`cap add android` generates `capacitor/android/`. It's **not gitignored on
purpose** (unlike a typical Capacitor project) — several manual native
edits below live in there and must be committed, or a fresh `cap add
android` silently drops them:

### Manual edits that must survive `cap add android` / `cap sync`

| File | Change | Why |
|---|---|---|
| `android/app/src/main/AndroidManifest.xml` | `android:screenOrientation="landscape"` on `MainActivity` | AI2's `Screen1.scm` locked `"ScreenOrientation":"landscape"`; Capacitor has no config-file equivalent |
| `android/app/src/main/AndroidManifest.xml` | `<uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" tools:node="replace" />` | see "no service-UUID filter" note above — required for scan results to reach JS at all |
| `android/app/src/main/java/appinventor/ai_intarynx/XEsync/MainActivity.java` | immersive mode (hides status bar + nav bar, `WindowInsetsControllerCompat`) | replaces AI2's Barstool extension; this is a rowing console screen, no system chrome should be visible/tappable mid-workout |
| `android/app/build.gradle` | `versionCode 12`, `versionName "2.02"`, signing config block | must stay ahead of AI2's last shipped `versionCode` (11); signing config loads `key.properties` (see Publishing below) |

If `android/` ever gets deleted and regenerated, redo all four before
building again.

## Build

```powershell
.\build-capacitor.ps1                   # debug APK, installable via adb, builds the podman image if missing
.\build-capacitor.ps1 -SkipImageBuild   # reuse an already-built image (fast path, use this normally)
.\build-capacitor.ps1 -Release          # signed release AAB for Play Store, needs keys/upload.keystore
```

This assembles `www/` from the repo root (same `ROWING_DISPLAY` marker
substitution `../deploy.ps1` does, minus the full inlining AI2 needed —
Capacitor is fine with a normal multi-file `www/`; `app.html` is written
out as `www/index.html`, Capacitor's required entry point name), then
runs `cap sync android && gradlew ...` inside the container from
[`Containerfile`](Containerfile) so the host's JDK 11 is never touched
(`@capacitor/android` requires JDK 21, confirmed via a real
`invalid source release: 21` build failure under JDK 17). Gradle/SDK
caches persist in the `xesync-gradle-cache` podman volume, and
`~/.android` (debug signing key) in `xesync-android-home` — without that
second volume every container run (`--rm`, throwaway filesystem) got a
new random debug key, breaking `adb install -r` on the very next build.

### Installing a debug build for testing

```powershell
capacitor\.platform-tools-win\adb.exe install -r bin\xesync-debug.apk
capacitor\.platform-tools-win\adb.exe shell am force-stop appinventor.ai_intarynx.XEsync
capacitor\.platform-tools-win\adb.exe shell monkey -p appinventor.ai_intarynx.XEsync -c android.intent.category.LAUNCHER 1
```

(`.platform-tools-win/` is a local, gitignored copy of Android's
`platform-tools` for Windows — not part of the Android SDK image, fetched
separately since the SDK itself only exists inside the podman container,
which has no USB/phone access.)

MIUI/HyperOS quirks hit while testing:
- **"Install via USB" must be enabled** in Developer Options separately
  from "USB debugging".
- Installs can fail silently with `INSTALL_FAILED_USER_RESTRICTED` and no
  visible popup — that's MIUI's own `PI-ScanInterceptor` security scan on
  the APK, not a real permission prompt. Retrying a couple of times
  usually gets past it.
- Wireless adb (`adb tcpip 5555` + `adb connect <phone-ip>:5555`) is
  useful for testing away from the PC (e.g. actually at the rower) but
  drops when the phone leaves WiFi range or sleeps — reconnect via USB
  and re-run `adb tcpip 5555` when that happens.

### On-device debugging (removed from the shipped build)

While bringing BLE up, `bridge.src.js` had a temporary, unconditional
debug logger (`dbg()`): an on-screen panel plus a persisted
`xesync-debug.log` pulled via `adb shell run-as ... cat files/xesync-debug.log`.
That's what actually made the BLE bugs above findable - reading raw byte
arrays off a live rower isn't something you can guess your way through
from code alone. Removed entirely (along with the `@capacitor/filesystem`
dependency it needed) once BLE was confirmed reliably working on real
hardware, before the first real release build.

If BLE needs debugging again on a future build, the pattern is worth
re-adding rather than reasoning blind: an unconditional on-screen panel +
persisted log file, not gated behind `?debug=true` (that flag isn't
reachable by typing a URL on a packaged native app anyway).

## Publishing (Play Store, via API — no Play Console UI after first setup)

See [`../migration-ai2-capacitor.md`](../migration-ai2-capacitor.md) for
the full walkthrough. Short version, split by who does what:

**Only you can do these (need your Play Console / Google Cloud access):**
1. ✅ Play App Signing was already active on the existing listing (the AI2
   app predates this session) → requested an **upload key reset** instead,
   since nobody has AI2's original upload key. Submitted, awaiting Google's
   review (can take hours to a few days - identity verification on their
   end, nothing to do but wait).
2. Create a Google Cloud **service account**, download its JSON key, link
   + authorize it in Play Console (Settings → API access, "Release
   manager" role) — this is what lets `fastlane` publish without opening
   the console again. **Not done yet** - blocks the first `fastlane deploy`
   (steps below are ready and waiting on this).

**Already done:**
- `keys/upload.keystore` generated. `keys/upload_certificate.pem` is its
  exported public certificate (safe to share - that's what Google's key
  reset review actually wants, not the keystore itself).
- `android/app/build.gradle` wired to sign release builds with it.
- `.\build-capacitor.ps1 -Release` produces a signed
  `android/app/build/outputs/bundle/release/app-release.aab` — built and
  signature-verified once already (`jarsigner -verify` → `jar verified`).
- App icon + splash generated from `site/logo.png` (AI2's original icon,
  1254×1254 - big enough for adaptive icon generation) via
  `npx capacitor-assets generate --android`. Source lives in
  `resources/icon.png`; rerun that command if the icon ever changes.
- fastlane installed **inside the podman image**, not on Windows -
  RubyInstaller+MSYS2 is its own mess to maintain, and fastlane only runs
  at publish time, not on every build. `android/fastlane/Appfile` and
  `Fastfile` are in place; `Appfile`'s `json_key_file` points at
  `/work/capacitor/keys/play-store-sa.json` (container path) - drop the
  service account JSON there once step 2 above is done, then:
  ```powershell
  podman run --rm -v "${PWD}\..:/work:Z" -w /work/capacitor/android xesync-android-build "fastlane deploy"
  ```

### ⚠️ What's actually irreplaceable here

Losing the **podman image** costs nothing but rebuild time - it's fully
reproducible from `Containerfile` (committed to git), and the named
volumes (`xesync-gradle-cache`, `xesync-android-home`) are just caches.

Losing **`keys/upload.keystore` and its password** (in
`android/key.properties`) is permanent: no more updates to this app,
ever, short of going through another multi-day Google key-reset request.
Both files are gitignored on purpose (a keystore has no business in
version control) - which means **git is not backing them up**. Copy
`keys/upload.keystore` and the password out to a password manager /
secure backup now, before this ever leaves this machine.

## Known gaps / not yet ported

- iOS: `deviceId` from `bluetooth-le` is the MAC on Android (matches
  `connect`'s `deviceId` handling in `controller.js` today) but an
  opaque per-app UUID on iOS. Fine for Android-only; revisit if iOS ships.
