// =====================================================================
// XeSync app shell - login, BLE scan, workout flow, App Inventor bridge.
// All screen/topbar state goes through ui + render() (see ui.js).
// =====================================================================

// -- Boot ------------------------------------------------------------
ui.offline = !navigator.onLine;
ui.debug   = new URLSearchParams(window.location.search).get('debug') === 'true';

var bootSplashTimer = setTimeout(hideBootSplash, 1500);

function hideBootSplash() {
  if (bootSplashTimer) { clearTimeout(bootSplashTimer); bootSplashTimer = null; }
  var s = document.getElementById('boot-splash');
  if (!s) return;
  s.classList.add('hidden');
  setTimeout(function() { if (s.parentNode) s.parentNode.removeChild(s); }, 300);
}

document.addEventListener('DOMContentLoaded', function() {
  render();
  if (new URLSearchParams(window.location.search).get('offline') === 'true') goOffline();
});

window.addEventListener('online',  function() { ui.offline = false; render(); });
window.addEventListener('offline', function() { ui.offline = true;  render(); });

document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && ui.screen === 'login') doLogin();
});

// -- User badge ------------------------------------------------------
function setUserBadge(username) {
  var el = document.getElementById('tbar-user');
  el.innerHTML = username
    ? '<div class="tbar-avatar">' + username.slice(0, 2).toUpperCase() + '</div>'
    : '';
}

// -- Exit / logoff ---------------------------------------------------
function doExit() {
  if (ui.screen === 'login') { sendToApp('exit', {}); return; }
  document.getElementById('exit-confirm').classList.add('visible');
}

function hideExitConfirm() {
  document.getElementById('exit-confirm').classList.remove('visible');
}

function doLogoff() {
  hideExitConfirm();
  ui.token = null;
  ui.connected = false;
  ui.scanning = false;
  inDebugMode = false;
  DebugSim.stop();
  setUserBadge('');
  document.getElementById('password').value = '';
  goScreen('login');
}

function doQuit() {
  hideExitConfirm();
  sendToApp('exit', {});
}

// -- Register --------------------------------------------------------
function hideRegisterSuccess() {
  document.getElementById('register-success').classList.remove('visible');
  goScreen('login');
}

function setRegisterStatus(msg, ok) {
  var el = document.getElementById('register-status');
  el.textContent = msg;
  el.style.color = ok ? '#00A2E8' : '#f44336';
}

function doRegister() {
  var u = document.getElementById('reg-username').value.trim();
  var e = document.getElementById('reg-email').value.trim();
  var p = document.getElementById('reg-password').value;
  var consent = document.getElementById('reg-consent').checked;
  if (!u || !e || !p) { setRegisterStatus('All fields required'); return; }
  if (!consent) { setRegisterStatus('You must accept the privacy policy to continue'); return; }
  setRegisterStatus('');
  var btn = document.querySelector('#screen-register .btn.primary');
  btn.disabled = true;
  btn.textContent = 'CREATING...';
  fetch(XESYNC_CONFIG.apiBaseUrl + '/rpc/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, email: e, password: p })
  })
  .then(function(r) { return r.json(); })
  .then(function(arr) {
    btn.disabled = false;
    btn.textContent = 'CREATE';
    var data = Array.isArray(arr) ? arr[0] : arr;
    if (data && data.status === 'success') {
      document.getElementById('reg-password').value = '';
      document.getElementById('register-success').classList.add('visible');
    } else {
      setRegisterStatus((data && data.error) || 'Registration failed');
    }
  })
  .catch(function(err) {
    btn.disabled = false;
    btn.textContent = 'CREATE';
    setRegisterStatus('Network error: ' + err.message);
  });
}

// -- App Inventor bridge ---------------------------------------------
var inDebugMode = false;

function sendToApp(action, data) {
  var payload = JSON.stringify(Object.assign({ action: action }, data));
  var ai = window.AppInventor || (typeof AppInventor !== 'undefined' ? AppInventor : null);
  if (ai && ai.setWebViewString) { ai.setWebViewString(payload); }
  else { console.log('[to app]', payload); }
}

function handleAppResponse(json) {
  if (!json) return;
  var msg;
  try { msg = typeof json === 'string' ? JSON.parse(json) : json; }
  catch (e) {
    if (typeof json === 'string' && /^\s*\d/.test(json)) ingestData(json.trim());
    return;
  }
  switch (msg.action) {
    case 'autoLogin':     doAutoLogin(msg);     break;
    case 'scanResult':    onScanResult(msg);    break;
    case 'connectResult': onConnectResult(msg); break;
    case 'disconnected':  onDisconnected();     break;
    case 'reconnected':   onReconnected();      break;
    case 'ftmsData':      onFtmsData(msg);      break;
    case 'saveAck':       onSaveAck();          break;
    case 'uploadWorkout': onUploadWorkout(msg); break;
    case 'tagCleared':    onTagCleared(msg);    break;
    case 'goHome':        showHome();           break;
    default: console.warn('Unknown action:', msg.action);
  }
}
window.handleAppResponse = handleAppResponse;

