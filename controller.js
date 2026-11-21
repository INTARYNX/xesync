// =====================================================================
// controller.js - orchestration. The only module that ties the others
// together: handles user actions and bridge messages, updates state,
// then calls view / api / bridge. Holds no DOM code and no raw fetch.
// =====================================================================

// -- Boot ------------------------------------------------------------
(function init() {
  var params = new URLSearchParams(window.location.search);
  ui.offline = !navigator.onLine;
  ui.debug   = params.get('debug') === 'true';

  Bridge.setHandlers({
    autoLogin:     onAutoLogin,
    scanResult:    function (m) { showDevices(m); },
    connectResult: onConnectResult,
    disconnected:  onDisconnected,
    reconnected:   onReconnected,
    ftmsData:      function (m) { onFtmsData(m.data); },
    saveAck:       function ()  {},
    uploadWorkout: onUploadWorkout,
    tagCleared:    function ()  {},
    goHome:        showHome
  });

  bootTimer = setTimeout(finishBoot, 1500);

  document.addEventListener('DOMContentLoaded', function () {
    render();
    var tbarVersion = document.getElementById('tbar-version');
    if (tbarVersion) tbarVersion.textContent = 'v' + XESYNC_CONFIG.appVersion;
    if (params.get('offline') === 'true') goOffline();
    // Strip stray spaces (common from mobile autocorrect) on blur
    ['username', 'reg-username'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('blur', function () { el.value = el.value.trim(); });
    });
  });

  window.addEventListener('online',  function () { ui.offline = false; render(); });
  window.addEventListener('offline', function () { ui.offline = true;  render(); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && ui.screen === 'login') doLogin();
  });

  window.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.type === 'shaderReady') hideLoadingOverlay();
    if (e.data.type === 'tokenExpired') {
      ui.token = null; ui.username = null;
      setUserBadge('');
      setLoginStatus('Session expired. Please log in again.');
      goScreen('login');
    }
  });

  window.addEventListener('hashchange', function () {
    if (window.location.hash.indexOf('#data=') === 0) ingestData(null);
  });
})();

var bootTimer = null;

// The game layer's state for the current run. One object, created once
// and reset at every session start - run_score.js owns everything else
// about it.
var runState = RunScore.createRun();

// The course of the day: the same conditions and the same par for
// everyone rowing today. Drawn from the local date and hour, so no
// server is involved and every device agrees.
var dailyCourse = null;

// The profile of the ghost of the best run, once it has been fetched.
var ghostProfile = null;

// --- The dressing ----------------------------------------------------
//
// What the boat wears is read off the rower's history: how many
// sessions they have done (see costume.js). The count is cached on the
// phone, so a session started without a network still wears the right
// livery, and the server's count replaces it as soon as it answers.
var sessionCount = 0;
var currentLivery = null;

function sessionCountKey() { return 'xesync.sessionCount.v1'; }

function loadCachedSessionCount() {
  try {
    var raw = parseInt(localStorage.getItem(sessionCountKey()), 10);
    return (isFinite(raw) && raw > 0) ? raw : 0;
  } catch (e) { return 0; }
}

function saveCachedSessionCount(n) {
  try { localStorage.setItem(sessionCountKey(), String(n)); } catch (e) {}
}

// Put the outfit on the scene: the livery the history has earned, and
// the theme of the hour. Returns whether the livery changed - the one
// thing the game announces by itself.
function applyCostume(count, course) {
  if (typeof Costume === 'undefined') return false;
  // With the dressing off, the scene wears what it wore before there
  // was a dressing: the boat's own colours, the first land, no grade.
  var dressed = gameModesResolved().dressing;
  var outfit = dressed ? Costume.outfit(count, course) : Costume.plain();
  var previous = currentLivery;
  currentLivery = outfit.livery;
  if (typeof setCostume === 'function') setCostume(outfit);
  var changed = dressed && Costume.changed(previous, outfit.livery);
  if (dressed && typeof RunScore !== 'undefined') {
    RunScore.setLivery(runState, {
      key: outfit.livery.key,
      name: outfit.livery.name,
      changed: changed
    });
  }
  return changed;
}

