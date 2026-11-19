// =====================================================================
// run_score.test.js - the game layer: score, flow chain and pushes.
//
// The module under test is the prototype of the scoring core described
// in docs/GAMIFICATION.md. It is a pure state machine: it takes the same
// per-tick snapshot the coaching module takes, and produces a score, a
// chain multiplier and a set of events.
//
// The mechanic is continuous, not a gate. Everything is measured against
// the rower's own recent norm (the median cadence of the last 30 s):
//
//   LIFT = rate - norm
//
//   LIFT > 0   the chain builds, faster the harder you push
//   LIFT <= 0  the chain bleeds
//
// A steady rower sits at LIFT ~ 0: they keep the base points but build
// no chain. A rower who pushes builds one, and the norm follows them, so
// the lift shrinks and they have to push more. That is the ratchet.
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RunScore = require('../run_score.js');

const I = RunScore._internals;

// -- driver ------------------------------------------------------------

// Simulate `seconds` of rowing at `spm`, moving `mps` metres per second.
// The snapshot shape is the one ftms_integration.js builds for coaching.
function row(state, seconds, spm, mps) {
  let evt = null;
  for (let i = 0; i < seconds; i++) {
    const t = state.totalSeconds + 1;
    const d = (state.lastDistance === null ? 0 : state.lastDistance) + mps;
    evt = RunScore.tick(state, {
      activeSeconds: t,
      distance: d,
      strokes: Math.round(t * (spm / 60)),
      spm: spm,
      watts: 200
    });
  }
  return evt;
}

// Warm up until the norm exists (it needs MIN_REF_SAMPLES samples),
// then put the run back to zero so a test starts from a known state.
function startRun(spm) {
  const state = RunScore.createRun();
  row(state, 30, spm, 3);
  state.score = 0;
  state.heat = 0;
  state.multiplier = 1;
  state.maxMultiplier = 1;
  state.flowSeconds = 0;
  state.streakSeconds = 0;
  state.distanceAtFlow = 0;
  state.inFlow = false;
  state.events.length = 0;
  return state;
}

// -- the norm -----------------------------------------------------------

test('before there is a norm, the ground counts but no chain can build', () => {
  const state = RunScore.createRun();
  row(state, 5, 20, 3);                    // 5 samples < MIN_REF_SAMPLES
  assert.equal(state.refSpm, null);
  assert.equal(state.barSpm, null);
  assert.equal(state.multiplier, 1);
  // The base points still accrue: the first seconds of a session are
  // worth something, they just cannot be judged. The very first sample
  // carries no distance delta - there is nothing before it to measure
  // from - so it contributes nothing.
  assert.equal(state.score, 4 * 3 * I.SCORE_PER_METER);
});

test('the norm is the median of the recent cadence', () => {
  const state = RunScore.createRun();
  row(state, 30, 20, 3);
  assert.equal(state.refSpm, 20);
});

test('the target shown to the rower sits above their own norm', () => {
  const state = RunScore.createRun();
  row(state, 30, 20, 3);
  assert.equal(state.barSpm, 20 + I.BAR_OFFSET_SPM);
});

test('the norm follows the effort: pushing raises it, easing off lowers it', () => {
  const state = RunScore.createRun();
  row(state, 30, 20, 3);
  assert.equal(state.refSpm, 20);

  row(state, 20, 26, 3);
  assert.ok(state.refSpm > 20, 'the norm followed the effort');

  row(state, 40, 20, 3);
  assert.equal(state.refSpm, 20);
});

test('a zero stroke rate is not a measurement and does not drag the norm down', () => {
  const state = RunScore.createRun();
  row(state, 30, 20, 3);
  row(state, 5, 0, 0);
  assert.equal(state.refSpm, 20);
});

// -- the lift ------------------------------------------------------------

test('the lift is how far above your own norm you are', () => {
  const state = startRun(20);               // norm is 20
  row(state, 3, 24, 3);
  assert.ok(state.liftSpm > 3, 'three strokes above the norm');
});

