// =====================================================================
// rowing_sync.test.js - the rower animation's stroke clock.
//
// The rower reports ~1 packet/s, and only says "a stroke happened" (its
// counter ticks), so rowing_display.js locks the animated stroke cycle onto
// those ticks instead of free-running it from spm. These tests drive the
// tracker with a simulated rower and check that the finish pose lands on
// the real finish, that the drawn phase never runs backwards, and that the
// ftms_integration.js -> animation hand-off passes the right ticks.
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadFtms, buildFrame } = require('./harness');

function loadAnimation() {
  const sandbox = {
    window: { parent: { postMessage() {} } },
    document: {},
    performance: { now: () => 0 },
    requestAnimationFrame() {},
    cancelAnimationFrame() {},
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const file = path.join(__dirname, '..', 'rowing_display.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.RowingAnimation;
}

const RA = loadAnimation();
const FINISH = RA.FINISH_PHASE;
const wrapHalf = (x) => x - Math.round(x);

// ---------------------------------------------------------------------
// Simulated rower.
//
// True finishes happen at times set by `periodAt(k)`. The machine samples
// once a second (at `tickOffset` + i) and reports the stroke counter as it
// stood then, so a stroke is only seen by the first sample after it. The
// animation is drawn at 60 fps; at each real finish we read the drawn
// phase and report how far it is from the finish pose, in seconds.
// ---------------------------------------------------------------------
const spmField = (periodS) => Math.round((60 / periodS) / 0.5) * 0.5;

function simulate(opts) {
  const periodAt = opts.periodAt;
  const seconds = opts.seconds || 90;
  const tickOffset = opts.tickOffset === undefined ? 0.37 : opts.tickOffset;
  const spmOf = opts.spmOf || spmField;
  const tracker = RA.createPhaseTracker();

  const finishes = [];
  for (let k = 0, t = 0.7; t < seconds; k++, t += periodAt(k - 1)) finishes.push(t);

  const packets = [];
  for (let i = 0; tickOffset + i < seconds; i++) {
    if (opts.dropEvery && i % opts.dropEvery === opts.dropEvery - 1) continue;
    const t = tickOffset + i;
    let n = 0;
    while (n < finishes.length && finishes[n] <= t) n++;
    packets.push({ t, strokes: n, spm: n ? spmOf(periodAt(n - 1)) : 0 });
  }

  const errors = [];
  let phase = 0, lastPhase = 0, backsteps = 0, spm = 0, pi = 0, prev = null, next = 0;
  const dt = 1 / 60;
  for (let now = 0; now < seconds; now += dt) {
    while (pi < packets.length && packets[pi].t <= now) {
      const p = packets[pi++];
      spm = p.spm;
      if (prev && p.strokes > prev.strokes) {
        tracker.stroke(p.t, p.strokes - prev.strokes, p.t - prev.t, spm);
      }
      prev = p;
    }
    phase = opts.freeRun
      ? (phase + dt * spm / 60) % 1
      : tracker.advance(phase, dt, now, spm);

    let step = phase - lastPhase;
    if (step < -0.5) step += 1;          // wrapped past 1.0, not a step back
    if (step < 0) backsteps++;
    lastPhase = phase;

    while (next < finishes.length && finishes[next] <= now) {
      errors.push({ stroke: next, seconds: wrapHalf(phase - FINISH) * periodAt(next) });
      next++;
    }
  }
  return { errors, backsteps };
}

// Error after the lock has had `from` strokes to settle (the very first
// finish happens before any packet can possibly report it).
function settled(result, from) {
  const abs = result.errors.filter((e) => e.stroke >= from).map((e) => Math.abs(e.seconds));
  return { max: Math.max(...abs), mean: abs.reduce((a, b) => a + b, 0) / abs.length };
}

// Deterministic jitter, so the tests don't depend on Math.random.
function lcg(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

// ---------------------------------------------------------------------
// 1. Pose mapping
// ---------------------------------------------------------------------
test('catch and finish land on the shader keyframes', () => {
  assert.equal(RA.toRenderPhase(0), 0);                       // catch = keyframe 0
  assert.ok(Math.abs(RA.toRenderPhase(FINISH) - 0.375) < 1e-12); // finish = keyframe 3 (hands at chest)
  assert.ok(Math.abs(RA.toRenderPhase(1 - 1e-9) - 1) < 1e-6);    // back round to the catch
});

test('render phase is continuous and increasing across the whole cycle', () => {
  let last = RA.toRenderPhase(0);
  for (let a = 0.001; a < 1; a += 0.001) {
    const r = RA.toRenderPhase(a);
    assert.ok(r > last, 'not increasing at ' + a);
    assert.ok(r - last < 0.01, 'jump at ' + a);
    last = r;
  }
});

// ---------------------------------------------------------------------
// 2. Tracker, driven by a simulated rower
// ---------------------------------------------------------------------
test('the drive takes a larger share of the stroke at higher rates', () => {
  assert.ok(Math.abs(RA.driveFractionForSpm(24) - 1 / 3) < 1e-9);
  assert.equal(RA.driveFractionForSpm(0), 1 / 3);
  assert.ok(RA.driveFractionForSpm(18) < RA.driveFractionForSpm(24));
  assert.ok(RA.driveFractionForSpm(32) > RA.driveFractionForSpm(24));
  assert.equal(RA.driveFractionForSpm(5), 0.25);
  assert.equal(RA.driveFractionForSpm(80), 0.5);
});

test('whatever the drive share, the finish stays put and the catch leads it', () => {
  for (const d of [0.25, 1 / 3, 0.42, 0.5]) {
    assert.ok(Math.abs(RA.toRenderPhase(FINISH, d) - 0.375) < 1e-9, 'finish, d=' + d);
    // just after the catch the pose is at the start of the track
    const afterCatch = RA.toRenderPhase(FINISH - d + 1e-6, d);
    assert.ok(afterCatch >= 0 && afterCatch < 1e-4, 'catch, d=' + d + ': ' + afterCatch);
    // one lap from the finish: increasing, wrapping once at the catch
    let last = RA.toRenderPhase(FINISH, d), wraps = 0;
    for (let i = 1; i <= 2000; i++) {
      const r = RA.toRenderPhase(FINISH + i / 2000 * 0.9999, d);
      if (r < last) { wraps++; assert.ok(last > 0.99 && r < 0.01, 'jump at ' + i); }
      else assert.ok(r - last < 0.005, 'step at ' + i);
      last = r;
    }
    assert.equal(wraps, 1, 'd=' + d);
  }
});

test('boat surge peaks just after the finish and averages out over a stroke', () => {
  let sum = 0, best = 0, worst = 0;
  const N = 1000;
  for (let i = 0; i < N; i++) {
    const f = RA.surgeFactor(i / N);
    sum += f;
    if (f > RA.surgeFactor(best)) best = i / N;
    if (f < RA.surgeFactor(worst)) worst = i / N;
  }
  assert.ok(Math.abs(sum / N - 1) < 1e-9, 'mean ' + sum / N);
  assert.ok(best > FINISH && best < FINISH + 0.15, 'fastest at ' + best);
  assert.ok(worst > 0.8 || worst < 0.05, 'slowest at ' + worst);  // around the catch
});

test('free-runs from spm until the first stroke tick', () => {
  const tracker = RA.createPhaseTracker();
  assert.equal(tracker.isLocked(10, 24), false);
  const next = tracker.advance(0.2, 0.5, 10, 24);
  assert.ok(Math.abs(next - (0.2 + 0.5 * 24 / 60)) < 1e-12);
});

test('finish pose lands on the real finish at a steady 24 spm', () => {
  const synced = settled(simulate({ periodAt: () => 2.5 }), 6);
  assert.ok(synced.max < 0.3, 'max error ' + synced.max);
  assert.ok(synced.mean < 0.15, 'mean error ' + synced.mean);
});

test('the old spm-only free-run is a whole fraction of a stroke off', () => {
  // Guards the premise of the whole change: without ticks the animation has
  // no tie to the real finish, only an arbitrary start offset that never
  // corrects.
  const free = settled(simulate({ periodAt: () => 2.5, freeRun: true }), 6);
  assert.ok(free.mean > 0.8, 'free-run mean error ' + free.mean);
});

test('holds at a steady 20 and 30 spm, whatever the packet alignment', () => {
  for (const periodS of [3.0, 2.0]) {
    for (const tickOffset of [0.05, 0.37, 0.9]) {
      // A period that is a whole number of seconds is the worst case: every
      // stroke falls at the same point between packets, so the 1 Hz
      // quantisation never averages out and the error can be up to 0.5 s.
      const r = settled(simulate({ periodAt: () => periodS, tickOffset }), 6);
      assert.ok(r.max < 0.5, `period ${periodS} offset ${tickOffset}: ${r.max}`);
    }
  }
});

test('tolerates stroke-to-stroke variation', () => {
  const rnd = lcg(7);
  const r = simulate({ periodAt: () => 2.5 * (1 + (rnd() - 0.5) * 0.1) });
  const s = settled(r, 6);
  assert.ok(s.max < 0.45, 'max error ' + s.max);
  assert.equal(r.backsteps, 0);
});

test('recovers when the rower\'s own spm is wrong', () => {
  // The machine's spm is smoothed and can lag the real stroke interval;
  // here it reads half the true rate. The measured tick interval must win.
  const r = simulate({ periodAt: () => 2.5, spmOf: (periodS) => spmField(periodS * 2) });
  const s = settled(r, 10);
  assert.ok(s.max < 0.5, 'max error ' + s.max);
});

test('follows a tempo ramp from 18 to 30 spm', () => {
  const r = simulate({ periodAt: (k) => 60 / (18 + 12 * Math.min(k / 40, 1)) });
  const s = settled(r, 6);
  assert.ok(s.max < 0.7, 'max error ' + s.max);
  assert.ok(s.mean < 0.3, 'mean error ' + s.mean);
});

test('survives lost packets (two strokes arriving in one packet)', () => {
  const r = simulate({ periodAt: () => 2.5, dropEvery: 6 });
  const s = settled(r, 6);
  assert.ok(s.max < 0.5, 'max error ' + s.max);
});

test('the drawn rower never moves backwards', () => {
  const scenarios = [
    { periodAt: () => 2.5 },
    { periodAt: () => 2.5, spmOf: (p) => spmField(p * 2) },
    { periodAt: () => 2.5, dropEvery: 4 },
    { periodAt: (k) => 60 / (18 + 12 * Math.min(k / 40, 1)) },
    { periodAt: (k) => (k < 12 ? 3.0 : 60 / 26) }
  ];
  for (const opts of scenarios) assert.equal(simulate(opts).backsteps, 0);
});

// ---------------------------------------------------------------------
// 3. Stopping and restarting
// ---------------------------------------------------------------------
function lockedTracker() {
  const tracker = RA.createPhaseTracker();
  // Strokes every 2.5 s, a packet per second reporting 24 spm.
  tracker.stroke(10.0, 1, 1, 24);
  tracker.stroke(12.5, 1, 1, 24);
  tracker.stroke(15.0, 1, 1, 24);
  return tracker;
}

test('winds down with spm instead of rowing on at the old period', () => {
  const tracker = lockedTracker();
  assert.equal(tracker.isLocked(15.5, 24), true);
  // ftms_integration.js's watchdog scales spm toward 0 when the rower stops.
  assert.equal(tracker.isLocked(16.5, 24 * 0.5), false);
  assert.equal(tracker.advance(0.4, 0.1, 16.5, 0), 0.4);    // spm 0: frozen where it is
  const slowing = tracker.advance(0.4, 0.1, 16.5, 12);
  assert.ok(Math.abs(slowing - (0.4 + 0.1 * 12 / 60)) < 1e-12);
});

test('drops the lock when ticks stop arriving', () => {
  // lockedTracker(): last finish at 14.5 s, period 2.5 s. The lock is kept
  // for 2.5 periods plus a second (7.25 s) without a tick.
  const tracker = lockedTracker();
  assert.equal(tracker.isLocked(14.5 + 7.0, 24), true);
  assert.equal(tracker.isLocked(14.5 + 7.5, 24), false);
});

test('a stroke after a long pause starts a fresh lock rather than correcting a stale one', () => {
  const tracker = lockedTracker();
  tracker.stroke(100, 1, 1, 30);                  // much later, rowing again at 30 spm
  assert.equal(tracker.isLocked(100.2, 30), true);
  assert.ok(Math.abs(tracker.period() - 2.0) < 1e-9);   // from the new spm, not the old 2.5 s
  // The stroke was somewhere in the 1 s before the packet: the lock puts
  // its finish half a second back, so at t=100 the cycle is 0.5/2.0 past it.
  const phase = tracker.advance(0, 5.0, 100.0, 30);     // a long dt reads the clock directly
  assert.ok(Math.abs(wrapHalf(phase - (FINISH + 0.25))) < 1e-9);
});

test('after a long frame gap (hidden tab) the phase jumps to the clock instead of chasing it', () => {
  // lockedTracker(): at t=17.0 the clock is exactly one period past the
  // last finish (14.5 + 2.5), so the finish pose is due.
  const tracker = lockedTracker();
  const jumped = tracker.advance(0.9, 5.0, 17.0, 24);
  assert.ok(Math.abs(wrapHalf(jumped - FINISH)) < 1e-9, 'got ' + jumped);
  // A normal-length frame only chases it.
  const chased = tracker.advance(0.9, 1 / 60, 17.0, 24);
  assert.ok(Math.abs(wrapHalf(chased - FINISH)) > 0.1, 'got ' + chased);
});

// ---------------------------------------------------------------------
// 4. ftms_integration.js -> animation hand-off
// ---------------------------------------------------------------------
function ftmsWithSpies() {
  const calls = [];
  const h = loadFtms({
    globals: {
      setConsoleSpeedAndSpm: (speed, spm) => calls.push(['spm', spm]),
      noteStroke: (count, gapS) => calls.push(['stroke', count, gapS])
    }
  });
  h.api.init();
  return { h, calls, strokes: () => calls.filter((c) => c[0] === 'stroke') };
}

function feed(h, fields, afterMs) {
  h.clock.advance(afterMs === undefined ? 1000 : afterMs);
  h.api.ingest(buildFrame(fields));
}

test('a counted stroke is handed to the animation with the gap since the last packet', () => {
  const { h, strokes } = ftmsWithSpies();
  feed(h, { spm: 0, strokes: 0, distance: 0 });
  feed(h, { spm: 24, strokes: 1, distance: 3, watts: 120 });   // wakes the session and carries a stroke
  feed(h, { spm: 24, strokes: 1, distance: 6, watts: 120 });   // no new stroke
  feed(h, { spm: 24, strokes: 2, distance: 9, watts: 120 });
  assert.deepEqual(strokes().map((c) => [c[1], c[2]]), [[1, 1], [1, 1]]);
});

test('the stroke is reported after the spm that came with it', () => {
  // noteStroke pairs the stroke with the animation's current spm, so the
  // new spm has to be in place first.
  const { h, calls } = ftmsWithSpies();
  feed(h, { spm: 0, strokes: 0 });
  feed(h, { spm: 26, strokes: 1, distance: 3, watts: 120 });
  const spmAt = calls.findIndex((c) => c[0] === 'spm' && c[1] === 26);
  const strokeAt = calls.findIndex((c) => c[0] === 'stroke');
  assert.ok(spmAt >= 0 && strokeAt > spmAt, JSON.stringify(calls));
});

test('lost packets cap the reported stroke count', () => {
  const { h, strokes } = ftmsWithSpies();
  feed(h, { spm: 0, strokes: 0 });
  feed(h, { spm: 24, strokes: 1, distance: 3, watts: 120 });
  feed(h, { spm: 24, strokes: 9, distance: 30, watts: 120 }, 4000);
  assert.equal(strokes().pop()[1], 3);
});

test('a counter that goes backwards (rower reset) is not a stroke', () => {
  const { h, strokes } = ftmsWithSpies();
  feed(h, { spm: 0, strokes: 0 });
  feed(h, { spm: 24, strokes: 40, distance: 3, watts: 120 });
  const before = strokes().length;
  feed(h, { spm: 24, strokes: 1, distance: 6, watts: 120 });
  assert.equal(strokes().length, before);
});

test('nothing is reported while the session has not started', () => {
  const { h, strokes } = ftmsWithSpies();
  feed(h, { spm: 0, strokes: 0 });
  feed(h, { spm: 0, strokes: 0 });
  assert.equal(strokes().length, 0);
});

test('ftms_integration.js still works where the animation is not loaded', () => {
  const h = loadFtms();             // no noteStroke / setConsoleSpeedAndSpm defined
  h.api.init();
  feed(h, { spm: 0, strokes: 0 });
  assert.doesNotThrow(() => feed(h, { spm: 24, strokes: 1, distance: 3, watts: 120 }));
});