// The count of sessions done, from the server.
function setSessionCount(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return;
  var count = Math.floor(n);
  if (count === sessionCount) return;
  sessionCount = count;
  saveCachedSessionCount(count);
  applyCostume(sessionCount, dailyCourse);
}

// The ghost is kept on the phone as well as on the server. The profile
// comes from the server, but a session started without a network should
// still have something to race against - the cached profile of the last
// known best run.
function ghostCacheKey() { return 'xesync.ghostProfile.v1'; }
function loadCachedGhost() {
  try {
    var raw = localStorage.getItem(ghostCacheKey());
    if (!raw) return null;
    var profile = JSON.parse(raw);
    return (profile && profile.points && profile.points.length) ? profile : null;
  } catch (e) { return null; }
}
function saveCachedGhost(profile) {
  try {
    if (profile) localStorage.setItem(ghostCacheKey(), JSON.stringify(profile));
  } catch (e) {}
}
function finishBoot() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  hideBootSplash();
}

// -- Login / auth ----------------------------------------------------
// Fire-and-forget Bridge.send whose result we don't need, but whose
// rejection (Capacitor's Preferences calls can throw) must not become an
// unhandled promise rejection.
function sendBridge(action, data) {
  var p = Bridge.send(action, data);
  if (p && typeof p.catch === 'function') {
    p.catch(function (e) { console.error('[bridge] ' + action + ' failed', e); });
  }
}
function sendLoginResult(data) { sendBridge('loginResult', data); }

function onAutoLogin(msg) {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (!msg.token) { goScreen('login'); hideBootSplash(); return; }
  Api.validateToken(msg.token)
    .then(function (data) {
      if (data && data.status === 'success') {
        setSession(msg.token, data.username);
        sendLoginResult({ success: true, token: msg.token, username: data.username });
        setLoginStatus('');
        showHome();
      } else {
        setLoginStatus('Session expired: ' + ((data && data.error) || 'invalid token'));
        clearSession();
        sendLoginResult({ success: false, error: (data && data.error) || 'invalid token' });
        goScreen('login');
      }
      hideBootSplash();
    })
    .catch(function (e) {
      setLoginStatus('Network error: ' + e.message);
      hideBootSplash();
      goOffline();
    });
}

function doLogin() {
  var u = document.getElementById('username').value.trim();
  var p = document.getElementById('password').value;
  if (!u || !p) { setLoginStatus('Username and password required'); return; }
  setLoginStatus('');
  var btn = document.querySelector('#screen-login .btn');
  btn.disabled = true; btn.textContent = 'LOGGING IN...';
  Api.login(u, p)
    .then(function (data) {
      btn.disabled = false; btn.textContent = 'LOGIN';
      if (data && data.status === 'success' && data.token) {
        setSession(data.token, u);
        sendLoginResult({ success: true, token: data.token, username: u });
        showHome();
      } else {
        var err = (data && data.error) || 'Login failed';
        setLoginStatus(err);
        sendLoginResult({ success: false, error: err });
      }
    })
    .catch(function (e) {
      btn.disabled = false; btn.textContent = 'LOGIN';
      console.error(e);
      goOffline();
    });
}

function doRegister() {
  var u = document.getElementById('reg-username').value.trim();
  var e = document.getElementById('reg-email').value.trim();
  var p = document.getElementById('reg-password').value;
  if (!u || !e || !p) { setRegisterStatus('All fields required'); return; }
  if (!document.getElementById('reg-consent').checked) {
    setRegisterStatus('You must accept the privacy policy to continue'); return;
  }
  setRegisterStatus('');
  var btn = document.querySelector('#screen-register .btn.primary');
  btn.disabled = true; btn.textContent = 'CREATING...';
  Api.register(u, e, p)
    .then(function (data) {
      btn.disabled = false; btn.textContent = 'CREATE';
      if (data && data.status === 'success') {
        document.getElementById('reg-password').value = '';
        openOverlay('registerSuccess');
      } else {
        setRegisterStatus((data && data.error) || 'Registration failed');
      }
    })
    .catch(function (err) {
      btn.disabled = false; btn.textContent = 'CREATE';
      setRegisterStatus('Network error: ' + err.message);
    });
}

function hideRegisterSuccess() { goScreen('login'); }

function setSession(token, username) {
  ui.token = token; ui.username = username;
  setUserBadge(username);
}
function clearSession() {
  ui.token = null; ui.username = null;
  setUserBadge('');
}

