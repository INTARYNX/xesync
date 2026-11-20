#!/usr/bin/env node
// =====================================================================
// dev/sim_session.js - a synthetic session, shaped like a real row.
//
// The point of this file is not to be a good simulator. It is to be a
// well-understood one: a known cadence profile with a known noise, so
// that dev/calibrate.js can be checked against something whose answer
// is known. It is also what the calibration should be run on before any
// real session exists - if the tool cannot read a session whose answer
// we know, it will not be trusted with a real one.
//
//   node dev/sim_session.js --out session.json
//   node dev/sim_session.js --profile sprint --noise 1.2 --rho 0.8
//   node dev/sim_session.js --sweep            (the noise sensitivity grid)
//
// Four things separate this from a sine wave, and all four matter to the
// game:
//
//  1. THE NOISE IS CORRELATED. A real erg's stroke rate does not jitter
//     like white noise: the rower settles into a rhythm, the flywheel
//     has inertia, and the reported rate drifts. An AR(1) process
//     (rho = how much the previous error carries over) models that.
//     This is the single most important knob: the game reads the rate
//     through a 3 s median, which kills white noise and passes
//     correlated noise straight through. At rho = 0 the elevation noise
//     is half what it is at rho = 0.95, and the threshold that is safe
//     at one is a cliff at the other.
//
//  2. THE MACHINE QUANTISES. A PM5 reports the rate with a resolution,
//     and the app rounds to a tenth. Quantisation noise is unbiased but
//     not smooth.
//
//  3. THE RATE CANNOT JUMP. The flywheel takes a few seconds to reach a
//     new speed: a first-order lag, not a step.
//
//  4. A REAL PIECE HAS A SHAPE. Warm-up with the rhythm still unstable,
//     a body, a sprint, a cool-down where the rate decays in steps, and
//     the tail where the rower stops and the flywheel spins down to
//     zero - which the app sees as spm = 0.
//
// The noise parameters are GUESSES. The point of --sweep is to find the
// thresholds that are safe across the whole plausible range instead of
// tuning to one assumption.
// =====================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const calibrate = require(path.join(ROOT, 'dev', 'calibrate.js'));

// -- a deterministic pseudo-random generator ---------------------------

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    // xorshift32 - deterministic, no dependency on Math.random's state.
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Gaussian from two uniforms (Box-Muller).
function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// -- the profiles -----------------------------------------------------

// Each profile is a list of segments. A segment is either a ramp (the
// rate moves from `from` to `to`) or a hold (from == to). `lag` is the
// time constant of the flywheel's response in seconds.
const PROFILES = {
  // A classic 20-minute erg piece.
  //
  // The shape that matters: a push is a STEP, not a ramp. The rower goes
  // from 23 to 26 in a few seconds and holds it for a minute; the 30 s
  // trailing norm then sits 3 spm below for as long as the push lasts.
  // A slow ramp (which is what a warm-up is) leaves the norm almost
  // level with the rate, so the lift stays near zero - and that is
  // exactly why a warm-up must not fill the chain.
  erg: {
    label: 'erg 20 min',
    segments: [
      { s: 45, from: 12, to: 16, lag: 3.5 },    // the rhythm is not there yet
      { s: 255, from: 16, to: 22, lag: 3 },     // warm-up, 4 min
      { s: 60, from: 22, to: 22, lag: 2 },      // settles
      { s: 300, from: 22, to: 23, lag: 4 },     // the body, a slow drift
      { s: 8, from: 23, to: 26, lag: 2 },       // the push: a step
      { s: 62, from: 26, to: 26, lag: 2 },      // held
      { s: 30, from: 26, to: 23, lag: 3 },      // back off
      { s: 120, from: 23, to: 21, lag: 4 },     // cool-down
      { s: 30, from: 21, to: 8, lag: 5 },       // the last strokes
      { s: 30, from: 0, to: 0, lag: 1 }         // the flywheel spins down
    ]
  },
  // Someone who rows at one rate and never varies it.
  steady: {
    label: 'steady',
    segments: [
      { s: 120, from: 16, to: 22, lag: 4 },
      { s: 600, from: 22, to: 22, lag: 2 },
      { s: 120, from: 22, to: 18, lag: 4 },
      { s: 60, from: 0, to: 0, lag: 1 }
    ]
  },
  // A race piece: hard from the start, sprint at the end.
  sprint: {
    label: 'sprint',
    segments: [
      { s: 90, from: 20, to: 28, lag: 3 },
      { s: 300, from: 28, to: 29, lag: 3 },
      { s: 8, from: 29, to: 32, lag: 2 },       // the sprint: a step
      { s: 52, from: 32, to: 32, lag: 2 },
      { s: 60, from: 32, to: 0, lag: 5 }
    ]
  },
  // A short, honest 10 minutes.
  short: {
    label: 'short 10 min',
    segments: [
      { s: 60, from: 14, to: 22, lag: 3.5 },
      { s: 420, from: 22, to: 23, lag: 2.5 },
      { s: 60, from: 23, to: 18, lag: 4 },
      { s: 30, from: 0, to: 0, lag: 1 }
    ]
  }
};

