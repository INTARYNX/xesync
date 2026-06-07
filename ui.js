// =====================================================================
// UI router - single source of truth for everything on screen.
//
// All visual state lives in `ui`. To change anything, mutate `ui` then
// call render(). render() is the ONLY function that decides what screen,
// topbar, and overlay are visible. Nothing else toggles those elements.
// =====================================================================

var ui = {
  screen:    'login',   // login | register | home | scan | connecting | rowing
  overlay:   null,      // null | postWorkout | exitConfirm | registerSuccess | reconnect
  scanning:  false,     // BLE scan in progress
  connected: false,     // BLE rower connected
  token:     null,      // app auth token (null = logged out)
  offline:   false,     // no internet
  debug:     false      // debug menu enabled
};

// Logical screen name -> DOM id
var SCREEN_IDS = {
  login:      'screen-login',
  register:   'screen-register',
  home:       'screen-home',
  scan:       'screen-scan',
  connecting: 'screen-connecting',
  rowing:     'screen-rowing'
};

// Logical overlay name -> DOM id. Only one overlay shows at a time.
var OVERLAY_IDS = {
  postWorkout:     'post-workout',
  exitConfirm:     'exit-confirm',
  registerSuccess: 'register-success',
  reconnect:       'reconnect-overlay'
};

// Screens that hide the top bar
var FULLSCREEN = { rowing: true };

function render() {
  // 1. Active screen
  var activeId = SCREEN_IDS[ui.screen];
  Object.keys(SCREEN_IDS).forEach(function(name) {
    var el = document.getElementById(SCREEN_IDS[name]);
    if (el) el.classList.toggle('active', SCREEN_IDS[name] === activeId);
  });

  // 2. Overlays - show the one named in ui.overlay, hide the rest
  Object.keys(OVERLAY_IDS).forEach(function(name) {
    var el = document.getElementById(OVERLAY_IDS[name]);
    if (el) el.classList.toggle('visible', name === ui.overlay);
  });

  // 3. Top bar visibility
  var bar = document.getElementById('topbar');
  var showBar = !FULLSCREEN[ui.screen];
  bar.classList.toggle('visible', showBar);
  document.body.classList.toggle('with-bar', showBar);

  // 4. Top bar buttons
  if (showBar) {
    var onConnecting = ui.screen === 'connecting';
    setDisplay('tbar-scan-btn',       !onConnecting && !ui.connected && !ui.scanning);
    setDisplay('tbar-debug-btn',      ui.debug && !onConnecting);
    setDisplay('tbar-row-btn',        ui.connected);
    setDisplay('tbar-disconnect-btn', ui.connected);
  }

  // 5. Scan sub-views: idle (logo / offline prompt) vs active (scanning list)
  setDisplay('scan-idle',   !ui.scanning, 'flex');
  setDisplay('scan-active',  ui.scanning, 'flex');

  // 6. Offline prompts
  setDisplay('offline-notice',   ui.offline && ui.screen === 'login');
  setDisplay('scan-offline-msg', ui.offline);
}

// Show/hide an element. `displayValue` used when showing (default '').
function setDisplay(id, visible, displayValue) {
  var el = document.getElementById(id);
  if (!el) return;
  el.style.display = visible ? (displayValue || '') : 'none';
}

// Change screen. Always clears any open overlay so it cannot linger
// on top of the new screen.
function goScreen(name) {
  ui.overlay = null;
  ui.screen = name;
  render();
}

// Open / close an overlay without changing the screen behind it.
function openOverlay(name) {
  ui.overlay = name;
  render();
}

function closeOverlay() {
  ui.overlay = null;
  render();
}