// -- Offline ---------------------------------------------------------
function goOffline() {
  ui.offline = true;
  sendLoginResult({ success: false, offline: true });
  goScreen('scan');
}

// -- Home ------------------------------------------------------------
function showHome() {
  var iframe = document.getElementById('home-frame');
  var sendToken = function () {
    iframe.contentWindow.postMessage({ type: 'token', token: ui.token }, '*');
  };
  if (iframe.src && iframe.src !== 'about:blank' && iframe.src.indexOf(XESYNC_CONFIG.apexHomeUrl) === 0) {
    sendToken();
  } else {
    iframe.onload = sendToken;
    iframe.src = XESYNC_CONFIG.apexHomeUrl;
  }
  goScreen('home');
}

// -- Exit / logoff ---------------------------------------------------
function doExit() {
  if (ui.screen === 'login') { Bridge.send('exit'); return; }
  openOverlay('exitConfirm');
}
function hideExitConfirm() { closeOverlay(); }

function doLogoff() {
  closeOverlay();
  clearSession();
  sendLoginResult({ success: false });
  ui.connected = false;
  ui.scanning = false;
  Debug.stopSim();
  document.getElementById('password').value = '';
  goScreen('login');
}

function doQuit() {
  closeOverlay();
  Bridge.send('exit');
}

// -- Scan ------------------------------------------------------------
var scanReturnScreen = null;

// Last rower that connected successfully, so the next scan can connect
// to it automatically instead of making the user tap it again every
// time - almost everyone only ever has the one rower. localStorage
// rather than a Bridge round-trip: works the same in the Capacitor
// WebView, a plain browser, and the debug simulator, with no native
// plugin involved for what is a pure convenience, not a credential.
var LAST_DEVICE_KEY = 'xesync_last_device';

function rememberDevice(device) {
  if (!device || !device.id) return;
  try {
    localStorage.setItem(LAST_DEVICE_KEY, JSON.stringify({ id: device.id, name: device.name || '' }));
  } catch (e) { /* storage unavailable/full - the one-tap convenience just won't persist */ }
}

