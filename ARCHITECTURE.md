# XEsync - Architecture

Single-page app embedded in an App Inventor WebViewer. Drives a Xebex
rower over BLE (FTMS), tracks the workout, and saves it online or offline.

At deploy time `deploy.ps1` inlines every `<script src>` and `<link>` into
one self-contained `app.html`. In development the files stay separate.

## Module layout

Each file has one responsibility. Dependencies flow one way:
`controller` is the only module that knows the others.

| File | Responsibility | Depends on |
|------|----------------|------------|
| `state.js` | Application state (`ui`) and the screen/overlay id maps. Data only. | - |
| `view.js` | All DOM reads/writes. `render()` syncs the whole UI to `ui`. No logic, no network. | `state` |
| `api.js` | Network calls (login, register, save, ...). Returns Promises. | - |
| `bridge.js` | App Inventor messaging: `send()` out, `receive()` dispatches in. | - |
| `debug.js` | Debug-build fakes (fake scan, fake connect). Removable without touching prod code. | `state`, `debug_sim` |
| `ftms_integration.js` | FTMS packet parsing + workout session state machine. Delegates saving via callbacks. | `view` helpers |
| `debug_sim.js` | Generates fake FTMS data for debug mode. | - |
| `controller.js` | Orchestration. Handles user actions and bridge messages, mutates state, calls view/api/bridge. | all |

## State

All visual state lives in one object (`state.js`):

```
ui = {
  screen,     // login | register | home | scan | connecting | rowing
  overlay,    // null | postWorkout | exitConfirm | registerSuccess | reconnect
  scanning,   // BLE scan in progress
  connected,  // BLE rower connected
  token,      // auth token (null = logged out)
  username,
  offline,
  debug
}
```

Nothing reads the DOM to decide state. To change the UI you mutate `ui`
then call `render()`. `render()` is the single place that decides what
screen, overlay, and top-bar buttons are visible.

Helpers in `view.js`:
- `goScreen(name)` - switch screen (clears any open overlay first)
- `openOverlay(name)` / `closeOverlay()` - one overlay at a time

## Rendering rule

`render()` derives everything from `ui` in one pass:
- exactly one `.screen.active`
- exactly one (or zero) overlay `.visible`
- top bar hidden on `rowing`, otherwise buttons set from `connected` / `scanning`
- scan sub-views (`scan-idle` vs `scan-active`) from `scanning`
- offline prompts from `offline`

Because the whole UI is recomputed each call, two screens or a stale
overlay can never be shown at once.

## Communication with App Inventor

`bridge.js` is the only place that touches `AppInventor.setWebViewString`.

- Outgoing: `Bridge.send(action, data)`.
- Incoming: App Inventor calls `window.handleAppResponse(json)`, which
  `bridge.js` parses and dispatches to the handler map registered by the
  controller. A bare numeric CSV string is routed to the FTMS handler.

## Workout save flow

`ftms_integration.js` does not know about tokens or the network. When a
workout ends it builds the payload and hands it to the controller:

```
ftms.saveWorkout()
  -> window.onWorkoutSave(tag, payload, done)   // controller decides online/offline
       online : Api.saveWorkout(token, ...)  -> done('online' | 'offline')
       offline: Bridge.send('saveData', ...) -> done('offline')
  -> window.onWorkoutComplete(savedState)       // controller shows post-workout overlay
```

`window.onLeaveRowing()` is called first so the rowing screen is hidden
immediately, before any async save work runs.

## Reconnect flow

The web app drives reconnection; App Inventor only relays single attempts.

On an unplanned BLE drop:

```
App Inventor  -> {"action":"disconnected"}
controller    -> openOverlay('reconnect'), start retry loop
                 loop (up to RECONNECT_MAX = 3, RECONNECT_DELAY = 5s apart):
                   Bridge.send('reconnect')   // ask App Inventor to try once
                   wait 5s
                 success: App Inventor's Connected event sends
                   {"action":"connectResult","success":true}
                   -> stopReconnect(), closeOverlay(), session resumes
                 exhausted: stopReconnect(), ui.connected = false, closeOverlay()
                   -> no more FTMS packets, so the inactivity watchdog has
                      already paused the session; the PAUSED dialog
                      (SAVE / EXIT) is waiting for the user
```

The STOP button in the overlay calls `doGiveUp()` -> `stopReconnect()` and
leaves the rower.

App Inventor's only responsibilities: send `disconnected` on a drop, and
call `ConnectWithAddress` on each `reconnect` message. It runs no timer of
its own. Its existing `Connected` event already emits
`connectResult success:true`, which the controller interprets as a
reconnection when the reconnect overlay is up.

## Debug mode

Add `?debug=true` to the URL. Enables the DEBUG top-bar button and lets
the whole flow run with no hardware: `debug.js` fakes a found rower and a
successful connection, and `debug_sim.js` feeds realistic FTMS data.
Add `?offline=true` to start in the offline (no-login) flow.

All debug behaviour is contained in `debug.js` / `debug_sim.js`; deleting
those two files and the `?debug` checks removes it cleanly.

## Connectivity x session

Two independent conditions drive most of the branching:

- **online / offline** - `ui.offline` (set from `navigator.onLine`, the
  `online`/`offline` events, or a failed login/auto-login).
- **logged in / not** - `ui.token` is non-null once a login or a valid
  auto-login token succeeds.

They are independent: you can be offline with a valid token (kept from a
previous session) or online without one.

### At launch (auto-login)

| Online | Token | Result |
|--------|-------|--------|
| yes | valid   | `home` |
| yes | none/invalid | `login` |
| no  | any     | `scan` screen with "connect to internet and login" prompt |

A network error during auto-login falls through to the offline path
(`goOffline()` -> `scan`).

### Saving a workout

`ftms` always produces the payload; the controller picks the channel by token:

| Token | Channel | Result reported |
|-------|---------|-----------------|
| present | `Api.saveWorkout` (online) | `online`, or `offline` if the request fails/times out |
| none    | `Bridge.send('saveData')` (stored by App Inventor) | `offline` |

So "saved offline" can happen two ways: no token at all, or a token but
the network call failed. Either way App Inventor keeps the workout and
re-uploads it on the next successful login (`uploadWorkout` message).

### Post-workout buttons

The post-workout overlay shows up to two buttons:

| Token | WORKOUTS button | LOGIN button |
|-------|-----------------|--------------|
| present | shown -> `home` | shown -> `login` |
| none    | hidden          | shown -> `login` |

While the rower is still connected (`ui.connected`), ROW AGAIN and
DISCONNECT remain in the top bar behind the overlay regardless of
connectivity or token.

### Offline prompts

- `offline-notice` shows only on the `login` screen when offline.
- `scan-offline-msg` ("connect to internet and login") shows on the
  `scan` screen when offline.

Both are driven purely by `ui.offline` inside `render()`.

## Screen flow

```
login ──login──> home ──SCAN──> scan ──pick──> connecting ──ok──> rowing
  ^                ^               |                                 |
  |                |               └──stop──> back to caller         |
  └──logoff────────┘                                                 |
                                                            exit/save │
                                                                      v
                                              connecting + postWorkout overlay
                                                 │              │
                                          WORKOUTS/LOGIN    ROW AGAIN / DISCONNECT
```

While `connected` is true, ROW AGAIN and DISCONNECT stay available in the
top bar (including behind the post-workout overlay).