window.addEventListener('message', function(e) {
  if (!e.data) return;
  if (e.data.type === 'shaderReady') {
    document.getElementById('loading-overlay').classList.remove('visible');
  }
  if (e.data.type === 'tokenExpired') {
    ui.token = null;
    setUserBadge('');
    setLoginStatus('Session expired. Please log in again.');
    goScreen('login');
  }
});

// -- Login -----------------------------------------------------------
function setLoginStatus(msg) {
  document.getElementById('login-status').textContent = msg;
}

function doAutoLogin(msg) {
  if (bootSplashTimer) { clearTimeout(bootSplashTimer); bootSplashTimer = null; }
  if (!msg.token) { goScreen('login'); hideBootSplash(); return; }
  fetch(XESYNC_CONFIG.apiBaseUrl + '/rpc/validate_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: msg.token })
  })
  .then(function(r) { return r.json(); })
  .then(function(arr) {
    var data = Array.isArray(arr) ? arr[0] : arr;
    if (data && data.status === 'success') {
      ui.token = msg.token;
      setUserBadge(data.username);
      setLoginStatus('');
      showHome();
    } else {
      setLoginStatus('Session expired: ' + ((data && data.error) || 'invalid token'));
      setUserBadge('');
      goScreen('login');
    }
    hideBootSplash();
  })
  .catch(function(e) {
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
  btn.disabled = true;
  btn.textContent = 'LOGGING IN...';
  fetch(XESYNC_CONFIG.apiBaseUrl + '/rpc/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p })
  })
  .then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  })
  .then(function(arr) {
    btn.disabled = false;
    btn.textContent = 'LOGIN';
    var data = Array.isArray(arr) ? arr[0] : arr;
    if (data && data.status === 'success' && data.token) {
      ui.token = data.token;
      setUserBadge(u);
      sendToApp('loginResult', { success: true, token: data.token, username: u });
      showHome();
    } else {
      var err = (data && data.error) || 'Login failed';
      setLoginStatus(err);
      sendToApp('loginResult', { success: false, error: err });
    }
  })
  .catch(function(e) {
    btn.disabled = false;
    btn.textContent = 'LOGIN';
    console.error(e);
    goOffline();
  });
}

// -- Offline ---------------------------------------------------------
function goOffline() {
  ui.offline = true;
  sendToApp('loginResult', { success: false, offline: true });
  goScreen('scan');
}

