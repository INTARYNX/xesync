// =====================================================================
// UI router - single source of truth for what is on screen.
//
// All visual state lives in `ui`. To change the screen or any control,
// mutate `ui` then call render(). render() is the ONLY function that
// touches screen visibility, the topbar, and the scan sub-views.
// Nothing else manipulates style.display for those elements.
// =====================================================================

var ui = {
  screen:    'login',   // login | register | home | scan | connecting | rowing
  scanning:  false,     // BLE scan in progress
  connected: false,     // BLE rower connected
  token:     null,      // app auth token (null = logged out)
  offline:   false,     // no internet
  debug:     false      // debug menu enabled
};

// Map logical screen name -> DOM element id
var SCREEN_IDS = {
  login:      'screen-login',
  register:   'screen-register',
  home:       'screen-home',
  scan:       'screen-scan',
  connecting: 'screen-connecting',
  rowing:     'screen-rowing'
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

  // 2. Top bar visibility
  var bar = document.getElementById('topbar');
  var showBar = !FULLSCREEN[ui.screen];
  bar.classList.toggle('visible', showBar);
  document.body.classList.toggle('with-bar', showBar);

  // 3. Top bar buttons (only meaningful when bar is shown)
  if (showBar) {
    var onConnecting = ui.screen === 'connecting';
    setDisplay('tbar-scan-btn',       !onConnecting && !ui.connected && !ui.scanning);
    setDisplay('tbar-debug-btn',      ui.debug && !onConnecting);
    setDisplay('tbar-row-btn',        ui.connected);
    setDisplay('tbar-disconnect-btn', ui.connected);
  }

  // 4. Scan sub-views: idle (logo / offline prompt) vs active (scanning list)
  setDisplay('scan-idle',   !ui.scanning, 'flex');
  setDisplay('scan-active',  ui.scanning, 'flex');

  // 5. Offline prompts
  setDisplay('offline-notice',   ui.offline && ui.screen === 'login');
  setDisplay('scan-offline-msg', ui.offline);
}

// Helper: show/hide an element. `displayValue` is used when showing
// (default ''), elements fall back to their stylesheet display.
function setDisplay(id, visible, displayValue) {
  var el = document.getElementById(id);
  if (!el) return;
  el.style.display = visible ? (displayValue || '') : 'none';
}

// Convenience: change screen and re-render in one call.
// Closing transient overlays here guarantees they never linger on top
// of a new screen (this was the cause of the "scan does nothing" bug:
// the post-workout overlay stayed on top of the scan screen).
function goScreen(name) {
  closeOverlays();
  ui.screen = name;
  render();
}

function closeOverlays() {
  ['post-workout', 'exit-confirm', 'register-success', 'reconnect-overlay'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('visible');
  });
}