// -- the session builder ----------------------------------------------

function buildSession(opts) {
  const profile = PROFILES[opts.profile] || PROFILES.erg;
  const rand = rng(opts.seed);
  const samples = [];

  let time = 0;
  let distance = 0;
  let strokes = 0;
  let rate = 12;          // where the flywheel actually is
  let error = 0;          // the AR(1) part of the jitter
  const innovation = opts.noise * Math.sqrt(1 - opts.rho * opts.rho);
  const steadyWindows = [];

  for (const seg of profile.segments) {
    const start = seg.from;
    // A window where the rate is held still. The norm needs 30 s to
    // catch up, so the first 45 s of a hold are not steady yet - that
    // transient is the ratchet, not the noise.
    const holdStart = time + Math.min(45, Math.floor(seg.s / 3));
    if (seg.from === seg.to && seg.s > 60) steadyWindows.push([holdStart, time + seg.s]);
    for (let i = 0; i < seg.s; i++) {
      const t = time + i;

      // Where the rower is trying to be.
      const target = start + (seg.to - start) * (i / Math.max(1, seg.s - 1));

      // 1. the flywheel's lag
      rate += (target - rate) * (1 - Math.exp(-1 / Math.max(0.1, seg.lag)));

      // 2. the correlated jitter: this error carries over
      error = opts.rho * error + innovation * gaussian(rand);

      // 3. quantisation, as the machine reports it
      const raw = Math.max(0, rate + error);
      const spm = Math.round(raw * 10) / 10;

      // The distance and the strokes follow the measured rate. On an erg
      // the drag is constant, so the power (and hence the speed) grows
      // with the rate: the 500 m split goes as 1/rate^2. The constant
      // below puts 22 spm at 2:00 per 500 m, which is where a real
      // machine sits.
      const SPLIT_K = 58080;
      if (spm > 0) {
        // metres per second = 500 / (SPLIT_K / r^2) = r^2 / 116.16
        distance += (spm * spm) / 116.16;
        strokes += (spm / 60) * 1.0;
      }
      const watts = spm > 0 ? Math.round(90 + (spm - 12) * 13) : 0;

      samples.push([
        Math.round(t * 10) / 10,
        Math.round(distance),
        Math.round(strokes),
        spm,
        watts,
        null,
        spm > 0 ? Math.round(SPLIT_K / (spm * spm)) : 0
      ]);
    }
    time += seg.s;
  }

  const last = samples[samples.length - 1];
  const moving = samples.filter((s) => s[3] > 0);
  const avgSpm = moving.length ? moving.reduce((a, s) => a + s[3], 0) / moving.length : 0;

  return {
    version: 1,
    // Not part of the app's payload: the windows where the rate was held
    // still, so that the noise can be measured on them and on nothing
    // else. A real session has no such marker - the calibration then
    // falls back to the whole session, which over-estimates the noise.
    meta: { steadyWindows: steadyWindows },
    summary: {
      duration: Math.round(last[0]),
      distance: last[1],
      strokes: last[2],
      calories: Math.round(last[1] / 4),
      avgSpm: Math.round(avgSpm * 10) / 10,
      avgPace: avgSpm ? Math.round(500 / avgSpm) : 0,
      avgWatts: 0,
      avgHr: null
    },
    samples
  };
}