// -- Home ------------------------------------------------------------
function showHome() {
  var iframe = document.getElementById('home-frame');
  var sendToken = function() {
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

// -- BLE scan --------------------------------------------------------
var scanReturnScreen = null;

function startScan() {
  scanReturnScreen = ui.screen;
  ui.scanning = true;
  document.getElementById('device-list').innerHTML = '';
  document.getElementById('pulse-ring').style.display = '';
  document.getElementById('scan-label').textContent = 'SCANNING...';
  goScreen('scan');
  if (ui.debug) {
    // Debug: no real BLE, so emit a fake rower after a short delay
    setTimeout(function() {
      onScanResult({ devices: [{ id: 'DE:BU:G0:00:01 Debug Rower' }] });
    }, 1200);
    return;
  }
  sendToApp('scan', {});
}

function stopScan() {
  sendToApp('stopScan', {});
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

function onScanResult(msg) {
  document.getElementById('pulse-ring').style.display = 'none';
  document.getElementById('scan-label').textContent = 'SELECT ROWER';
  var list = document.getElementById('device-list');
  list.innerHTML = '';
  var seen = {};
  var devices = (msg.devices || []).reduce(function(acc, d) {
    var parts = (d.id || '').trim().split(/\s+/);
    var mac = parts[0];
    if (!seen[mac]) { seen[mac] = true; acc.push({ id: mac, name: parts.slice(1).join(' ') || mac }); }
    return acc;
  }, []);
  if (devices.length === 0) {
    list.innerHTML = '<div class="empty-msg">No rower found</div>';
    return;
  }
  devices.forEach(function(d) {
    var item = document.createElement('div');
    item.className = 'device-item';
    item.innerHTML = '<span>' + escHtml(d.name) + '</span>' +
                     '<span class="device-rssi">' + escHtml(d.id) + '</span>';
    item.onclick = function() { doConnect(d); };
    list.appendChild(item);
  });
}

// -- Connect ---------------------------------------------------------
function doConnect(device) {
  ui.scanning = false;
  document.getElementById('connecting-label').textContent = 'CONNECTING...';
  goScreen('connecting');
  if (ui.debug) {
    inDebugMode = true;
    setTimeout(function() { onConnectResult({ success: true }); }, 800);
    return;
  }
  sendToApp('connect', { deviceId: device.id, deviceName: device.name });
}

function onConnectResult(msg) {
  if (msg.success) {
    ui.connected = true;
    document.getElementById('loading-overlay').classList.add('visible');
    goScreen('rowing');
    initRowing();
    initFtmsTracking();
    if (inDebugMode) { DebugSim.reset(); DebugSim.start(); }
  } else {
    document.getElementById('connecting-label').textContent = msg.error || 'CONNECTION FAILED';
    setTimeout(function() { goScreen('scan'); }, 2000);
  }
}

function onDisconnected() {
  document.getElementById('reconnect-overlay').classList.add('visible');
  sendToApp('reconnect', {});
}

function onReconnected() {
  document.getElementById('reconnect-overlay').classList.remove('visible');
}

function doGiveUp() {
  document.getElementById('reconnect-overlay').classList.remove('visible');
  sendToApp('disconnect', {});
  ui.connected = false;
  ui.scanning = false;
  if (ui.token) showHome(); else goScreen('login');
}

function resumeRowing() {
  document.getElementById('loading-overlay').classList.add('visible');
  goScreen('rowing');
  initRowing();
  initFtmsTracking();
  if (inDebugMode) { DebugSim.reset(); DebugSim.start(); }
}

function disconnectRower() {
  if (inDebugMode) { DebugSim.stop(); inDebugMode = false; }
  else { sendToApp('disconnect', {}); }
  ui.connected = false;
  ui.scanning = false;
  if (ui.token) showHome(); else goScreen('login');
}

function debugMode() {
  ui.connected = true;
  inDebugMode = true;
  document.getElementById('loading-overlay').classList.add('visible');
  goScreen('rowing');
  initRowing();
  initFtmsTracking();
  DebugSim.reset();
  DebugSim.start();
}

// -- FTMS data -------------------------------------------------------
function onFtmsData(msg) {
  ingestData(msg.data);
  if (XESYNC_CONFIG.logRawData) sendRawData(msg.data);
}

function sendRawData(data) {
  var d = new Date();
  var p = function(n, w) { return String(n).padStart(w || 2, '0'); };
  var dateStr = p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' +
                p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' +
                p(d.getMilliseconds(), 3);
  fetch(XESYNC_CONFIG.apiBaseUrl + '/rpc/log_rawdata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: dateStr, data: data })
  }).catch(function() {});
}

window.addEventListener('hashchange', function() {
  if (window.location.hash.indexOf('#data=') === 0) ingestData(null);
});

// -- Upload / save ack -----------------------------------------------
function onSaveAck() { if (ui.token) showHome(); }

function onTagCleared(msg) { /* AI2 cleared the offline tag */ }

function onUploadWorkout(msg) {
  fetch(XESYNC_CONFIG.apiBaseUrl + '/rpc/save_workout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: msg.token, workout: msg.workout, data: msg.data })
  })
  .then(function(r) { return r.json(); })
  .then(function(arr) {
    var row = Array.isArray(arr) ? arr[0] : arr;
    if (row && row.status === 'success') sendToApp('uploadAck', { workout: msg.workout });
  })
  .catch(function() {});
}

// -- Post workout ----------------------------------------------------
// Hide the rowing animation immediately, before async save work runs.
window.onLeaveRowing = function() {
  document.getElementById('connecting-label').textContent = '';
  goScreen('connecting');
};

window.onWorkoutComplete = function(savedState) {
  ui.connected = false;
  ui.scanning = false;
  inDebugMode = false;
  var title = document.getElementById('pw-title');
  var sub   = document.getElementById('pw-subtitle');
  if (savedState === 'online') {
    title.textContent = 'WORKOUT SAVED';
    sub.textContent   = 'synced to your account';
  } else if (savedState === 'offline') {
    title.textContent = 'WORKOUT SAVED';
    sub.textContent   = 'stored offline, will sync on next login';
  } else {
    title.textContent = 'WORKOUT ENDED';
    sub.textContent   = 'not saved';
  }
  document.getElementById('pw-workouts-btn').style.display = ui.token ? '' : 'none';
  document.getElementById('post-workout').classList.add('visible');
};

function hidePostWorkout() {
  document.getElementById('post-workout').classList.remove('visible');
}

function postWorkoutGoWorkouts() {
  hidePostWorkout();
  if (ui.token) showHome(); else goScreen('login');
}

function postWorkoutGoLogin() {
  hidePostWorkout();
  goScreen('login');
}

// -- Utils -----------------------------------------------------------
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
