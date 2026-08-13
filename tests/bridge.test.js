// =====================================================================
// bridge.test.js - App Inventor message dispatch.
//
//   node --test "tests/*.test.js"
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'bridge.js');

function loadBridge() {
  const sent = [];
  const warnings = [];
  const window = {};
  const sandbox = {
    window,
    console: {
      log: () => {},
      warn: (...a) => warnings.push(a.join(' ')),
      error: () => {}
    },
    AppInventor: { setWebViewString: (s) => sent.push(s) }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });
  return { bridge: sandbox.Bridge, window, sent, warnings };
}

const FRAME = '0,0,52,100,1,200,2,0,125,0,150,0,45,0,0,0,142,0,90,0';

test('explicit ftmsData messages reach the handler', () => {
  const h = loadBridge();
  const got = [];
  h.bridge.setHandlers({ ftmsData: (m) => got.push(m.data) });

  h.bridge.receive(JSON.stringify({ action: 'ftmsData', data: FRAME }));
  assert.deepStrictEqual(got, [FRAME]);
});

test('legacy bare-csv frames are routed to the same ftmsData handler', () => {
  // Field AI2 builds push the raw frame with no envelope and cannot be
  // updated retroactively, so this path stays - but it now arrives as a
  // normal ftmsData message rather than a separate rawFtms channel.
  const h = loadBridge();
  const got = [];
  h.bridge.setHandlers({ ftmsData: (m) => got.push(m) });

  h.bridge.receive(FRAME);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].data, FRAME);
  assert.strictEqual(got[0].legacy, true, 'legacy frames should be marked as such');
});

test('non-frame junk starting with a digit is dropped, not parsed as FTMS', () => {
  // The old test was /^\s*\d/, so any non-JSON string beginning with a digit
  // was handed to the FTMS parser. These all begin with a digit and none of
  // them are frames.
  const h = loadBridge();
  let called = 0;
  h.bridge.setHandlers({ ftmsData: () => called++ });

  ['404 Not Found', '500 Internal Server Error', '1,2,3', '2026-08-13 boot ok']
    .forEach((s) => h.bridge.receive(s));

  assert.strictEqual(called, 0);
  assert.strictEqual(h.warnings.length, 4, 'each drop should be reported');
});

test('a frame with out-of-range byte values is not treated as a frame', () => {
  const h = loadBridge();
  let called = 0;
  h.bridge.setHandlers({ ftmsData: () => called++ });

  // 4-digit "bytes" - not a valid FTMS value.
  h.bridge.receive(new Array(20).fill('1000').join(','));
  assert.strictEqual(called, 0);
});

test('messages with no action are reported rather than silently ignored', () => {
  const h = loadBridge();
  h.bridge.setHandlers({});
  h.bridge.receive(JSON.stringify({ data: 'x' }));
  assert.ok(h.warnings.some((w) => w.includes('no action')), h.warnings.join('|'));
});

test('unknown actions warn', () => {
  const h = loadBridge();
  h.bridge.setHandlers({});
  h.bridge.receive(JSON.stringify({ action: 'nonesuch' }));
  assert.ok(h.warnings.some((w) => w.includes('nonesuch')), h.warnings.join('|'));
});

test('send wraps the payload with its action', () => {
  const h = loadBridge();
  h.bridge.send('connect', { deviceId: 'AA:BB' });
  assert.deepStrictEqual(JSON.parse(h.sent[0]), { action: 'connect', deviceId: 'AA:BB' });
});

test('empty input is ignored', () => {
  const h = loadBridge();
  let called = 0;
  h.bridge.setHandlers({ ftmsData: () => called++ });
  h.bridge.receive('');
  h.bridge.receive(null);
  h.bridge.receive(undefined);
  assert.strictEqual(called, 0);
  assert.strictEqual(h.warnings.length, 0);
});
