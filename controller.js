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
    saveAck:       function ()  { if (ui.token) showHome(); },
    uploadWorkout: onUploadWorkout,
    tagCleared:    function ()  {},
    goHome:        showHome,
    rawFtms:       function (csv) { ingestData(csv); }
  });

  bootTimer = setTimeout(finishBoot, 1500);

  document.addEventListener('DOMContentLoaded', function () {
    render();
    if (params.get('offline') === 'true') goOffline();
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
function onAutoLogin(msg) {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (!msg.token) { goScreen('login'); hideBootSplash(); return; }
  Api.validateToken(msg.token)
    .then(function (data) {
      if (data && data.status === 'success') {
        setSession(msg.token, data.username);
        setLoginStatus('');
        showHome();
      } else {
        setLoginStatus('Session expired: ' + ((data && data.error) || 'invalid token'));
        clearSession();
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
        Bridge.send('loginResult', { success: true, token: data.token, username: u });
        showHome();
      } else {
        var err = (data && data.error) || 'Login failed';
        setLoginStatus(err);
        Bridge.send('loginResult', { success: false, error: err });
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
  Bridge.send('loginResult', { success: false, offline: true });
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
  initRowing();
  initFtmsTracking();
  if (Debug.isOn()) Debug.startSim();
}

function onDisconnected() {
  openOverlay('reconnect');
  Bridge.send('reconnect');
}
function onReconnected() { closeOverlay(); }

function doGiveUp() {
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
  var d = new Date();
  var p = function (n, w) { return String(n).padStart(w || 2, '0'); };
  var dateStr = p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' +
                p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' +
                p(d.getMilliseconds(), 3);
  Api.logRawData(dateStr, data);
}

function onUploadWorkout(msg) {
  Api.saveWorkout(msg.token, msg.workout, msg.data)
    .then(function (row) {
      if (row && row.status === 'success') Bridge.send('uploadAck', { workout: msg.workout });
    })
    .catch(function () {});
}

// -- Post workout (called by ftms_integration.js) --------------------
// Called by ftms_integration.js to persist a finished workout.
// Decides online (Api) vs offline (Bridge to App Inventor storage),
// then reports 'online' | 'offline' back through `done`.
window.onWorkoutSave = function (tag, payload, done) {
  if (!ui.token) {
    Bridge.send('saveData', { workout: tag, data: payload });
    setTimeout(function () { done('offline'); }, 1200);
    return;
  }
  var timeout = new Promise(function (_, reject) {
    setTimeout(function () { reject(new Error('timeout')); }, 10000);
  });
  Promise.race([Api.saveWorkout(ui.token, tag, payload), timeout])
    .then(function (row) {
      done(row && row.status === 'success' ? 'online' : 'offline');
    })
    .catch(function () { done('offline'); });
};

window.onLeaveRowing = function () {
  setConnectingLabel('');
  goScreen('connecting');
};

window.onWorkoutComplete = function (savedState) {
  renderPostWorkout(savedState, !!ui.token);
  openOverlay('postWorkout');
};

function postWorkoutGoWorkouts() {
  closeOverlay();
  if (ui.token) showHome(); else goScreen('login');
}

function postWorkoutGoLogin() {
  closeOverlay();
  goScreen('login');
}