// -- the sensitivity sweep --------------------------------------------

// The question the calibration has to answer is not "what is the noise
// on average" but "what threshold is safe for the noise the machine
// might produce". So: sweep the plausible range of the two noise
// parameters, and take the worst case.
function sweep(opts) {
  const sigmas = opts.sigmas || [0.4, 0.8, 1.2, 1.6];
  const rhos = opts.rhos || [0, 0.5, 0.8, 0.95];
  const profiles = opts.profiles || ['erg', 'steady', 'sprint', 'short'];

  console.log('\n── bruit d\'élévation vu par le jeu ──────────────────────────');
  console.log('   σ = écart-type du jitter machine, ρ = autocorrélation');
  console.log('   le jeu lit la cadence par une médiane de 3 s : le bruit blanc');
  console.log('   est filtré, le bruit corrélé passe.\n');

  const rows = [];
  for (const profile of profiles) {
    for (const rho of rhos) {
      const cells = [];
      for (const sigma of sigmas) {
        const session = buildSession({ profile, noise: sigma, rho, seed: opts.seed });
        const a = calibrate.analyse(session.samples);
        const noise = calibrate.noiseFloor(a.lifts);
        const sug = calibrate.suggest(noise, a);
        cells.push({ sigma, rho, sd: noise ? noise.sd : null, lift: sug ? sug.lift : null, a });
        rows.push(cells[cells.length - 1]);
      }
      console.log(`  ${profile.padEnd(8)} ρ=${String(rho).padEnd(5)} ` +
        cells.map((c) => `σ${c.sigma} → bruit ${c.sd === null ? '  -  ' : c.sd.toFixed(2).padStart(5)}` +
          ` (seuil ${c.lift === null ? ' - ' : c.lift.toFixed(1).padStart(4)})`).join('   '));
    }
  }

  const lifts = rows.map((r) => r.lift).filter((v) => v !== null && v !== undefined);
  if (!lifts.length) return null;
  const worst = Math.max(...lifts);
  const median = lifts.sort((a, b) => a - b)[Math.floor(lifts.length / 2)];

  console.log('\n── ce qu\'il faut en retenir ───────────────────────────────');
  console.log(`  seuil médian sur la grille   ${median.toFixed(1)} spm`);
  console.log(`  seuil sûr (pire cas)         ${worst.toFixed(1)} spm`);
  console.log(`  LIFT_PER_TIER_SPM actuel     ${require(path.join(ROOT, 'run_score.js'))._internals.LIFT_PER_TIER_SPM}`);
  console.log(`  PUSH_EXCESS_SPM actuel       ${require(path.join(ROOT, 'run_score.js'))._internals.PUSH_EXCESS_SPM}`);
  console.log('');
  console.log(`  → LIFT_PER_TIER_SPM = ${worst.toFixed(1)}`);
  console.log(`  → PUSH_EXCESS_SPM   = ${(worst * 2).toFixed(1)}`);
  console.log('');
  console.log('  (le pire cas est retenu parce qu\'un seuil trop bas est une falaise,');
  console.log('   alors qu\'un seuil un peu haut ne fait que ralentir le jeu)');
  return { worst, median };
}

