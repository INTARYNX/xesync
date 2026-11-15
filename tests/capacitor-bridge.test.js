// =====================================================================
// capacitor-bridge.test.js - capacitor/bridge.src.js's BLE frame
// handling in isolation (nothing else from the app loaded).
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'capacitor', 'bridge.src.js');
const flush = () => new Promise(setImmediate);

// Same wire encoding as tests/harness.js's buildFrame, trimmed to the
// fields this file's tests actually set.
function frameBytes(fields) {
  const b = new Array(20).fill(0);
  const put16 = (hi, lo, v) => { b[hi] = Math.floor(v / 255); b[lo] = v % 255; };
  if (fields.spm !== undefined) b[2] = Math.round(fields.spm / 0.5);
  if (fields.strokes !== undefined) put16(4, 3, fields.strokes);
  if (fields.distance !== undefined) put16(6, 5, fields.distance);
  b[16] = fields.hr === undefined ? 255 : fields.hr;
  return b;
}

// onFtmsFrame reads value.buffer/byteOffset/byteLength, same shape a real
// DataView notification has.
function toValue(bytes) {
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return { buffer: buf, byteOffset: 0, byteLength: bytes.length };
}

function loadBridge(bleClient) {
  const calls = { ftmsData: [], connectResult: [] };
  const context = {
    console,
    window: {},
    BleClient: Object.assign({
      async initialize() {},
      async requestLEScan() {},
      async stopLEScan() {},
      async connect() {},
      async startNotifications() {},
      async disconnect() {}
    }, bleClient),
    Preferences: {
      async get() { return { value: null }; },
      async set() {},
      async keys() { return { keys: [] }; },
      async remove() {}
    },
    App: { exitApp() {}, addListener() {} },
    StatusBar: { async setBackgroundColor() {}, async setStyle() {} },
    Style: { Dark: 'dark' },
    KeepAwake: { async keepAwake() {} }
  };
  vm.createContext(context);
  const source = fs.readFileSync(SRC, 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context, { filename: SRC });
  context.Bridge.setHandlers({
    autoLogin() {}, scanResult() {}, disconnected() {},
    connectResult: (m) => calls.connectResult.push(m),
    ftmsData:      (m) => calls.ftmsData.push(m)
  });
  return { context, calls };
}

test('the stale reading a rower pushes right after subscribing is not forwarded', async () => {
  let notifyCb = null;
  const { context, calls } = loadBridge({
    async startNotifications(deviceId, service, char, cb) { notifyCb = cb; }
  });
  await context.Bridge.send('connect', { deviceId: 'AA:BB:CC:DD:EE:FF' });
  // JSON round-trip: these objects are built inside the vm context's own
  // realm, so deepStrictEqual's prototype check against a plain literal
  // here would fail despite matching structure.
  assert.deepEqual(JSON.parse(JSON.stringify(calls.connectResult)), [{ action: 'connectResult', success: true }]);

  notifyCb(toValue(frameBytes({ spm: 20, distance: 500, strokes: 50 })));
  assert.equal(calls.ftmsData.length, 0);

  // Genuinely new data (the user actually rows) must still get through.
  notifyCb(toValue(frameBytes({ spm: 22, distance: 503, strokes: 51 })));
  assert.equal(calls.ftmsData.length, 1);
});

test('a replayed stale frame right after connecting is not forwarded either (the bug)', async () => {
  let notifyCb = null;
  const { context, calls } = loadBridge({
    async startNotifications(deviceId, service, char, cb) { notifyCb = cb; }
  });
  await context.Bridge.send('connect', { deviceId: 'AA:BB:CC:DD:EE:FF' });

  var stale = toValue(frameBytes({ spm: 20, distance: 500, strokes: 50 }));
  notifyCb(stale); // 1st push: the documented "last held reading" - skipped
  notifyCb(stale); // 2nd push: the rower replays the same reading - the bug
  assert.equal(calls.ftmsData.length, 0, 'neither stale push should reach the app');

  notifyCb(toValue(frameBytes({ spm: 22, distance: 503, strokes: 51 })));
  assert.equal(calls.ftmsData.length, 1, 'a real change still gets through afterwards');
});

test('the same skip-then-replay protection applies on a reconnect, not just the first connect', async () => {
  let notifyCb = null;
  const { context, calls } = loadBridge({
    async startNotifications(deviceId, service, char, cb) { notifyCb = cb; }
  });
  await context.Bridge.send('connect', { deviceId: 'AA:BB:CC:DD:EE:FF' });
  notifyCb(toValue(frameBytes({ spm: 18, distance: 100, strokes: 10 })));
  calls.ftmsData.length = 0; // discard the first session's own frames

  await context.Bridge.send('reconnect'); // connect(connectedId) - no deviceId arg needed

  var stale = toValue(frameBytes({ spm: 20, distance: 500, strokes: 50 }));
  notifyCb(stale);
  notifyCb(stale);
  assert.equal(calls.ftmsData.length, 0);
});

test('non-stale frames that are genuinely identical back-to-back are still deduped', async () => {
  let notifyCb = null;
  const { context, calls } = loadBridge({
    async startNotifications(deviceId, service, char, cb) { notifyCb = cb; }
  });
  await context.Bridge.send('connect', { deviceId: 'AA:BB:CC:DD:EE:FF' });
  notifyCb(toValue(frameBytes({ spm: 99, distance: 999, strokes: 99 }))); // mandatory post-connect skip

  notifyCb(toValue(frameBytes({ spm: 24, distance: 10, strokes: 1 })));
  assert.equal(calls.ftmsData.length, 1);
  notifyCb(toValue(frameBytes({ spm: 24, distance: 10, strokes: 1 }))); // identical repeat
  assert.equal(calls.ftmsData.length, 1, 'the real duplicate-suppression behaviour is unaffected');

  notifyCb(toValue(frameBytes({ spm: 26, distance: 12, strokes: 2 })));
  assert.equal(calls.ftmsData.length, 2);
});
