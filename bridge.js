// =====================================================================
// bridge.js - talks to the native host. Sends messages out through a
// global the host provides, and dispatches incoming messages to
// controller handlers. Knows nothing about screens, network, or
// business rules.
// =====================================================================

var Bridge = (function () {
  'use strict';

  // Set by the controller: a map of action -> handler(msg)
  var handlers = {};

  function send(action, data) {
    var payload = JSON.stringify(Object.assign({ action: action }, data || {}));
    var ai = window.AppInventor || (typeof AppInventor !== 'undefined' ? AppInventor : null);
    if (ai && ai.setWebViewString) { ai.setWebViewString(payload); }
    else { console.log('[to app]', payload); }
  }

  function setHandlers(map) { handlers = map; }

  // An FTMS frame is exactly the shape ftms_integration.js's parsePacket()
  // accepts: at least 20 comma-separated integers. Validating the full
  // shape (rather than just "starts with a digit") avoids misrouting an
  // unrelated string into the FTMS parser below.
  var FTMS_MIN_BYTES = 20;
  function looksLikeFtmsFrame(s) {
    if (typeof s !== 'string') return false;
    var parts = s.trim().split(',');
    if (parts.length < FTMS_MIN_BYTES) return false;
    for (var i = 0; i < parts.length; i++) {
      if (!/^\s*\d{1,3}\s*$/.test(parts[i])) return false;
    }
    return true;
  }

  // Called by the native host (exposed as window.handleAppResponse below).
  //
  // The protocol is JSON: { action: "...", ... }. FTMS frames arrive as
  // { action: "ftmsData", data: "<csv>" } like every other message.
  function receive(json) {
    if (!json) return;

    var msg;
    try {
      msg = typeof json === 'string' ? JSON.parse(json) : json;
    } catch (e) {
      // Some client versions send the raw FTMS CSV as a bare string with
      // no JSON envelope. That form is still accepted here, but only when
      // it actually validates as a real frame - it's not the documented
      // protocol for anything new, and the current native shell never
      // sends frames this way.
      if (looksLikeFtmsFrame(json)) {
        dispatch({ action: 'ftmsData', data: json.trim(), legacy: true });
      } else {
        console.warn('[bridge] dropping unparseable message:', String(json).slice(0, 80));
      }
      return;
    }

    dispatch(msg);
  }

  function dispatch(msg) {
    if (!msg || !msg.action) { console.warn('[bridge] message with no action'); return; }
    var fn = handlers[msg.action];
    if (fn) fn(msg);
    else console.warn('Unknown action:', msg.action);
  }

  return { send: send, setHandlers: setHandlers, receive: receive };
})();

// Called by the native host
window.handleAppResponse = Bridge.receive;
