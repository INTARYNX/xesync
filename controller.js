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

function startScan() {
  scanReturnScreen = ui.screen;
  ui.scanning = true;
  renderScanSearching();
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
}

// -- Connect ---------------------------------------------------------
function doConnect(device) {
  ui.scanning = false;
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
  if (msg.success) {
    ui.connected = true;
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
  initRowing();
  initFtmsTracking();
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
  renderPostWorkout(savedState, !!ui.token, extra && extra.splitsTable, extra && extra.coachingSummary);
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
  render();
}

window.onFtmsSessionStart = function () {
  Coaching.reset();
  Coaching.setMode(loadCoachingMode());
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
};
window.onBeforeSave = function (payload) {
  var session = window.FtmsInternals.getSession();
  // Splits are fixed 500m distance rows (splits.js has no idea coaching.js
  // exists) - challenge results are reported separately, in coachingSummary.
  payload.splitsTable = Splits.computeSplitsTable(session.samples, payload.summary.duration);
  payload.coachingSummary = summarizeCoaching(Coaching.getSessionEvents());
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
