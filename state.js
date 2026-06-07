// =====================================================================
// state.js - application state. No logic, no DOM. Just data + maps.
// =====================================================================

var ui = {
  screen:    'login',   // login | register | home | scan | connecting | rowing
  overlay:   null,      // null | postWorkout | exitConfirm | registerSuccess | reconnect
  scanning:  false,     // BLE scan in progress
  connected: false,     // BLE rower connected
  token:     null,      // app auth token (null = logged out)
  username:  null,      // logged-in username
  offline:   false,     // no internet
  debug:     false      // debug build (?debug=true)
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

// Logical overlay name -> DOM id (only one shown at a time)
var OVERLAY_IDS = {
  postWorkout:     'post-workout',
  exitConfirm:     'exit-confirm',
  registerSuccess: 'register-success',
  reconnect:       'reconnect-overlay'
};

// Screens that hide the top bar
var FULLSCREEN = { rowing: true };