test('a steady rower sits at zero lift', () => {
  const state = startRun(20);
  row(state, 5, 20, 3);
  assert.equal(state.liftSpm, 0);
  assert.equal(state.inFlow, false);
});

test('a steady rower builds no chain', () => {
  const state = startRun(20);
  row(state, 120, 20, 3);
  assert.equal(state.maxMultiplier, 1, 'a calm pace earns the base points, not a chain');
});

test('a rower above their own norm builds the chain', () => {
  const state = startRun(20);
  row(state, 60, 23, 3);                    // +3 over the norm
  assert.ok(state.maxMultiplier >= 2, 'the chain built');
  assert.ok(state.maxMultiplier <= I.MAX_MULTIPLIER);
});

test('the chain builds faster the harder you push', () => {
  const gentle = startRun(20);
  row(gentle, 10, 22, 3);                  // lift 2
  const hard = startRun(20);
  row(hard, 10, 24, 3);                    // lift 4
  assert.ok(hard.heat > gentle.heat,
    `a bigger lift should build faster (${hard.heat} vs ${gentle.heat})`);
});

test('the chain never exceeds its maximum', () => {
  const state = startRun(20);
  row(state, 300, 26, 3);
  assert.equal(state.maxMultiplier, I.MAX_MULTIPLIER);
  assert.ok(state.multiplier <= I.MAX_MULTIPLIER);
});

test('the norm catching up empties the chain - the ratchet is not free', () => {
  const state = startRun(20);
  row(state, 15, 26, 3);                    // well above the norm
  assert.ok(state.multiplier >= 4, `the chain built (x${state.multiplier})`);

  // Hold the cadence: the norm follows it, the lift disappears, and the
  // chain bleeds away. Keeping a lift is work.
  row(state, 90, 26, 3);
  assert.equal(state.multiplier, 1);
});

test('the chain holds for a moment before it starts to bleed', () => {
  const state = startRun(20);
  // The lift lasts until the 30 s norm catches up - about fifteen
  // seconds - so the chain is built during that window, not after it.
  row(state, 12, 23, 3);
  assert.ok(state.multiplier >= 2, 'the chain built');

  // Ease off. The grace period means the chain does not vanish in the
  // same breath: it holds for a few seconds first.
  row(state, 2, 20, 3);
  assert.ok(state.multiplier >= 2,
    `the chain should hold through the grace (x${state.multiplier})`);

  // Then it goes.
  row(state, 60, 20, 3);
  assert.equal(state.multiplier, 1, 'the chain emptied');
});

test('a big push counts for much more than a small one', () => {
  // The drive is the lift squared: the chain rewards intensity, not
  // duration. Without it, a slow warm-up ramp - which every session has
  // - fills the chain before the session really starts.
  const small = startRun(20);
  row(small, 30, 22, 3);                    // +2 over the norm
  const smallHeat = small.heat;

  const big = startRun(20);
  row(big, 30, 26, 3);                      // +6 over the norm
  const bigHeat = big.heat;

  assert.ok(bigHeat > smallHeat * 4,
    `a big push should count for far more (${bigHeat} vs ${smallHeat})`);
});

// -- the ratchet ---------------------------------------------------------

test('the norm is the ratchet: a sustained push erodes your lift', () => {
  const state = startRun(20);
  row(state, 3, 26, 3);
  const liftAtStart = state.liftSpm;
  assert.ok(liftAtStart > 0);

  // Hold it: the norm catches up, so the lift shrinks even though the
  // cadence did not change.
  row(state, 40, 26, 3);
  assert.ok(state.liftSpm < liftAtStart,
    'the norm followed, so the lift shrank without any change of cadence');
});

