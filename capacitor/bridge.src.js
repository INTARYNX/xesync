// =====================================================================
// bridge.src.js - Capacitor replacement for the App Inventor bridge.
//
// Same public API as the old bridge.js (Bridge.send / Bridge.setHandlers
// / Bridge.receive, window.handleAppResponse), so controller.js and
// ftms_integration.js need ZERO changes. Everything AI2's blocks used to
// do natively (BLE scan/connect, TinyDB, exit, keep-screen-on, status
// bar) now happens here instead of round-tripping through a WebView
// bridge.
//
// Bundled with esbuild into www/bridge.js (see package.json). Every
// other module (state.js, view.js, api.js, controller.js,
// ftms_integration.js, debug*.js) is copied through unchanged.
// =====================================================================

import { BleClient } from '@capacitor-community/bluetooth-le';
import { Preferences } from '@capacitor/preferences';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Filesystem, Directory } from '@capacitor/filesystem';

var FTMS_SERVICE = '00001826-0000-1000-8000-00805f9b34fb';
var FTMS_CHAR    = '00002ad1-0000-1000-8000-00805f9b34fb';
var WORKOUT_PREFIX = 'workout_';
var LOG_FILE = 'xesync-debug.log';

// TEMPORARY debug logging, unconditional (not gated behind ?debug=true
// like ftms_integration.js's own dbg()) - added specifically to get BLE
// lifecycle visibility on-device while chasing hardware bugs no amount of
// code reading would surface. Two outputs:
//  - on-screen panel (quick glance on the phone itself)
//  - a plain-text file (Directory.Data / xesync-debug.log), pulled with
//    `adb shell run-as com.enlistia.xesync cat files/xesync-debug.log`
//    (debuggable builds allow run-as without root) - no more needing a
//    screenshot or the user relaying numbers over chat.
// Remove (or gate behind DEBUG) once BLE is confirmed reliably working.
var dbgEl = null;
var logBuffer = [];
var logFlushScheduled = false;

function dbg(msg) {
  var t = new Date();
  var ts = (t.getHours()<10?'0':'')+t.getHours()+':'+(t.getMinutes()<10?'0':'')+t.getMinutes()+':'+(t.getSeconds()<10?'0':'')+t.getSeconds();
  var full = '[' + ts + '] ' + msg;

  if (!dbgEl) {
    dbgEl = document.createElement('div');
    dbgEl.style.cssText = 'position:fixed;top:0;left:0;right:0;max-height:35vh;overflow-y:auto;' +
      'background:rgba(0,0,0,0.85);color:#0f0;font-size:11px;font-family:monospace;' +
      'padding:4px 6px;z-index:99999;pointer-events:none;white-space:pre-wrap;';
    document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(dbgEl); });
    if (document.body) document.body.appendChild(dbgEl);
  }
  var line = document.createElement('div');
  line.textContent = full;
  dbgEl.appendChild(line);
  dbgEl.scrollTop = dbgEl.scrollHeight;
  while (dbgEl.children.length > 40) dbgEl.removeChild(dbgEl.firstChild);

  logBuffer.push(full);
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    setTimeout(flushLog, 500); // batch writes instead of one file op per line
  }
}

function flushLog() {
  logFlushScheduled = false;
  var chunk = logBuffer.join('\n') + '\n';
  logBuffer = [];
  Filesystem.appendFile({ path: LOG_FILE, directory: Directory.Data, data: chunk, encoding: 'utf8' })
    .catch(function () {
      // File doesn't exist yet on first write - create it instead.
      Filesystem.writeFile({ path: LOG_FILE, directory: Directory.Data, data: chunk, encoding: 'utf8' })
        .catch(function (e) { console.error('[bridge] log write failed', e); });
    });
}