// The threshold sweep: what each value of LIFT_PER_TIER_SPM does to the
// shape of a session.
//
// Three things have to hold at once:
//
//   - a warm-up (a slow ramp, where the norm trails the rate and the
//     lift stays slightly positive) must NOT build the chain: it is
//     automatic, it happens in every session, and if it fills the
//     multiplier the game has no arc;
//   - a real push (3 spm above the norm) must build it, and visibly;
//   - luck (the jitter on a steady row) must stay invisible.
//
// The first one is what the current threshold gets wrong.
function sweepLift(opts) {
  const lifts = opts.lifts || [1.5, 2.5, 3.5, 5, 7, 10];
  const profiles = opts.profiles || ['erg', 'steady', 'sprint', 'short'];

  console.log('\n── que fait chaque seuil ? ────────────────────────────────');
  console.log('   paliers atteints, et à quand (chaîne ×N)');
  console.log('  erg = échauffement 5 min + palier + poussée, steady = cadence');
  console.log('   ten��ue, sprint = course, short = 10 min\n');

  for (const profile of profiles) {
    console.log(`  ${profile}`);
    for (const lift of lifts) {
      const session = buildSession({ profile, noise: opts.noise, rho: opts.rho, seed: opts.seed });
      const a = calibrate.analyse(session.samples, {
        liftPerTierSpm: lift,
        pushExcessSpm: opts.push !== undefined ? opts.push : lift * 2,
        liftExponent: opts.exponent === undefined ? 2 : opts.exponent
      });
      const luck = calibrate.luckStats(a, session.meta.steadyWindows);
      const times = a.tierTimes.map((x) => `×${x.m}@${Math.round(x.t)}`).join(' ');
      // The koi: the push calls it, and the chain keeps it there.
      const fish = a.state.fish.landed ? 'pêchée'
        : (a.state.fish.present ? 'là' : '—');
      console.log(`    LIFT ${String(lift).padStart(4)}  max ×${a.summary.maxMultiplier}  ` +
        `score ${String(a.summary.score).padStart(7)}  ` +
        `pushes ${a.state.pushes}  carpe ${fish}  ` +
        `hasard σ ${luck ? luck.sd.toFixed(2) : '-'}  ${times || '(aucun palier)'}`);
    }
    console.log('');
  }

  // The koi at the settings the game actually runs with. The sweep
  // above moves the thresholds around to find them; this is what they
  // are worth when they are left alone.
  console.log('── la carpe, aux réglages actuels ───────────────────────────');
  console.log('   la poussée appelle la carpe, et la chaîne la garde 15 s\n');
  for (const profile of profiles) {
    const session = buildSession({ profile, noise: opts.noise, rho: opts.rho, seed: opts.seed });
    const a = calibrate.analyse(session.samples);
    const fish = a.events.find((e) => e.type === 'fish_appeared');
    const landed = a.events.find((e) => e.type === 'fish_landed');
    console.log(`  ${profile.padEnd(8)} pushes ${String(a.state.pushes).padStart(2)}  ` +
      `max ×${a.summary.maxMultiplier}  ` +
      `carpe ${fish ? (landed ? `pêchée à ${Math.round(landed.t)} s` : `apparue à ${Math.round(fish.t)} s, jamais pêchée`)
        : '—'}  ` +
      `score ${a.summary.score}`);
  }
  console.log('');
}

// -- main -------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const opts = {
    out: null, profile: 'erg', noise: 0.8, rho: 0.6, seed: 20261119,
    sweep: false, sigmas: null, rhos: null, profiles: null
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--profile') opts.profile = argv[++i];
    else if (arg === '--noise') opts.noise = parseFloat(argv[++i]);
    else if (arg === '--rho') opts.rho = parseFloat(argv[++i]);
    else if (arg === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (arg === '--sweep') opts.sweep = true;
    else if (arg === '--sweep-lift') opts.sweepLift = true;
    else if (arg === '--lifts') opts.lifts = argv[++i].split(',').map(Number);
    else if (arg === '--exponent') opts.exponent = parseFloat(argv[++i]);
    else if (arg === '--push') opts.push = parseFloat(argv[++i]);
    else if (arg === '--sigmas') opts.sigmas = argv[++i].split(',').map(Number);
    else if (arg === '--rhos') opts.rhos = argv[++i].split(',').map(Number);
    else if (arg === '--profiles') opts.profiles = argv[++i].split(',');
  }

  if (opts.sweep) {
    sweep(opts);
    return;
  }
  if (opts.sweepLift) {
    sweepLift(opts);
    return;
  }

  const session = buildSession(opts);
  const text = JSON.stringify(session, null, 1);
  if (opts.out) {
    fs.writeFileSync(opts.out, text);
    console.log(`écrit ${opts.out}  (${session.samples.length} échantillons, ${session.summary.duration} s, ` +
                `profil ${opts.profile}, σ ${opts.noise}, ρ ${opts.rho})`);
  } else {
    console.log(text);
  }
}

if (require.main === module) main();

module.exports = { buildSession, PROFILES };
