// =====================================================================
// view.js - all DOM rendering. Reads `ui`, writes the DOM. Nothing here
// makes decisions, calls the network, or talks to App Inventor.
// render() is the single function that syncs the whole UI to `ui`.
// =====================================================================

function render() {
  // Active screen
  var activeId = SCREEN_IDS[ui.screen];
  Object.keys(SCREEN_IDS).forEach(function(name) {
    var el = document.getElementById(SCREEN_IDS[name]);
    if (el) el.classList.toggle('active', SCREEN_IDS[name] === activeId);
  });

  // Overlay (only the one named in ui.overlay)
  Object.keys(OVERLAY_IDS).forEach(function(name) {
    var el = document.getElementById(OVERLAY_IDS[name]);
    if (el) el.classList.toggle('visible', name === ui.overlay);
  });

  // Top bar visibility
  var bar = document.getElementById('topbar');
  var showBar = !FULLSCREEN[ui.screen];
  if (bar) bar.classList.toggle('visible', showBar);
  document.body.classList.toggle('with-bar', showBar);

  // Top bar buttons
  if (showBar) {
    var onConnecting = ui.screen === 'connecting';
    setDisplay('tbar-scan-btn',       !onConnecting && !ui.connected && !ui.scanning);
    setDisplay('tbar-debug-btn',      ui.debug && !onConnecting);
    setDisplay('tbar-row-btn',        ui.connected);
    setDisplay('tbar-disconnect-btn', ui.connected);
  }

  // Scan sub-views
  setDisplay('scan-idle',   !ui.scanning, 'flex');
  setDisplay('scan-active',  ui.scanning, 'flex');

  // Offline prompts
  setDisplay('offline-notice',   ui.offline && ui.screen === 'login');
  setDisplay('scan-offline-msg', ui.offline);
}

function setDisplay(id, visible, displayValue) {
  var el = document.getElementById(id);
  if (!el) return;
  el.style.display = visible ? (displayValue || '') : 'none';
}

// -- State transitions (mutate ui, then render) ----------------------
function goScreen(name) {
  ui.overlay = null;
  ui.screen = name;
  render();
}

function openOverlay(name) {
  ui.overlay = name;
  render();
}

function closeOverlay() {
  ui.overlay = null;
  render();
}

// -- Small view helpers ----------------------------------------------
function setUserBadge(username) {
  var el = document.getElementById('tbar-user');
  if (!el) return;
  el.innerHTML = username
    ? '<div class="tbar-avatar">' + username.slice(0, 2).toUpperCase() + '</div>'
    : '';
}

function setLoginStatus(msg) {
  var el = document.getElementById('login-status');
  if (el) el.textContent = msg;
}

function setRegisterStatus(msg, ok) {
  var el = document.getElementById('register-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? '#00A2E8' : '#f44336';
}

function setConnectingLabel(text) {
  var el = document.getElementById('connecting-label');
  if (el) el.textContent = text;
}

function showLoadingOverlay() {
  var el = document.getElementById('loading-overlay');
  if (el) el.classList.add('visible');
}

function hideLoadingOverlay() {
  var el = document.getElementById('loading-overlay');
  if (el) el.classList.remove('visible');
}

// Render the scanning sub-view in its "searching" state
function renderScanSearching() {
  document.getElementById('device-list').innerHTML = '';
  document.getElementById('pulse-ring').style.display = '';
  document.getElementById('scan-label').textContent = 'SCANNING...';
}

// Render the list of found devices; onPick(device) is called on tap
function renderDeviceList(devices, onPick) {
  document.getElementById('pulse-ring').style.display = 'none';
  document.getElementById('scan-label').textContent = 'SELECT ROWER';
  var list = document.getElementById('device-list');
  list.innerHTML = '';
  if (!devices.length) {
    list.innerHTML = '<div class="empty-msg">No rower found</div>';
    return;
  }
  devices.forEach(function(d) {
    var item = document.createElement('div');
    item.className = 'device-item';
    item.innerHTML = '<span>' + escHtml(d.name) + '</span>' +
                     '<span class="device-rssi">' + escHtml(d.id) + '</span>';
    item.onclick = function() { onPick(d); };
    list.appendChild(item);
  });
}

// Fill the post-workout overlay text + workouts button visibility
function renderPostWorkout(savedState, hasToken) {
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
  document.getElementById('pw-workouts-btn').style.display = hasToken ? '' : 'none';
}

function hideBootSplash() {
  var s = document.getElementById('boot-splash');
  if (!s) return;
  s.classList.add('hidden');
  setTimeout(function() { if (s.parentNode) s.parentNode.removeChild(s); }, 300);
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