function getRememberedDevice() {
  try {
    var raw = localStorage.getItem(LAST_DEVICE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Set once per scan, so a remembered device found across several
// scanResult batches is only auto-connected to once.
var autoConnectTried = false;
// The device doConnect() is currently attempting, so onConnectResult
// (which only gets success/error back, not the device) knows what to
// remember on success.
var pendingDevice = null;

function startScan() {
  scanReturnScreen = ui.screen;
  ui.scanning = true;
  autoConnectTried = false;
  var remembered = getRememberedDevice();
  renderScanSearching(remembered ? remembered.name : null);
  goScreen('scan');
  if (Debug.isOn()) { Debug.fakeScan(showDevices); return; }
  Bridge.send('scan');
}

function stopScan() {
  Bridge.send('stopScan');
  ui.scanning = false;
  if (scanReturnScreen && scanReturnScreen !== 'scan' && scanReturnScreen !== 'connecting') {
    if (scanReturnScreen === 'home') showHome(); else goScreen(scanReturnScreen);
  } else if (ui.token) {
    showHome();
  } else {
    goScreen('scan');
  }
  scanReturnScreen = null;
}

function showDevices(msg) {
  var seen = {};
  var devices = (msg.devices || []).reduce(function (acc, d) {
    var parts = (d.id || '').trim().split(/\s+/);
    var mac = parts[0];
    if (!seen[mac]) { seen[mac] = true; acc.push({ id: mac, name: parts.slice(1).join(' ') || mac }); }
    return acc;
  }, []);
  renderDeviceList(devices, doConnect);

  if (!autoConnectTried) {
    var remembered = getRememberedDevice();
    if (remembered) {
      var match = devices.filter(function (d) { return d.id === remembered.id; })[0];
      // Tapping a different device in the meantime already moved on to
      // the connecting screen - don't also fire an auto-connect under it.
      if (match && ui.scanning) { autoConnectTried = true; doConnect(match); }
    }
  }
}

// -- Connect ---------------------------------------------------------
function doConnect(device) {
  ui.scanning = false;
  reconnectAbandoned = false; // a deliberate, fresh connect attempt
  pendingDevice = device;
  setConnectingLabel('CONNECTING...');
  goScreen('connecting');
  if (Debug.isOn()) { Debug.fakeConnect(onConnectResult); return; }
  Bridge.send('connect', { deviceId: device.id, deviceName: device.name });
}

function onConnectResult(msg) {
  // The native layer reports connectResult:success on any successful
  // connect, whether it's a first connection or a reconnect after a drop -
  // it can't tell the two apart itself. If the reconnect overlay is up,
  // treat this as a reconnection: stop the retry timer and just resume
  // the live session.
  if (ui.overlay === 'reconnect') {
    if (msg.success) {
      stopReconnect();
      closeOverlay();        // back to the live rowing screen, tracking intact
    }
    // a failure here is ignored: the retry timer keeps going until RECONNECT_MAX
    return;
  }
  if (reconnectAbandoned) {
    // Stale result from a reconnect attempt still in flight when we already
    // gave up on it (a native connect() can outlast RECONNECT_DELAY). The
    // user has already moved on - don't resume rowing or bounce their
    // screen, just tear down a connection that may have succeeded behind
    // our back.
    reconnectAbandoned = false;
    if (msg.success) Bridge.send('disconnect');
    return;
  }
  if (msg.success) {
    ui.connected = true;
    rememberDevice(pendingDevice);
    enterRowing();
  } else {
    setConnectingLabel(msg.error || 'CONNECTION FAILED');
    setTimeout(function () { goScreen('scan'); }, 2000);
  }
}

function enterRowing() {
  showLoadingOverlay();
  goScreen('rowing');
  Coaching.setMode(loadCoachingMode());
  // The switches of the game layer, read before the screen that shows
  // them: the card has to draw the state the rower chose last time.
  loadGameModes();
  initRowing();
  initFtmsTracking();
  // The screen that waits for the first stroke: the rower is asked not
  // to row yet, because the session starts cold, and this is where the
  // game layer is configured.
  if (typeof GameModesView !== 'undefined') GameModesView.showWaiting();
  if (Debug.isOn()) Debug.startSim();
}

// --- Reconnect (driven by the web app) ------------------------------
// On an unplanned drop the native layer sends {"action":"disconnected"}.
// The web app then drives the retries: it shows the RECONNECTING overlay
// and sends {"action":"reconnect"} up to RECONNECT_MAX times, RECONNECT_DELAY
// apart. The native layer answers each reconnect by attempting to
// reconnect to the same device, then reports the result as
// {"action":"connectResult","success":true|false}.
//   - success arrives while overlay is up -> cancel timer, close overlay, resume
//   - all attempts used up               -> give up, close overlay, mark disconnected
var RECONNECT_MAX   = 3;
var RECONNECT_DELAY = 5000;
var reconnectTries  = 0;
var reconnectTimer  = null;
// True once we've given up on a reconnect cycle (RECONNECT_MAX hit, or the
// user bailed via doGiveUp) but a connect() attempt from that cycle may
// still be in flight - see onConnectResult.
var reconnectAbandoned = false;

function onDisconnected() {
  if (ui.overlay === 'reconnect') return;  // already reconnecting
  reconnectTries = 0;
  openOverlay('reconnect');
  attemptReconnect();
}

function attemptReconnect() {
  reconnectTries++;
  Bridge.send('reconnect');
  reconnectTimer = setTimeout(function () {
    if (reconnectTries >= RECONNECT_MAX) {
      stopReconnect();
      ui.connected = false;
      reconnectAbandoned = true; // this cycle's last connect() may still resolve late
      closeOverlay();
      // No more FTMS packets, so the inactivity watchdog has paused the
      // session: the PAUSED dialog (SAVE / EXIT) is waiting for the user.
    } else {
      attemptReconnect();
    }
  }, RECONNECT_DELAY);
}

function stopReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function onReconnected() {
  stopReconnect();
  closeOverlay();
}

function doGiveUp() {
  stopReconnect();
  reconnectAbandoned = true; // same reason as the automatic give-up above
  closeOverlay();
  Bridge.send('disconnect');
  ui.connected = false;
  ui.scanning = false;
  if (ui.token) showHome(); else goScreen('login');
}

function resumeRowing() { enterRowing(); }

function disconnectRower() {
  if (Debug.isOn()) Debug.stopSim();
  else Bridge.send('disconnect');
  ui.connected = false;
  ui.scanning = false;
  if (ui.token) showHome(); else goScreen('login');
}

function debugMode() {
  ui.connected = true;
  enterRowing();
}

// -- FTMS raw data ---------------------------------------------------
function onFtmsData(data) {
  ingestData(data);
  if (XESYNC_CONFIG.logRawData) logRaw(data);
}

function logRaw(data) {
  if (!ui.token) return;   // server rejects tokenless calls; don't bother it
  var d = new Date();
  var p = function (n, w) { return String(n).padStart(w || 2, '0'); };
  var dateStr = p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' +
                p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' +
                p(d.getMilliseconds(), 3);
  Api.logRawData(ui.token, dateStr, data);
}

function onUploadWorkout(msg) {
  // Native storage returns serialized JSON; the RPC expects a JSON object.
  var payload;
  try { payload = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data; }
  catch (e) {
    console.error('[bridge] unparseable stored workout, leaving it queued', msg.workout, e);
    return; // Keep unreadable entries rather than acknowledging them.
  }
  Api.saveWorkout(msg.token, msg.workout, payload)
    .then(function (row) {
      if (row && row.status === 'success') sendBridge('uploadAck', { workout: msg.workout });
    })
    .catch(function () {});
}

// -- Post workout (called by ftms_integration.js) --------------------
// Called by ftms_integration.js to persist a finished workout.
// Decides online (Api) vs offline (Bridge to native storage), then
// reports 'online' | 'offline' back through `done`.
window.onWorkoutSave = function (tag, payload, done) {
  function saveOffline() {
    // The current bridge returns a promise that resolves only once the
    // payload is actually persisted. Fall back to a fixed delay for any
    // bridge implementation whose send() doesn't return one.
    try {
      var saving = Bridge.send('saveData', { workout: tag, data: payload });
      if (saving && typeof saving.then === 'function') {
        saving.then(function () { done('offline'); }, function () { done('error'); });
      } else {
        setTimeout(function () { done('offline'); }, 1200);
      }
    } catch (e) {
      done('error');
    }
  }
  if (!ui.token) { saveOffline(); return; }
  var timeoutId;
  var gaveUp = false;
  var timeout = new Promise(function (_, reject) {
    timeoutId = setTimeout(function () { reject(new Error('timeout')); }, 10000);
  });
  var savePromise = Api.saveWorkout(ui.token, tag, payload);
  // If the timeout wins the race below, this request is still in flight and
  // may still land server-side after we've already stored it offline. Clear
  // that offline copy on a late success so it isn't re-uploaded (and
  // duplicated) on the next login's reuploadStoredWorkouts().
  savePromise.then(function (row) {
    if (gaveUp && row && row.status === 'success') sendBridge('uploadAck', { workout: tag });
  }, function () {});
  Promise.race([savePromise, timeout])
    .then(function (row) {
      clearTimeout(timeoutId);
      if (row && row.status === 'success') done('online');
      else { gaveUp = true; saveOffline(); }
    })
    .catch(function () { clearTimeout(timeoutId); gaveUp = true; saveOffline(); });
};

window.onLeaveRowing = function () {
  CoachingView.reset();
  setConnectingLabel('');
  goScreen('connecting');
};

window.onWorkoutComplete = function (savedState, extra) {
  renderPostWorkout(savedState, !!ui.token,
                    extra && extra.splitsTable,
                    extra && extra.coachingSummary,
                    extra && extra.runScore);
  openOverlay('postWorkout');
};

// -- Coaching (encouragements / milestones / mini-challenges) --------
// AMELIORATIONS_PRODUIT.md. ftms_integration.js only knows about the
// window.onFtms*/onBeforeSave hooks it calls if present - all the rule
// logic lives in coaching.js, all the DOM in coaching_view.js.
//
// Mode is a same-device UI preference, not account data that needs to
// survive a reinstall, so plain localStorage is enough here - it avoids
// adding a new bridge action on both platforms just to flip one toggle.
function coachingModeKey() { return 'coachingMode_' + (ui.username || 'guest'); }
function loadCoachingMode() {
  try { return localStorage.getItem(coachingModeKey()) === 'justRow' ? 'justRow' : 'coaching'; }
  catch (e) { return 'coaching'; }
}
function saveCoachingMode(mode) {
  try { localStorage.setItem(coachingModeKey(), mode); } catch (e) {}
}
function toggleCoachingMode() {
  var next = Coaching.getMode() === 'coaching' ? 'justRow' : 'coaching';
  Coaching.setMode(next);
  saveCoachingMode(next);
  if (next === 'justRow') CoachingView.reset();
  // The switches follow the mode: in the calm mode a feature nobody has
  // touched is off, so the score chip goes with it - the way it always
  // did. The run keeps being scored; only the display is quiet.
  renderGameModes();
  applyGameModes();
  render();
}

// -- The switches of the game layer ------------------------------------
//
// The game layer is optional: the rower decides what they want to see.
// The switches live on the screen that waits for the first stroke (see
// game_modes_view.js), and they are a same-device preference like the
// coaching mode - plain localStorage, no server, no migration.
//
// Two rules, from game_modes.js: off means off - not shown, not saved -
// and a switch nobody has touched follows the mode.
var gameModes = (typeof GameModes !== 'undefined') ? GameModes.empty() : {};

function gameModesKey() { return 'xesync.gameModes.' + (ui.username || 'guest'); }
function loadGameModes() {
  if (typeof GameModes === 'undefined') return;
  try { gameModes = GameModes.parse(localStorage.getItem(gameModesKey())); }
  catch (e) { gameModes = GameModes.empty(); }
}
function saveGameModes() {
  if (typeof GameModes === 'undefined') return;
  try { localStorage.setItem(gameModesKey(), GameModes.serialize(gameModes)); } catch (e) {}
}
// What is on, right now: the switches, resolved against the mode.
function gameModesResolved() {
  if (typeof GameModes === 'undefined') {
    return { score: true, daily: true, ghost: true, dressing: true, koi: true };
  }
  return GameModes.resolve(gameModes, Coaching.getMode() === 'justRow');
}
function toggleGameFeature(key) {
  var resolved = gameModesResolved();
  GameModes.set(gameModes, key, !resolved[key]);
  saveGameModes();
  renderGameModes();
  applyGameModes();
}
function toggleGamePanel() {
  if (typeof GameModesView !== 'undefined') GameModesView.toggle();
}
function renderGameModes() {
  if (typeof GameModesView !== 'undefined') GameModesView.render(gameModesResolved());
}

// What the switches do, right now. Each feature follows its own
// switch: the chip, the day's par, the ghost, the dressing, the koi.
function applyGameModes() {
  var m = gameModesResolved();

  // The chip: the score, the chain ring and the lift bar.
  RunView.setVisible(m.score);

  // The day's par. The sky still follows the day - that is the scene's
  // weather, not the game's business.
  RunScore.setDailyPar(runState, m.daily ? dailyCourse : null);
  RunView.setDailyCourse(m.daily ? dailyCourse : null);

  // The koi: the push calls it only when the koi is on.
  RunScore.setFishEnabled(runState, m.koi);
  if (!m.koi && typeof setFish === 'function') {
    setFish({ present: false, hold: 0, landed: false });
  }

  // The ghost.
  if (!m.ghost) {
    ghostProfile = null;
    if (typeof setGhostProfile === 'function') setGhostProfile(null);
  } else {
    loadGhost();
  }

  // The dressing: the livery, the kit, the theme of the hour, the land.
  applyCostume(sessionCount, dailyCourse);
}

// The ghost of your best run.
//
// Fetched in the background, and never waited for: the session starts
// whether or not the ghost is there. If there is no account, no
// network, or no past run long enough to be worth racing, there is
// simply no ghost - and the game says nothing about it either way.
function loadGhost() {
  if (!ui.token || typeof Ghost === 'undefined') return;
  // With the ghost off, there is nobody to race: the best run is not
  // even looked up.
  if (!gameModesResolved().ghost) return;
  Api.listWorkouts(ui.token)
    .then(function (rows) {
      var list = rows || [];
      // The same list tells the boat how many sessions the rower has
      // done, which is what the livery is read from.
      setSessionCount(list.length);
      var best = Ghost.bestRun(list);
      if (!best) return null;
      return Api.getWorkout(ui.token, best.workout_id)
        .then(function (row) {
          if (!row || !row.samples || !row.samples.length) return null;
          var profile = Ghost.buildProfile(row.samples);
          if (profile) {
            ghostProfile = profile;
            saveCachedGhost(profile);
            if (typeof setGhostProfile === 'function') setGhostProfile(profile);
          }
          return profile;
        });
    })
    .catch(function () { /* no ghost today */ });
}

window.onFtmsSessionStart = function () {
  Coaching.reset();
  Coaching.setMode(loadCoachingMode());
  // The switches of the game layer, read like everything else at the
  // start of the session.
  loadGameModes();
  // A new session is a new run: the score, the chain and the lift all
  // start from zero.
  RunScore.reset(runState);
  RunView.mount();
  RunView.reset();
  // A new run starts with an empty chain, and the scene with it.
  if (typeof setChainLevel === 'function') setChainLevel(0);
  // And with no koi: a new session is a new run, and the water forgets.
  if (typeof setFish === 'function') setFish({ present: false, hold: 0, landed: false });

  // The course of the day. Two marks in the HUD - a notch on the ring
  // and the push dots - and a sky that is the same for everyone rowing
  // at this hour. No words, no setup, nothing to configure.
  dailyCourse = (typeof DailyCourse !== 'undefined')
    ? DailyCourse.forDate(new Date())
    : null;
  if (dailyCourse && typeof setSceneDay === 'function') {
    setSceneDay(dailyCourse.dayIndex);
  }

  // The dressing: the livery the history has earned, and the theme of
  // the hour. The cached count goes on straight away, so a session
  // without a network still wears the right livery.
  sessionCount = loadCachedSessionCount();
  currentLivery = null;

  // And the ghost of the best run. The cached one is put in place
  // straight away, so a session without a network still has a ghost;
  // the fresh one replaces it a moment later if the server knows better.
  var cached = loadCachedGhost();
  if (cached) {
    ghostProfile = cached;
    if (typeof setGhostProfile === 'function') setGhostProfile(cached);
  }

  // Then the switches, last: they are what applies the chip, the par,
  // the ghost, the dressing and the koi to the session that is starting.
  applyGameModes();

  // The screen that waited for the first stroke has done its job.
  if (typeof GameModesView !== 'undefined') GameModesView.hideWaiting();
};
window.onFtmsPause = function () {
  Coaching.onPause();
  CoachingView.hideChallenge();
};
window.onFtmsResume = function () { Coaching.onResume(); };
window.onFtmsTick = function (snapshot) {
  var evt = Coaching.tick(snapshot);
  if (evt) CoachingView.showMessage(CoachingText.resolve(evt.textKey, evt.textArgs));
  CoachingView.renderChallenge(Coaching.getChallenge());

  // The game layer runs off the same snapshot. It never blocks the
  // coaching layer and vice versa: both are just readers of the same
  // measures.
  var runEvt = RunScore.tick(runState, snapshot);
  RunView.render(runState);

  // The scene's half of the game layer: the chain level goes to the
  // renderer, which answers it by moving the world. A tier up gets a
  // short surge of the boat.
  if (typeof setChainLevel === 'function') {
    setChainLevel(RunScore.chainLevel(runState));
  }
  // The koi. The game layer says whether it is there and how close it
  // is to being landed; the scene swims it, and nothing is said.
  if (typeof setFish === 'function') {
    setFish(RunScore.fishState(runState));
  }
  if (runEvt && runEvt.type === 'chain_up' && typeof pulseChain === 'function') {
    pulseChain();
  }
  // Reaching the day's par gets the same visual beat: a short swell of
  // the boat. Nothing is said, nothing is awarded - the mark on the
  // ring is enough.
  if (runEvt && runEvt.parReached && typeof pulseChain === 'function') {
    pulseChain();
  }
};
window.onBeforeSave = function (payload) {
  var session = window.FtmsInternals.getSession();
  // Splits are fixed 500m distance rows (splits.js has no idea coaching.js
  // exists) - challenge results are reported separately, in coachingSummary.
  payload.splitsTable = Splits.computeSplitsTable(session.samples, payload.summary.duration);
  payload.coachingSummary = summarizeCoaching(Coaching.getSessionEvents());
  // The race against the ghost of the best run, settled at the same
  // elapsed time for both - so nobody gets to row longer and still be
  // ahead. This is the ghost's payoff: on the water it only spoke by
  // being where it was.
  if (ghostProfile && typeof Ghost !== 'undefined') {
    var race = Ghost.finalGap(ghostProfile, session.samples);
    if (race) RunScore.setGhostResult(runState, race);
  }
  // The run's score. The payload is archived verbatim in
  // xesync.workout_data, so this is stored as-is - no schema change
  // needed for the data itself.
  //
  // Off means off: with the score switched off, the number is not
  // saved at all - the server reads it from here, so the session card
  // shows no score. The par and the koi keep their own marks: they are
  // their own features, and they live in the same summary.
  var runSummary = RunScore.summarize(runState);
  if (!gameModesResolved().score) delete runSummary.score;
  payload.runScore = runSummary;
};

// Best sprint time per exact target distance, per account. A same-device
// preference in spirit (see coachingModeKey above) - not synced server-side,
// just enough to answer "how does this compare to my best" on this phone.
function sprintBestsKey() { return 'sprintBests_' + (ui.username || 'guest'); }
function loadSprintBests() {
  try { return JSON.parse(localStorage.getItem(sprintBestsKey()) || '{}'); }
  catch (e) { return {}; }
}
// Returns the PREVIOUS best for this distance (null if none yet), and
// persists the new one if it's faster - single read-modify-write so the
// caller never has to reconcile two separate calls.
function recordSprintResult(target, elapsedS) {
  var bests = loadSprintBests();
  var key = String(target);
  var prevBest = bests[key] != null ? bests[key] : null;
  if (prevBest == null || elapsedS < prevBest) {
    bests[key] = elapsedS;
    try { localStorage.setItem(sprintBestsKey(), JSON.stringify(bests)); } catch (e) {}
  }
  return prevBest;
}

// One entry per challenge that actually ran to completion (success or
// genuinely not followed) - an 'interrupted' attempt (pause/BLE drop) is
// dropped entirely, since nothing meaningful was measured. Real numbers
// only: a time, a distance covered, seconds in range - never just a
// pass/fail label with nothing behind it.
function summarizeCoaching(events) {
  var journal = events.filter(function (e) { return e.type === 'challenge' && e.outcome !== 'interrupted'; });
  var challenges = journal.map(function (e) {
    if (e.kind === 'distance') {
      var covered = e.distanceEnd - e.distanceStart;
      var title = 'Sprint · ' + e.target + ' m';
      if (e.outcome === 'success') {
        var elapsedS = e.tEnd - e.tStart;
        var prevBest = recordSprintResult(e.target, elapsedS);
        var textKey = prevBest == null ? 'sprintRecapFirst' : (elapsedS < prevBest ? 'sprintRecapBest' : 'sprintRecapBehind');
        return { kind: 'distance', outcome: e.outcome, meters: e.target, elapsedS: elapsedS, prevBestS: prevBest,
          title: title, detail: CoachingText.resolve(textKey, [elapsedS, prevBest]) };
      }
      return { kind: 'distance', outcome: e.outcome, meters: e.target, coveredM: covered,
        title: title, detail: CoachingText.resolve('sprintRecapIncomplete', [Math.round(covered), e.target]) };
    }
    return { kind: 'cadence', outcome: e.outcome, reference: e.reference, targetSpm: e.targetSpm,
      inRangeS: e.inRangeS, totalS: e.totalS,
      title: 'Cadence · ' + e.targetSpm + '+ spm',
      detail: CoachingText.resolve('cadenceRecap', [e.inRangeS, e.totalS, e.outcome === 'success']) };
  });
  return {
    milestonesReached:   events.filter(function (e) { return e.type === 'milestone'; }).length,
    challengesAttempted: journal.length,
    challengesSucceeded: journal.filter(function (e) { return e.outcome === 'success'; }).length,
    challenges: challenges
  };
}

function postWorkoutGoWorkouts() {
  closeOverlay();
  if (ui.token) showHome(); else goScreen('login');
}

function postWorkoutGoLogin() {
  closeOverlay();
  goScreen('login');
}