test('the chain bleeds when the lift goes away', () => {
  const state = startRun(20);
  row(state, 60, 23, 3);                    // build a chain
  const peak = state.maxMultiplier;
  assert.ok(peak >= 2);

  row(state, 15, 20, 3);                    // back to the norm: no lift
  assert.equal(state.multiplier, 1, 'the chain emptied');
});

test('the chain refills once the lift comes back', () => {
  const state = startRun(20);
  row(state, 60, 23, 3);
  row(state, 60, 20, 3);                    // ease off until it empties
  assert.equal(state.multiplier, 1);

  row(state, 30, 25, 3);                    // a real push again
  assert.ok(state.multiplier >= 2, 'the chain rebuilt');
});

// -- the score -----------------------------------------------------------

test('the ground is always worth something, even out of flow', () => {
  const state = startRun(20);
  row(state, 10, 20, 3);                    // no lift at all
  assert.equal(state.inFlow, false);
  assert.ok(state.score > 0, 'a run never pays zero');
  assert.equal(state.multiplier, 1);
});

test('a metre is worth more the further above your norm you are', () => {
  const calm = startRun(20);
  row(calm, 6, 20, 3);
  const calmPerMetre = calm.score / 18;     // 6 s x 3 m

  const pushed = startRun(20);
  row(pushed, 6, 24, 3);
  const pushedPerMetre = pushed.score / 18;

  assert.ok(pushedPerMetre > calmPerMetre,
    `pushing should pay more per metre (${pushedPerMetre} vs ${calmPerMetre})`);
});

test('only distance covered with a lift counts as flow distance', () => {
  const state = startRun(20);
  row(state, 10, 24, 3);                    // lifted: 30 m
  const lifted = state.distanceAtFlow;
  assert.ok(lifted > 0);

  row(state, 10, 20, 3);                    // back to the norm
  const gained = state.distanceAtFlow - lifted;
  assert.ok(gained < 30, `out of flow distance was counted (${gained} m)`);
});

// -- pushes ---------------------------------------------------------------

test('a sustained excursion above the norm is a push and pays a bonus', () => {
  const state = startRun(20);
  const before = state.score;
  // The short window needs a few seconds to see the new rate, so the
  // excursion has to last longer than that.
  row(state, 9, 26, 3);                     // well above the norm, held
  assert.equal(state.pushes, 1);
  assert.ok(state.score > before + I.PUSH_BONUS);
});

test('a short excursion above the norm is not a push', () => {
  const state = startRun(20);
  row(state, 1, 26, 3);
  assert.equal(state.pushes, 0);
});

test('pushes respect a cooldown', () => {
  const state = startRun(20);
  row(state, 9, 26, 3);
  assert.equal(state.pushes, 1);
  row(state, 4, 26, 3);
  assert.equal(state.pushes, 1, 'the cooldown held');
  row(state, 14, 26, 3);
  assert.ok(state.pushes >= 2);
});

// -- the course of the day -------------------------------------------------

test('the chain reaching the day\'s par flags the event', () => {
  const state = startRun(20);
  RunScore.setDailyPar(state, { key: '2026-11-19', chainPar: 2, pushPar: 3 });

  // A push that gets the chain to x2.
  let flagged = null;
  for (let i = 0; i < 30 && !flagged; i++) {
    const evt = row(state, 1, 26, 3);
    if (evt && evt.parReached) flagged = evt;
  }
  assert.ok(flagged, 'reaching the par should flag the event');
  assert.equal(state.dailyParReached, true);
});

test('landing the pushes the day asks for flags the event too', () => {
  const state = startRun(20);
  RunScore.setDailyPar(state, { key: '2026-11-19', chainPar: 6, pushPar: 1 });

  // The chain stays low: only the push can reach the par.
  let flagged = null;
  for (let i = 0; i < 60 && !flagged; i++) {
    const evt = row(state, 1, 26, 3);
    if (evt && evt.parReached) flagged = evt;
  }
  assert.ok(flagged, 'the push should have reached the par');
  assert.equal(state.pushes >= 1, true);
});

