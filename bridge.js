// =====================================================================
// bridge.js - App Inventor communication. Sends messages out via
// setWebViewString, and dispatches incoming messages to controller
// handlers. Knows nothing about screens, network, or business rules.
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

  // Called by App Inventor (exposed as window.handleAppResponse below)
  function receive(json) {
    if (!json) return;
    var msg;
    try { msg = typeof json === 'string' ? JSON.parse(json) : json; }
    catch (e) {
      // Raw FTMS CSV string (starts with a digit) - route to ftms handler
      if (typeof json === 'string' && /^\s*\d/.test(json) && handlers.rawFtms) {
        handlers.rawFtms(json.trim());
      }
      return;
    }
    var fn = handlers[msg.action];
    if (fn) fn(msg);
    else console.warn('Unknown action:', msg.action);
  }

  return { send: send, setHandlers: setHandlers, receive: receive };
})();

// App Inventor calls this global
window.handleAppResponse = Bridge.receive;
