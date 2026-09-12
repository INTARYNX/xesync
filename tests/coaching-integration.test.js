// =====================================================================
// coaching-integration.test.js - the real wiring (ftms_integration.js's
// window.onFtms* hooks -> controller.js's implementations -> coaching.js
// -> splits.js), driven by a long, realistic simulated session rather
// than the short hand-picked tick sequences in coaching.test.js /
// splits.test.js. Those files prove each module's rules in isolation;
// this file's job is to catch what only shows up once a real, long
// FTMS packet stream flows through the actual save path - state left
// over between modules, a pause/resume that corrupts distance, a splits
// table that goes NaN once several jalons/défis pile up over 30+
// minutes, etc.
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeClock, makeDocument, buildFrame } = require('./harness');

// Loads the same script set app.html does (minus the WebGL-only
// rowing_display.js, which this test never touches) into one sandbox, so
// controller.js's window.onFtms*/onBeforeSave hooks are the real
// production code, not a re-implementation of it for the test.
function loadApp(opts) {
  opts = opts || {};
  const clock = makeClock(opts.startMs === undefined ? 1700000000000 : opts.startMs);
  const document = makeDocument();
  document.getElementById('home-frame').contentWindow = { postMessage() {} };

  const intervals = [];
  const timers = new Map();
  let nextTimer = 0;

  const localStorageData = new Map();
  const localStorage = {
    getItem: (k) => (localStorageData.has(k) ? localStorageData.get(k) : null),
    setItem: (k, v) => localStorageData.set(k, String(v)),
    removeItem: (k) => localStorageData.delete(k)
  };

  const window = { location: { search: opts.search || '', hash: '' }, addEventListener() {} };

  const sandbox = {
    window, document, localStorage,
    URLSearchParams, crypto, console,
    Date: clock.Date,
    navigator: { onLine: true },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    Bridge: { send: () => Promise.resolve(), setHandlers: () => {} },
    Api: {
      validateToken: async () => ({ status: 'error' }),
      saveWorkout: async () => ({ status: 'error' }) // forces the deterministic offline-save branch
    },
    Debug: { isOn: () => false, stopSim() {} },
    XESYNC_CONFIG: { apiBaseUrl: 'http://unused.invalid', apexHomeUrl: 'https://example.test/', appVersion: 'test', logRawData: false }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Same load order as app.html.
  const files = ['state.js', 'view.js', 'coaching_text.js', 'coaching.js', 'splits.js', 'coaching_view.js', 'ftms_integration.js', 'controller.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(src, sandbox, { filename: f });
  }

  return {
    window, document, clock, sandbox,
    tickWatchdog() { intervals.forEach((i) => i.fn()); }
  };
}

// A gently varying effort profile (never a hard step), close to a real
// steady-state row rather than the tidy constant-speed fixtures used
// elsewhere - the point is to let the real trend/spacing/median logic run
// against noise instead of numbers chosen to make it easy.
function makeProfile(baseSpm, baseWatts, speedMps) {
  let distance = 0, strokes = 0, cals = 0;
  return function step(elapsed) {
    const wobble = Math.sin(elapsed / 45) * 2;
    const spm = baseSpm + wobble;
    const watts = baseWatts + wobble * 8;
    distance += speedMps;
    strokes += (spm / 60);
    cals += watts / 1000;
    return buildFrame({
      spm, strokes: Math.round(strokes), distance: Math.round(distance),
      pace: Math.round(500 / speedMps), watts: Math.round(watts), cals: Math.round(cals),
      hr: 145, elapsed
    });
  };
}

test('a realistic 30-minute session (with a mid-session pause) produces a coherent payload', async () => {
  const app = loadApp();
  const w = app.window;

  let capturedPayload = null;
  const originalOnBeforeSave = w.onBeforeSave;
  w.onBeforeSave = function (payload) {
    originalOnBeforeSave(payload);
    capturedPayload = payload;
  };

  w.initFtmsTracking();
  const step = makeProfile(22, 150, 3.2); // ~3.2 m/s -> ~5.76km over 30 minutes

  // Phase 1: 10 minutes of steady rowing.
  for (let t = 1; t <= 600; t++) {
    w.ingestData(step(t));
    app.clock.advance(1000);
  }
  assert.equal(app.window.FtmsInternals.getPhase(), 'ACTIVE');

  // Phase 2: a real mid-session pause long enough to trip the inactivity
  // watchdog (INACTIVITY_MS=5000) - no packets arrive at all here, exactly
  // like the rower going quiet, not a synthetic onPause() call.
  app.clock.advance(6000);
  app.tickWatchdog();
  assert.equal(app.window.FtmsInternals.getPhase(), 'PAUSED');

  // Phase 3: resume and row for the remaining ~20 minutes.
  for (let t = 601; t <= 1800; t++) {
    w.ingestData(step(t));
    app.clock.advance(1000);
  }
  assert.equal(app.window.FtmsInternals.getPhase(), 'ACTIVE');

  const session = app.window.FtmsInternals.getSession();
  const eventsBeforeSave = app.window.Coaching.getSessionEvents();
  const milestonesBeforeSave = eventsBeforeSave.filter((e) => e.type === 'milestone').length;
  // ~5.7km at 1km per jalon: comfortably more than one, well short of
  // absurd - a real assertion, not just "didn't crash".
  assert.ok(milestonesBeforeSave >= 3, `expected several km milestones, got ${milestonesBeforeSave}`);

  const interrupted = eventsBeforeSave.filter((e) => e.type === 'challenge' && e.outcome === 'interrupted');
  // Not every run will have a challenge in flight exactly when the pause
  // hits, but if one WAS running, the pause must have closed it cleanly
  // (never left dangling) rather than losing it or double-counting it.
  assert.ok(interrupted.length <= 1);

  w.saveWorkout();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(capturedPayload, 'onBeforeSave should have fired during saveWorkout()');
  assert.ok(capturedPayload.splitsTable, 'splits table should be attached to the saved payload');
  assert.ok(capturedPayload.coachingSummary, 'coaching summary should be attached to the saved payload');

  const table = capturedPayload.splitsTable;
  // ~5.7km falls in the 1000m-split bucket (splits.js scales split size with
  // distance so a long row doesn't turn into 20+ rows of 500m).
  assert.ok(table.rows.length >= 5, `expected several 1000m splits, got ${table.rows.length}`);
  assert.notEqual(table.total.pace, '—');
  assert.notEqual(table.total.distance, '—');

  // Every cell across the whole table must be a finite, sane value - no
  // NaN/Infinity ever leaking out of the real pipeline over a long run.
  const allCells = table.rows.concat([table.total]);
  for (const row of allCells) {
    for (const key of ['duration', 'distance', 'pace', 'cadence', 'hr']) {
      const v = String(row[key]);
      assert.doesNotMatch(v, /NaN|Infinity|undefined/, `${key}=${v} in row ${JSON.stringify(row)}`);
    }
  }

  // Total distance in the table must match the session's real cumulative
  // counters (same source of truth, not two different calculations).
  const expectedDistance = Math.round(session.distOffset + session.rawDist);
  assert.equal(table.total.distance, expectedDistance + ' m');

  assert.ok(capturedPayload.coachingSummary.milestonesReached >= 3);
  // Over 30 minutes with two- and five-minute spacing rules, at least one
  // mini-challenge should have been proposed.
  assert.ok(capturedPayload.coachingSummary.challengesAttempted >= 1,
    'expected at least one mini-challenge to have been proposed over 30 minutes');
});

// ---------------------------------------------------------------------
// The sprint's "how does this compare to my best" comparison, through the
// real save path (controller.js's recordSprintResult/summarizeCoaching),
// not a re-implementation of that logic in the test.
// ---------------------------------------------------------------------
test('a completed sprint is reported against a pre-existing personal best', async () => {
  const app = loadApp();
  const w = app.window;

  // At a constant 3.2 m/s, the first distance challenge (DISTANCE_DURATIONS_S[0]
  // = 120s) targets round(120*3.2/50)*50 = 400m - deterministic since this
  // profile's distance increments are a plain constant, not the wobbled spm/watts.
  const EXPECTED_TARGET = 400;
  app.sandbox.localStorage.setItem('sprintBests_guest', JSON.stringify({ [EXPECTED_TARGET]: 999 }));

  let capturedPayload = null;
  const originalOnBeforeSave = w.onBeforeSave;
  w.onBeforeSave = function (payload) { originalOnBeforeSave(payload); capturedPayload = payload; };

  w.initFtmsTracking();
  const step = makeProfile(22, 150, 3.2);

  let sawGo = false, endEvt = null, sawCountdownInDom = false, sawProgressInDom = false, introBannerText = null;
  const challengeText = () => app.document.getElementById('coaching-challenge').textContent;
  let hadChallengeBefore = false;
  for (let t = 1; t <= 320 && !endEvt; t++) {
    w.ingestData(step(t));
    app.clock.advance(1000);
    const challenge = app.window.Coaching.getChallenge();
    if (challenge && !hadChallengeBefore) {
      // The intro banner is set synchronously inside this same ingestData()
      // call - capture it now, before any later tick overwrites it.
      introBannerText = app.document.getElementById('coaching-banner').textContent;
    }
    hadChallengeBefore = !!challenge;
    if (challenge && challenge.kind === 'distance' && challenge.phase === 'announce' && /\d+s/.test(challengeText())) {
      sawCountdownInDom = true;
    }
    if (challenge && challenge.kind === 'distance' && challenge.phase === 'active') {
      sawGo = true;
      if (challengeText().indexOf('/ ' + EXPECTED_TARGET + ' m') >= 0) sawProgressInDom = true;
    }
    const journal = app.window.Coaching.getSessionEvents();
    const found = journal.find((e) => e.type === 'challenge' && e.kind === 'distance' && e.outcome === 'success');
    if (found) endEvt = found;
  }
  assert.ok(sawGo, 'the sprint should have reached its active (post-countdown) phase');
  assert.ok(endEvt, 'the sprint should have completed within the simulated window');
  assert.equal(endEvt.target, EXPECTED_TARGET);
  // Real DOM content, not just internal state - catches a wrong field name
  // in coaching_view.js that the logic-only assertions above never would.
  assert.ok(sawCountdownInDom, 'the countdown pill should have shown a "Ns" countdown during announce');
  assert.ok(sawProgressInDom, 'the challenge pill should have shown "covered / 400 m" while active');
  assert.match(introBannerText, /Sprint 400 m as fast as you can/i);

  w.saveWorkout();
  await new Promise((resolve) => setImmediate(resolve));

  const highlight = capturedPayload.coachingSummary.challenges.find((c) => c.kind === 'distance');
  assert.ok(highlight, 'expected a distance-sprint entry in the recap');
  assert.equal(highlight.meters, EXPECTED_TARGET);
  assert.equal(highlight.prevBestS, 999);
  assert.ok(highlight.elapsedS < 999, 'a real 400m sprint at 3.2 m/s must beat the seeded 999s "best"');
  assert.match(highlight.detail, /new best/i);

  // The seeded best must have been overwritten with the faster real result.
  const bests = JSON.parse(app.sandbox.localStorage.getItem('sprintBests_guest'));
  assert.equal(bests[EXPECTED_TARGET], highlight.elapsedS);

  // The post-workout screen (real view.js render path) must actually show
  // the recap text, in its own section separate from the splits table -
  // challenge results and fixed-distance splits are deliberately independent.
  assert.match(app.document.getElementById('pw-coaching-summary').innerHTML, /new best/i);
  assert.doesNotMatch(app.document.getElementById('pw-splits-table').innerHTML, /Sprint|new best/i);
});