var Bridge = (function () {
  'use strict';

  var handlers = {};
  var bleReady = false;
  var connectedId = null;      // currently connected device id (MAC on Android)
  var connecting = false;      // guards against overlapping connect() calls
  var skipNextFrame = false;   // true right after (re)connecting
  var intentionalDisconnect = false;
  var previousData = null;     // last FTMS csv sent, for de-dup (never reset, same as AI2)
  var foundDevices = {};       // id -> name, accumulated during a scan

  function setHandlers(map) { handlers = map; }

  function fire(action, data) {
    var fn = handlers[action];
    if (fn) fn(Object.assign({ action: action }, data || {}));
    else console.warn('[bridge] no handler for', action);
  }

  // -- boot: ask BLE permission once, restore token, kick off autoLogin --
  async function init() {
    dbg('init() start');
    try {
      await BleClient.initialize({ androidNeverForLocation: true });
      bleReady = true;
      dbg('BLE init OK');
    } catch (e) {
      dbg('BLE init FAILED: ' + (e && e.message || e));
      console.error('[bridge] BLE init failed', e);
    }
    try { await KeepAwake.keepAwake(); } catch (e) { /* not fatal */ }
    try {
      await StatusBar.setBackgroundColor({ color: '#000000' });
      await StatusBar.setStyle({ style: Style.Dark });
    } catch (e) { /* no-op on platforms without a status bar */ }

    App.addListener('backButton', function () {
      // AI2 had a hardware-back = app default; keep parity by doing nothing
      // special here. Revisit if a screen needs custom back handling.
    });

    var stored = await Preferences.get({ key: 'token' });
    fire('autoLogin', { token: stored.value || '' });
  }

  // -- outgoing (was: AppInventor.setWebViewString) --------------------
  async function send(action, data) {
    data = data || {};
    switch (action) {
      case 'loginResult': return onLoginResult(data);
      case 'scan': return startScan();
      case 'stopScan': return stopScan();
      case 'connect': return connect(data.deviceId);
      case 'reconnect': return connect(connectedId);
      case 'disconnect': return disconnect();
      case 'saveData': return saveData(data);
      case 'uploadAck': return uploadAck(data);
      case 'exit': return App.exitApp();
      default:
        console.warn('[bridge] unhandled outgoing action', action, data);
    }
  }

  // -- login / offline upload queue -------------------------------------
  // FIXED vs. the original AI2 blocks: those only checked the "success"
  // key on loginResult and cleared the stored token on ANY non-success
  // reply, including goOffline()'s success:false/offline:true - a pure
  // connectivity failure, not a rejected credential/token. That wiped an
  // otherwise-valid token on a network blip, forcing a manual re-login
  // once back online. Here, only a real rejection (success:false without
  // offline:true) clears the token; an offline failure leaves it alone
  // so autologin can just retry next time there's connectivity.
  async function onLoginResult(data) {
    if (data.success) {
      await Preferences.set({ key: 'token', value: data.token || '' });
      await reuploadStoredWorkouts(data.token);
    } else if (!data.offline) {
      await Preferences.set({ key: 'token', value: '' });
    }
  }

  async function reuploadStoredWorkouts(token) {
    var keys = (await Preferences.keys()).keys || [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf(WORKOUT_PREFIX) !== 0) continue;
      var stored = await Preferences.get({ key: k });
      if (!stored.value) continue;
      fire('uploadWorkout', { token: token, workout: k, data: stored.value });
    }
  }

  async function saveData(data) {
    // Deliberate fix, not a guess: the real AI2 block for this action has
    // a `join` with a DANGLING SECOND SOCKET on the TinyDB tag - it builds
    // literally the fixed string "workout_" (never suffixed with an id),
    // confirmed by zooming into blocks/blocks(14).png. Every offline save
    // overwrites the same TinyDB tag, so only the most recent offline
    // workout survives - earlier ones are silently lost. Using the actual
    // unique tag the web app already generates (`msg.workout`, e.g.
    // "workout_20260808153000" from ftms_integration.js's workoutTag())
    // instead of reproducing that bug.
    await Preferences.set({
      key: data.workout,
      value: typeof data.data === 'string' ? data.data : JSON.stringify(data.data)
    });
    fire('saveAck', {});
  }

  async function uploadAck(data) {
    await Preferences.remove({ key: data.workout });
    fire('tagCleared', { workout: data.workout });
  }

  // -- scan ---------------------------------------------------------------
  // No `services: [FTMS_SERVICE]` filter here, on purpose: that's what this
  // originally did, but a service-UUID scan filter only matches devices
  // that advertise their full service list in the ~31-byte ADV packet
  // itself. Plenty of BLE peripherals (unknown, untested so far, whether
  // the Xebex rower is one of them) only expose services after a GATT
  // connection, which is exactly why the real AI2 blocks scanned with NO
  // filter and matched by device NAME instead, only checking for the FTMS
  // characteristic after connecting (see CheckDevice / BluetoothScan.Connected
  // in blocks.md). Matching that proven approach instead of the filtered
  // one until confirmed safe to filter.
  async function startScan() {
    dbg('startScan() bleReady=' + bleReady);
    if (!bleReady) { fire('scanResult', { devices: [] }); return; }
    foundDevices = {};
    try {
      await BleClient.requestLEScan(
        {},
        function (result) {
          var name = result.device.name || result.localName || '';
          dbg('seen: "' + name + '" ' + result.device.deviceId + ' rssi=' + result.rssi);
          if (name.indexOf('XEBEX') === -1) return; // same name filter AI2 used
          if (foundDevices[result.device.deviceId]) return;
          foundDevices[result.device.deviceId] = name;
          dbg('MATCH: ' + name);
          emitScanResult();
        }
      );
      dbg('requestLEScan() call returned OK, listening...');
    } catch (e) {
      dbg('requestLEScan FAILED: ' + (e && e.message || e));
      console.error('[bridge] scan failed', e);
      fire('scanResult', { devices: [] });
    }
  }

  function emitScanResult() {
    var devices = Object.keys(foundDevices).map(function (id) {
      return { id: id + ' ' + foundDevices[id] }; // controller.js splits "id name" on whitespace
    });
    fire('scanResult', { devices: devices });
  }

  async function stopScan() {
    try { await BleClient.stopLEScan(); } catch (e) { /* already stopped */ }
  }

  // -- connect / disconnect ------------------------------------------------
  // FIXED: controller.js's reconnect loop fires Bridge.send('reconnect')
  // every RECONNECT_DELAY (5000ms) without waiting for the previous attempt
  // to settle, but BleClient.connect()'s own default timeout is 10000ms -
  // so a dropped connection was stacking 2-3 concurrent connect() calls to
  // the same deviceId, which the Android GATT stack doesn't handle well
  // (confirmed on-device: 3 attempts logged 5s apart, all failing with
  // "Connection timeout"). `connecting` is the actual fix for that - it
  // guards against starting a second attempt while one's still in flight,
  // so the timeout value itself no longer needs to stay under the 5s retry
  // cadence.
  //
  // Tried copying AI2's own BluetoothStream.ConnectionTimeout (1000ms,
  // from Screen1.scm) on the theory that it was a proven production value -
  // wrong call: AI2's native extension talked to the GATT stack directly,
  // while Capacitor's plugin adds a JS<->native bridge hop, and on-device
  // logs showed a real successful connect taking ~3s here. 1000ms failed
  // every single attempt. 8000ms below is comfortably above that observed
  // ~3s, with margin - not copied from anywhere, just measured.
  async function connect(deviceId) {
    dbg('connect(' + deviceId + ') connecting=' + connecting);
    if (!deviceId) { fire('connectResult', { success: false, error: 'no device' }); return; }
    if (connecting) { dbg('connect() already in flight, ignoring overlapping call'); return; }
    connecting = true;
    try {
      await stopScan();
      await BleClient.connect(deviceId, onUnexpectedDisconnect, { timeout: 8000 });
      connectedId = deviceId;
      skipNextFrame = true; // see onFtmsFrame: the rower's first push is a stale cached reading, not live data
      dbg('GATT connected, starting notifications...');
      await BleClient.startNotifications(deviceId, FTMS_SERVICE, FTMS_CHAR, onFtmsFrame);
      dbg('notifications started OK');
      fire('connectResult', { success: true });
    } catch (e) {
      dbg('connect FAILED: ' + (e && e.message || e));
      fire('connectResult', { success: false, error: String(e && e.message || e) });
    } finally {
      connecting = false;
    }
  }

  function onUnexpectedDisconnect() {
    if (intentionalDisconnect) { intentionalDisconnect = false; return; }
    fire('disconnected', {});
  }

  async function disconnect() {
    if (!connectedId) return;
    intentionalDisconnect = true;
    try { await BleClient.disconnect(connectedId); } catch (e) { /* already gone */ }
    connectedId = null;
  }

  // -- FTMS frames ----------------------------------------------------------
  // FIXED: no more AI2-style segment(start=2, length=len-2) trim. Confirmed
  // on-device (screenshot of the debug panel) the raw GATT notification is
  // exactly 20 bytes - already exactly what ftms_integration.js's
  // parsePacket() needs (it indexes up to b[19], requires b.length>=20).
  // Trimming 2 more bytes left 18, one under the minimum, so parsePacket()
  // silently rejected every single frame - that's why the rowing screen
  // never left "READY TO ROW" despite frames visibly arriving. AI2's trim
  // was compensating for 2 extra framing bytes that extension's own BLE API
  // added on top of the real GATT value; Capacitor's DataView here already
  // *is* the clean GATT characteristic value, nothing extra to strip.
  // (Sanity check: byte[16] in the untrimmed frame lands exactly on the
  // heart-rate field, reading 255 - parsePacket's own "no HR sensor"
  // sentinel - so this alignment is confirmed correct, not a guess.)
  function onFtmsFrame(value) {
    // value is a DataView backed by a shared/pooled ArrayBuffer - must
    // respect byteOffset/byteLength, not just value.buffer, or this can
    // read bytes belonging to a different notification.
    var bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    var csv = Array.prototype.join.call(bytes, ',');
    dbg('FTMS frame: ' + bytes.length + ' bytes [' + csv + ']' + (skipNextFrame ? ' (SKIPPED: stale initial read)' : ''));

    // FIXED: confirmed on-device via the persistent log - right after
    // subscribing, the rower immediately pushes ONE notification carrying
    // its last-held reading from whenever someone last rowed (e.g. spm=31,
    // frozen, unchanged for 5+ minutes and across a full disconnect/
    // reconnect). ftms_integration.js treats any spm>0 packet as "rowing
    // started", so that stale first push was kicking off a phantom active
    // session immediately on connect, before the user touched the rower.
    // Dropping just that first push (a well-known BLE pattern: peripherals
    // often reply with a cached value the instant you subscribe) fixes it
    // without touching the shared parsing code.
    if (skipNextFrame) { skipNextFrame = false; return; }

    if (csv === previousData) return; // same de-dup AI2 does, same caveat: never reset
    previousData = csv;
    fire('ftmsData', { data: csv });
  }

  // -- incoming (unused with Capacitor - kept for API parity / debug) ------
  function receive(json) {
    if (!json) return;
    var msg;
    try { msg = typeof json === 'string' ? JSON.parse(json) : json; }
    catch (e) {
      if (typeof json === 'string' && /^\s*\d/.test(json) && handlers.rawFtms) {
        handlers.rawFtms(json.trim());
      }
      return;
    }
    var fn = handlers[msg.action];
    if (fn) fn(msg); else console.warn('Unknown action:', msg.action);
  }

  init();

  return { send: send, setHandlers: setHandlers, receive: receive };
})();

window.Bridge = Bridge;
window.handleAppResponse = Bridge.receive; // no-op path, nothing calls it anymore