test('without a par of the day, nothing is flagged', () => {
  const state = startRun(20);
  let flagged = false;
  for (let i = 0; i < 60; i++) {
    const evt = row(state, 1, 26, 3);
    if (evt && evt.parReached) flagged = true;
  }
  assert.equal(flagged, false);
});

test('the summary carries the course of the day', () => {
  const state = startRun(20);
  RunScore.setDailyPar(state, { key: '2026-11-19', chainPar: 3, pushPar: 2 });
  row(state, 20, 23, 3);
  const s = RunScore.summarize(state);
  assert.equal(s.dailyPar.key, '2026-11-19');
  assert.equal(s.dailyPar.chainPar, 3);
  assert.equal(s.dailyPar.pushPar, 2);
  assert.equal(typeof s.dailyPar.reached, 'boolean');
  assert.equal(s.dailyPar.reached, true, 'the chain reached x3 during that run');

  // A run that never gets there says so, and says nothing else.
  const other = startRun(20);
  RunScore.setDailyPar(other, { key: '2026-11-19', chainPar: 6, pushPar: 3 });
  row(other, 20, 23, 3);
  assert.equal(RunScore.summarize(other).dailyPar.reached, false);
});

test('the summary carries the race against the ghost', () => {
  const state = startRun(20);
  row(state, 20, 23, 3);
  RunScore.setGhostResult(state, {
    gapM: 42, at: 120, playerDistance: 600, ghostDistance: 558
  });
  const s = RunScore.summarize(state);
  assert.deepEqual(s.ghost, {
    gapM: 42, at: 120, playerDistance: 600, ghostDistance: 558
  });

  // No ghost, no result - and nothing invented.
  const other = startRun(20);
  row(other, 20, 23, 3);
  assert.equal(RunScore.summarize(other).ghost, null);
});

test('the summary carries the livery the boat wore', () => {
  const state = startRun(20);
  row(state, 20, 23, 3);
  RunScore.setLivery(state, { key: 'stripe', name: 'the racing stripe', changed: true });
  const s = RunScore.summarize(state);
  assert.deepEqual(s.livery, { key: 'stripe', name: 'the racing stripe', changed: true });

  // A run that wore the same livery as the one before says nothing.
  RunScore.setLivery(state, { key: 'stripe', name: 'the racing stripe', changed: false });
  assert.equal(RunScore.summarize(state).livery.changed, false);

  // And a run with no livery at all carries none.
  const other = startRun(20);
  row(other, 20, 23, 3);
  assert.equal(RunScore.summarize(other).livery, null);
});

// -- summary ---------------------------------------------------------------

test('the summary is stable and shaped for the payload', () => {
  const state = startRun(20);
  row(state, 40, 23, 3);
  const s = RunScore.summarize(state);
  assert.equal(s.version, RunScore.VERSION);
  assert.equal(typeof s.score, 'number');
  assert.ok(s.score > 0);
  assert.ok(s.flowSeconds > 0);
  assert.ok(s.distanceAtFlow > 0);
  assert.equal(typeof s.barSpm, 'number');
  assert.equal(typeof s.liftSpm, 'number');
});

test('a new run resets everything', () => {
  const state = startRun(20);
  row(state, 20, 23, 3);
  assert.ok(state.score > 0);
  RunScore.reset(state);
  assert.equal(state.score, 0);
  assert.equal(state.multiplier, 1);
  assert.equal(state.refSpm, null);
  assert.equal(state.samples.length, 0);
  assert.equal(state.events.length, 0);
});

test('the run emits the events the view layer needs', () => {
  const state = startRun(20);
  row(state, 15, 23, 3);                    // lift appears, then a tier
  const types = state.events.map(e => e.type);
  assert.ok(types.includes('flow_entered'));
  assert.ok(types.includes('chain_up'));
  row(state, 15, 20, 3);                    // and the lift goes away
  assert.ok(state.events.map(e => e.type).includes('flow_left'));
});
