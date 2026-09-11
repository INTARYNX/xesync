'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./harness');

const flush = () => new Promise(setImmediate);

// Run the actual controller and Capacitor bridge with only native plugins,
// network and browser surfaces replaced. Preferences survives simulated restarts.
async function boot({ storage = new Map(), save, validate, storageFails = false } = {}) {
  const timers = new Map();
  const uploads = [];
  let nextTimer = 0;
  const document = makeDocument();
  document.getElementById('home-frame').contentWindow = { postMessage() {} };
  const context = {
    window: { location: { search: '' }, addEventListener() {} },
    navigator: { onLine: true }, document, URLSearchParams, console,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    BleClient: { async initialize() {} },
    KeepAwake: { async keepAwake() {} },
    StatusBar: { async setBackgroundColor() {}, async setStyle() {} },
    Style: { Dark: 'dark' }, App: { addListener() {} },
    Preferences: {
      async get({ key }) { return { value: storage.get(key) || null }; },
      async set({ key, value }) {
        if (storageFails && key.startsWith('workout_')) throw new Error('storage full');
        storage.set(key, value);
      },
      async keys() { return { keys: [...storage.keys()] }; },
      async remove({ key }) { storage.delete(key); }
    },
    Api: {
      validateToken: validate || (async () => ({ status: 'success', username: 'alice' })),
      saveWorkout: save || (async (token, workout, data) => {
        uploads.push({ token, workout, data });
        return { status: 'success' };
      })
    },
    Debug: { stopSim() {} }, XESYNC_CONFIG: { apexHomeUrl: 'https://example.test/' }
  };
  vm.createContext(context);
  for (const file of ['state.js', 'view.js', 'capacitor/bridge.src.js', 'controller.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
      .replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(source, context, { filename: file });
  }
  await flush();
  return { context, storage, uploads, timers, document,
    async fireTimer(ms) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms === ms) { timers.delete(id); timer.fn(); }
      }
      await flush();
    }
  };
}

const payload = { version: 1, summary: { distance: 100 }, samples: [[1, 100]] };

for (const [label, save] of [
  ['network rejection', async () => { throw new Error('network down'); }],
  ['server rejection', async () => ({ status: 'error', error: 'invalid token' })]
]) {
  test(label + ' persists the same workout offline before reporting success', async () => {
    const h = await boot({ save });
    h.context.ui.token = 'valid-token';
    const result = await new Promise(done => h.context.window.onWorkoutSave('workout_test', payload, done));
    assert.equal(result, 'offline');
    assert.deepEqual(JSON.parse(h.storage.get('workout_test')), payload);
    assert.equal([...h.timers.values()].some(t => t.ms === 10000), false);
  });
}

test('timeout saves offline exactly once even if the server responds later', async () => {
  let resolveSave;
  const h = await boot({ save: () => new Promise(resolve => { resolveSave = resolve; }) });
  h.context.ui.token = 'valid-token';
  const results = [];
  h.context.window.onWorkoutSave('workout_test', payload, state => results.push(state));
  await h.fireTimer(10000);
  assert.deepEqual(results, ['offline']);
  assert.deepEqual(JSON.parse(h.storage.get('workout_test')), payload);
  resolveSave({ status: 'success' });
  await flush();
  assert.deepEqual(results, ['offline']);
});

test('successful online save does not queue a second copy', async () => {
  const h = await boot();
  h.context.ui.token = 'valid-token';
  const result = await new Promise(done => h.context.window.onWorkoutSave('workout_test', payload, done));
  assert.equal(result, 'online');
  assert.equal(h.storage.has('workout_test'), false);
  assert.equal(h.uploads.length, 1);
});

test('offline storage failure is not presented as a saved workout', async () => {
  const h = await boot({ storageFails: true });
  const result = await new Promise(done => h.context.window.onWorkoutSave('workout_test', payload, done));
  h.context.window.onWorkoutComplete(result);
  assert.equal(result, 'error');
  assert.equal(h.document._text('pw-title'), 'SAVE FAILED');
});

test('logoff clears persisted credentials and prevents automatic login after restart', async () => {
  const storage = new Map([['token', 'valid-token']]);
  const h = await boot({ storage });
  assert.equal(h.context.ui.token, 'valid-token');
  h.context.doLogoff();
  await flush();
  assert.equal(storage.get('token'), '');
  const restarted = await boot({ storage });
  assert.equal(restarted.context.ui.token, null);
  assert.equal(restarted.context.ui.screen, 'login');
});

test('automatic login uploads pending workouts and removes only acknowledged entries', async () => {
  const storage = new Map([['token', 'valid-token'], ['workout_pending', JSON.stringify(payload)]]);
  const h = await boot({ storage });
  assert.deepEqual(JSON.parse(JSON.stringify(h.uploads)), [{ token: 'valid-token', workout: 'workout_pending', data: payload }]);
  assert.equal(storage.has('workout_pending'), false);
});

test('failed queued uploads remain stored for the next login', async () => {
  const storage = new Map([['token', 'valid-token'], ['workout_pending', JSON.stringify(payload)]]);
  await boot({ storage, save: async () => { throw new Error('network down'); } });
  assert.equal(storage.get('workout_pending'), JSON.stringify(payload));
});

test('malformed queued JSON is retained without blocking other queued workouts', async () => {
  const storage = new Map([
    ['token', 'valid-token'], ['workout_bad', '{broken'],
    ['workout_pending', JSON.stringify(payload)]
  ]);
  const h = await boot({ storage });
  assert.equal(storage.get('workout_bad'), '{broken');
  assert.equal(storage.has('workout_pending'), false);
  assert.equal(h.uploads.length, 1);
});

test('network failure during automatic login preserves credentials and queued workouts', async () => {
  const storage = new Map([['token', 'valid-token'], ['workout_pending', JSON.stringify(payload)]]);
  const h = await boot({ storage, validate: async () => { throw new Error('network down'); } });
  assert.equal(storage.get('token'), 'valid-token');
  assert.equal(storage.has('workout_pending'), true);
  assert.equal(h.uploads.length, 0);
});
