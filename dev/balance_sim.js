'use strict';
// Balance simulation for the game core.
//
// The scoring rules in run_score.js are parameters of a game, not
// physiology: what they have to do is make a steady rower earn the base
// points without building a chain, make pushing visibly pay, and make
// neither of those outcomes a knife edge. This script checks that on
// simulated sessions, with the same rate wobble the app's own debug
// simulator uses (debug_sim.js: +-0.8 spm).
//
//   node dev/balance_sim.js
//
// Sweep LIFT_PER_TIER_SPM and read the ratios: the last line of each
// block says what pushing is worth against a steady session.
const RunScore = require('../run_score.js');

const WOBBLE = 0.8;
const DT = 1;

function wobble(t, amp) {
  return Math.sin(t / 9 * Math.PI * 4) * amp * 0.62 + Math.sin(t / 9 * Math.PI * 7) * amp * 0.38;
}
function speed(spm) { return 0.13 * spm - 0.03; }

const P = {
  steady26:  (t) => 26 + wobble(t, WOBBLE),
  steady20:  (t) => 20 + wobble(t, WOBBLE),
  push20s:   (t) => (t >= 300 && t < 320) ? 32 + wobble(t, WOBBLE) : 26 + wobble(t, WOBBLE),
  sustained: (t) => (t >= 60 && t < 420) ? 29 + wobble(t, WOBBLE) : 24 + wobble(t, WOBBLE),
  intervals: (t) => (Math.floor(t / 90) % 2 === 0 ? 31 : 22) + wobble(t, WOBBLE),
  fatigue:   (t) => 26 - 6 * (t / 600) + wobble(t, WOBBLE)
};

function simulate(profile, seconds, tuning) {
  const state = RunScore.createRun(tuning);
  let distance = 0, lifting = 0, liftSum = 0;
  for (let t = 1; t <= seconds; t++) {
    const spm = profile(t);
    const d = distance + speed(spm) * DT;
    RunScore.tick(state, { activeSeconds: t, distance: d, strokes: Math.round(t * spm / 60), spm, watts: 180 });
    if (state.liftSpm > 0) lifting++;
    liftSum += state.liftSpm;
    distance = d;
  }
  return {
    liftPct: Math.round(100 * lifting / seconds),
    avgLift: (liftSum / seconds).toFixed(2),
    score: Math.round(state.score),
    mult: state.multiplier,
    maxMult: state.maxMultiplier,
    dist: Math.round(distance),
    pushes: state.pushes
  };
}

for (const liftPerTier of [1.0, 1.5, 2.5]) {
  console.log(`\n=== lift par palier : ${liftPerTier} spm ===`);
  const res = {};
  for (const [name, profile] of Object.entries(P)) {
    const r = simulate(profile, 600, { liftPerTierSpm: liftPerTier });
    res[name] = r;
    console.log(
      `  ${name.padEnd(10)} lift>0 ${String(r.liftPct).padStart(3)}%  lift moy ${r.avgLift}  ` +
      `mult ${r.mult}/${r.maxMult}  score ${String(r.score).padStart(7)}  ` +
      `${r.dist} m  pushes ${r.pushes}`
    );
  }
  const b = res.steady26.score;
  console.log(`  -> push20s ${(res.push20s.score/b*100).toFixed(0)}%  ` +
              `sustained ${(res.sustained.score/b*100).toFixed(0)}%  ` +
              `intervals ${(res.intervals.score/b*100).toFixed(0)}%  ` +
              `steady20 ${(res.steady20.score/b*100).toFixed(0)}%  ` +
              `fatigue ${(res.fatigue.score/b*100).toFixed(0)}%`);
}
