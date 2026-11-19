# XEsync Rowing - Architecture

Single-page app embedded in an App Inventor WebViewer. Drives a XEBEX
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
| `rowing_display.js` | The rowing scene: stroke cycle, pose track, and the two renderers (`webgl`, `phases`). | - |
| `run_score.js` | The game layer: the run's score, the chain and the lift, measured against the rower's own recent norm. Pure rules, no DOM. | - |
| `run_view.js` | The game layer's DOM: the score chip, the chain ring, the lift bar. Decides nothing. | - |

## The game layer

Two modules, same contract as the coaching pair: `run_score.js` holds the
rules, `run_view.js` draws them, and `controller.js` feeds one the
snapshot `ftms_integration.js` already builds.

```
packet ─▶ ftms_integration.js ─▶ controller.js ─▶ run_score.js ─▶ run_view.js
                                        │
                                        └─▶ coaching.js ─▶ coaching_view.js
```

Both layers read the same measures and neither knows about the other. The
score is attached to the saved workout as `payload.runScore`, alongside
`splitsTable` and `coachingSummary`.

## The rowing scene

`rowing_display.js` owns the stroke cycle: the tracker that locks the cycle
onto the rower's stroke ticks, the pose track the shader reads, the boat
surge and the drive fraction. It has two renderers, picked by
`config.js`'s `renderMode`:

- **`webgl`** (default, ships) — the GLSL scene, drawn on `#glCanvas`.
- **`phases`** — the same cycle, drawn as the four phases of the stroke
  (Catch, Drive, Finish, Recovery) instead of pixels, with the current
  phase exposed as `data-phase` on `#phase-strip`. The fragment shader
  needs a GPU; without one it is expensive enough to starve the browser's
  event loop, and the end-to-end suite cannot run. The test build selects
  it (`tests/e2e/build-app.js`); `APP_RENDER_MODE=webgl` selects the real
  scene.

The phase table is data, not code: `RowingPhases.PHASES` carries each
phase's order, name, english term, type, role, segment order and key
action, and `phaseAt()` maps a pose track position to a phase.
`tests/rowing_phases.test.js` pins it.

### The scene answers the chain

The scene is the game's display, not a decoration. `run_score.js` turns the
rower's hold above their own pace into a single number, `RunScore.chainLevel(state)`
(0..1), and `controller.js` hands it to the renderer on every packet:

```
packet ─▶ run_score.js ─▶ chainLevel(0..1) ─▶ controller.js ─▶ setChainLevel()
                                                              └─▶ u_chain (shader)
```

`rowing_display.js` keeps the level, smooths it, and uses it for three things:
the scene clock and the scroll run faster (`CHAIN_TIME_SCALE`,
`CHAIN_SCROLL_SCALE`), the wake and the trail grow (`traceFactor`), and a
tier up gives the rower a short swell (`pulseChain()` -> `u_scale` x1.12 for
`PULSE_S` seconds). All of it is bounded and reversible: when the chain
falls, the world slows down with it.

The shader is verified without a GPU in `tests/e2e/shader.spec.js`: the GLSL
is compiled and linked for real, `u_chain` is checked to be an active,
settable uniform, and the same scene is drawn twice - identical except for
`u_chain` - to prove the chain changes the pixels. The JavaScript side is
covered by `tests/scene_chain.test.js`.

### The dressing of the scene

The boat's livery, the rower's kit and the theme of the hour are decided
by `costume.js`, a pure module: the count of sessions done in, the
outfit comes out. The count comes from the same `list_workouts` call the
ghost uses, and is cached on the phone so a session without a network
still wears the right livery.

The scene only wears it: ten uniforms (`u_hullA`, `u_hullB`, `u_shirt`,
`u_shorts`, `u_cap`, `u_tint`, `u_livery`, `u_ridgeFar`, `u_ridgeNear`,
`u_tree`) replace constants that used to be written into the GLSL. A
WebGL uniform starts at zero, so the scene dresses itself with the club
livery as it loads - a theme of zero would multiply the whole frame by
nothing.

The land follows the same progression as the boat, on purpose: a new
livery is also a new place. The shader does not hold eight palettes any
more - it holds the two ends of the ridge (the far haze, the near band)
and derives the eight bands between them, which is what makes the
distance read. `u_chain` also agitates the ridge, so the land answers the
chain like the water already did.

Nothing here is configurable, and nothing here says anything: the livery
changes when the history crosses a threshold, and the only announcement
is a sweep of light along the hull (`u_livery`, 2.2 s on the real clock).

## The course of the day

`daily_course.js` is a third pure module, next to `run_score.js` and
`run_view.js`. It takes a date and returns the day: the conditions (the
weather index the shader reads as `u_day`) and the par (the chain
multiplier and the number of pushes the day asks for).

```
date ─▶ daily_course.js ─▶ { dayIndex, chainPar, pushPar }
                │                    │
                │                    ├─▶ RunScore.setDailyPar()  (the rule)
                │                    └─▶ RunView.setDailyCourse() (the mark)
                └─▶ setSceneDay() → u_day (the sky)
```

The hash is FNV-1a over `YYYY-MM-DD`, so the course of a day is the same
on every device without a server: that is what makes it a shared
challenge rather than a personal one. The par is a mark, never a
condition - the rules that decide it live in `run_score.js`, which
reports it as `event.parReached` and archives it in the run summary.

### The ghost of your best run

`ghost.js` is a fourth pure module. It takes the user's past sessions and
returns a distance-time profile the scene can replay.

```
list_workouts(token) ─▶ the sessions, with their 500 m split
        │
        ▼
  Ghost.bestRun()  ─▶ the fastest one long enough to be a session
        │
        ▼
get_workout(token, id) ─▶ its samples [t, distance, spm, ...]
        │
        ▼
  Ghost.buildProfile() ─▶ { points, duration, distance }
        │
        ▼
  setGhostProfile() ─▶ u_ghostX, u_ghostPhase, u_ghostOn
```

The ghost is placed against the player at the *same elapsed time*, not the
same distance: `Ghost.gapMetres()` gives the metres between the two, and
the scene turns that into a horizontal offset. Its stroke phase is
integrated from its own cadence in the same profile, so it rows at its own
pace instead of mirroring the player.

No new server data is involved: `list_workouts` already returns the split,
`get_workout` already returns the samples. The whole feature is a read.

The profile is also cached in `localStorage`, so a session started
without a network still has a ghost to race; the server's version
replaces it when it answers.

When the session ends, the race is settled: `Ghost.finalGap()` compares
the two runs at the same elapsed time - the shorter of the two - so
nobody can win by rowing longer. The result is carried by the run score
(`runScore.ghost`) and shown on the post-workout screen.

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
