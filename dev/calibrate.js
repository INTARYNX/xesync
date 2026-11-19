#!/usr/bin/env node
// =====================================================================
// dev/calibrate.js - what the game constants should be, on real rows.
//
// Every tunable in run_score.js is a guess until it meets a real session:
// the machine's stroke rate jitters, and the jitters decide whether the
// chain ever leaves zero. This tool replays a saved session through the
// real scoring code and reports what the numbers actually do.
//
// Input: the workout JSON saved by the app (payload.samples - an array of
// [time, distance, strokes, spm, watts, hr, pace]) or the raw
// workout_data blob from the database. Several sessions at once are
// averaged.
//
//   node dev/calibrate.js session.json
//   node dev/calibrate.js *.json --json
//
// What it reports:
//   - the cadence the machine actually produces, and the noise that
//     survives the 3 s median the game reads;
//   - how long the 30 s norm takes to establish;
//   - the chain's trajectory: tiers reached, time to each, time in flow;
//   - what LIFT_PER_TIER_SPM and PUSH_EXCESS_SPM should be, given that
//     noise. A threshold below the noise floor is a cliff, not a game.
//
// See docs/GAMIFICATION.md for why these are the numbers that matter.
// =====================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RunScore = require(path.join(ROOT, 'run_score.js'));

const TUNING = RunScore._internals;

// -- input ------------------------------------------------------------

// The samples live under different keys depending on where the JSON came
// from: the payload the app saves, the workout_data blob, the row the
// database returns, or a list of any of those.
function findSamples(node, depth) {
  if (!node || depth > 4) return null;
  if (Array.isArray(node)) {
    // An array of session payloads: merge their samples into one run.
    const merged = [];
    for (const item of node) {
      const s = findSamples(item, depth + 1);
      if (s) merged.push(...s);
    }
    return merged.length ? merged : null;
  }
  if (typeof node !== 'object') return null;

  if (Array.isArray(node.samples) && node.samples.length) {
    // The app stores the samples as arrays [t, d, strokes, spm, watts,
    // hr, pace]. Normalise them once, here, so every caller sees the
    // same shape.
    return node.samples.map((s) => (Array.isArray(s)
      ? { time: s[0], distance: s[1], strokes: s[2], spm: s[3], watts: s[4] }
      : s));
  }
  for (const key of ['workout_data', 'payload', 'data', 'workout']) {
    if (node[key]) {
      const s = findSamples(node[key], depth + 1);
      if (s) return s;
    }
  }
  return null;
}

function loadSessions(files) {
  const sessions = [];
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`  ! ${file}: ${e.message}`);
      continue;
    }
    const samples = findSamples(json, 0);
    if (!samples || samples.length < 5) {
      console.error(`  ! ${file}: no usable samples`);
      continue;
    }
    // The simulated sessions carry the windows where the rate was held
    // still; a real session does not.
    const windows = (json && json.meta && json.meta.steadyWindows) || [];
    sessions.push({ file, samples, windows });
  }
  return sessions;
}

// -- statistics -------------------------------------------------------

function stats(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: values.length,
    mean,
    sd: Math.sqrt(variance),
    min: s[0],
    p10: at(0.10),
    p50: at(0.50),
    p90: at(0.90),
    max: s[s.length - 1]
  };
}

function fmt(v, digits) {
  if (v === null || v === undefined || !isFinite(v)) return '  -  ';
  return v.toFixed(digits === undefined ? 2 : digits);
}

// -- the replay -------------------------------------------------------

// Replays a session through the real scoring code and watches what the
// game actually sees: the rate it reads (a 3 s median), the norm it
// compares to (a 30 s median), and the chain it builds.
function analyse(rawSamples, tuning) {
  // The samples come either as the app's arrays [t, d, strokes, spm,
  // watts, hr, pace] or as plain objects. Normalise once, here, so every
  // caller can pass either.
  const samples = rawSamples.map((s) => (Array.isArray(s)
    ? { time: s[0], distance: s[1], strokes: s[2], spm: s[3], watts: s[4] }
    : s));
  const state = RunScore.createRun(tuning || {});
  const lifts = [];
  const liftAt = [];
  const heatAt = [];
  const rates = [];
  const normAt = [];
  const multiplierAt = [];
  const events = [];
  let normReadyAt = null;
  let tierTimes = [];

  let lastMultiplier = 1;
  let lastTickT = null;

  for (const s of samples) {
    const t = s.time;
    const snap = {
      activeSeconds: t,
      distance: s.distance || 0,
      strokes: s.strokes || 0,
      spm: s.spm || 0,
      watts: s.watts || 0
    };
    const evt = RunScore.tick(state, snap);

    if (lastTickT !== null && t > lastTickT) {
      if (state.refSpm !== null && state.refSpm !== undefined) {
        lifts.push(state.liftSpm);
        liftAt.push({ t, lift: state.liftSpm });
        rates.push(state.liftSpm + state.refSpm);
        normAt.push(state.refSpm);
        if (normReadyAt === null) normReadyAt = t;
      }
      multiplierAt.push({ t, m: state.multiplier, flow: state.inFlow });
      heatAt.push({ t, heat: state.heat, m: state.multiplier });
      if (state.multiplier > lastMultiplier) {
        tierTimes.push({ t, m: state.multiplier });
        events.push({ t, type: 'chain_up', m: state.multiplier });
      }
      lastMultiplier = state.multiplier;
    }
    lastTickT = t;
    if (evt && evt.type === 'push') events.push({ t, type: 'push' });
  }

  const summary = RunScore.summarize(state);
  const flowSeconds = multiplierAt.filter((x) => x.flow).reduce(
    (acc, x) => acc + Math.max(0, Math.min(x.t, samples[samples.length - 1].time) - x.t), 0);

  return {
    state,
    summary,
    lifts,
    liftAt,
    heatAt,
    rates,
    normAt,
    multiplierAt,
    events,
    normReadyAt,
    tierTimes,
    duration: samples[samples.length - 1].time
  };
}

// The noise floor: the spread of the lift once the norm exists. A
// threshold at or below it fires on noise alone, which is exactly the
// cliff the whole design is trying to avoid.
function noiseFloor(lifts) {
  if (lifts.length < 5) return null;
  const positive = lifts.filter((v) => v > 0);
  const s = stats(lifts);
  return {
    sd: s.sd,
    // What a steady rower (lift ~ 0) sees above the noise: the 90th
    // percentile of the lift is the threshold that still means something.
    p90: stats(positive) ? stats(positive).p90 : 0,
    p99: (() => {
      const v = lifts.slice().sort((a, b) => a - b);
      return v[Math.min(v.length - 1, Math.floor(0.99 * v.length))];
    })()
  };
}

// The suggestion.
//
// NOT the noise of the lift: the lift's spread over a whole session is
// dominated by the profile (a warm-up ramp, a push), not by the
// machine's jitter. What matters is what luck alone does to the chain
// while the rower holds a steady rate - and that spread is proportional
// to 1/liftPerTierSpm (measured, not assumed: the chain is pulled back
// towards zero by the decay, so it does not diffuse like a free random
// walk).
//
// So the threshold that keeps luck invisible is simply the current one,
// scaled by how far the spread is from the target.
function suggest(luck, currentLiftPerTier) {
  if (!luck || luck.sd <= 0) return null;
  const factor = luck.sd / TARGET_SPREAD;
  const lift = Math.round(currentLiftPerTier * factor * 10) / 10;
  return { lift, factor, spread: luck.sd };
}

// What luck alone does to the chain.
//
// On a steady row - the rate held still, the norm caught up - the chain
// should sit still too. It does not: the lift jitters around zero, the
// positive excursions feed the chain and the negative ones bleed it, and
// the result is a random walk. The question is not whether it moves (it
// must move) but how far it can wander before a tier is showing for no
// reason.
//
// A random walk's spread grows with the square root of the step size, and
// the step size here is 1/liftPerTierSpm. So dividing the spread by two
// means dividing liftPerTierSpm by four - which is the whole calibration
// in one line.
const TARGET_SPREAD = 0.5;   // tiers: below half a tier, luck stays invisible

function luckStats(a, windows) {
  const inWindow = (t) => !windows.length ||
    windows.some((w) => t >= w[0] && t <= w[1]);
  const pts = a.heatAt.filter((p) => inWindow(p.t));
  if (pts.length < 20) return null;
  const heats = pts.map((p) => p.heat);
  const s = stats(heats);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const seconds = Math.max(1, last.t - first.t);
  return {
    n: pts.length,
    seconds,
    // tiers per second, positive means luck is building the chain
    drift: (last.heat - first.heat) / seconds,
    sd: s.sd,
    max: s.max,
    min: s.min,
    maxMultiplier: a.summary.maxMultiplier
  };
}

// The liftPerTierSpm that keeps the spread under TARGET_SPREAD.
function suggestFromLuck(luck, currentLiftPerTier) {
  if (!luck || luck.sd <= 0) return null;
  const factor = Math.pow(luck.sd / TARGET_SPREAD, 2);
  const lift = Math.round(currentLiftPerTier * factor * 10) / 10;
  return { lift, factor, spread: luck.sd };
}

// -- report -----------------------------------------------------------

function report(session, opts) {
  const a = analyse(session.samples, opts.tuning);
  const cadence = stats(session.samples.map((s) => s.spm).filter((v) => v > 0));
  const noise = noiseFloor(a.lifts);
  const timeInFlow = a.multiplierAt.filter((x) => x.flow).length / Math.max(1, a.multiplierAt.length);

  console.log(`\n── ${path.basename(session.file)} ──────────────────────────────`);
  console.log(`  durée          ${fmt(a.duration, 0)} s   (${(a.duration / 60).toFixed(1)} min)`);
  console.log(`  cadence        moy ${fmt(cadence.mean, 1)} spm   σ ${fmt(cadence.sd, 2)}   ` +
              `p10 ${fmt(cadence.p10, 1)}  p50 ${fmt(cadence.p50, 1)}  p90 ${fmt(cadence.p90, 1)}`);
  console.log(`  norme (30 s)   prête à ${fmt(a.normReadyAt, 0)} s` +
              (a.normReadyAt ? `  (${((a.normReadyAt / a.duration) * 100).toFixed(0)} % de la séance)` : '  (jamais)'));
  console.log(`  bruit de l'élévation   σ ${fmt(noise ? noise.sd : null, 3)} spm   ` +
              `p90 ${fmt(noise ? noise.p90 : null, 3)}   p99 ${fmt(noise ? noise.p99 : null, 3)}`);

  const tiers = a.tierTimes.map((x) => `×${x.m} à ${fmt(x.t, 0)} s`).join(', ');
  console.log(`  chaîne         max ×${a.summary.maxMultiplier || 1}   ` +
              `${(timeInFlow * 100).toFixed(0)} % du temps en flux`);
  console.log(`  paliers        ${tiers || 'aucun'}`);
  console.log(`  score          ${a.summary.score}`);

  const luck = luckStats(a, session.windows || []);
  const suggestion = suggest(luck, opts.tuning && opts.tuning.liftPerTierSpm !== undefined
    ? opts.tuning.liftPerTierSpm
    : require(path.join(ROOT, 'run_score.js'))._internals.LIFT_PER_TIER_SPM);
  const curLift = opts.tuning.liftPerTierSpm !== undefined ? opts.tuning.liftPerTierSpm : TUNING.LIFT_PER_TIER_SPM;
  const curPush = opts.tuning.pushExcessSpm !== undefined ? opts.tuning.pushExcessSpm : TUNING.PUSH_EXCESS_SPM;
  if (!opts.json) {
    console.log('\n  ── ce que ça dit des constantes ──');
    if (!suggestion) {
      console.log('  Pas assez de données pour conclure : la norme n\'a jamais été établie');
      console.log('  (il faut 30 s de rame et 10 échantillons). Cette séance est trop');
      console.log('  courte pour être calibrée.');
    } else {
      console.log(`  écart de la chaîne sur un palier constant   ${fmt(suggestion.spread, 2)} palier ` +
                  `(cible ${TARGET_SPREAD})`);
      console.log(`  LIFT_PER_TIER_SPM   actuel ${curLift}   suggéré ${suggestion.lift}   ` +
                  `(l'écart varie en 1/seuil)`);
      console.log(`  PUSH_EXCESS_SPM     actuel ${curPush}   (le seuil de poussée doit être tenu, pas pic)`);
      if (a.tierTimes.length && a.tierTimes[a.tierTimes.length - 1].t < a.duration * 0.15) {
        console.log(`  ⚠ la chaîne atteint ×${a.summary.maxMultiplier} en ${fmt(a.tierTimes[a.tierTimes.length - 1].t, 0)} s : `);
        console.log('    le seuil est trop bas, le palier ne veut rien dire.');
      }
      if (timeInFlow < 0.02) {
        console.log('  ⚠ moins de 2 % du temps en flux : la chaîne ne démarre pas. Le seuil');
        console.log('    est au-dessus du bruit que la machine produit.');
      }
      if (timeInFlow > 0.8) {
        console.log('  ⚠ plus de 80 % du temps en flux : le seuil est trop bas, le jeu ne');
        console.log('    se joue plus - il n\'y a plus de risque à prendre.');
      }
    }
  }

  return {
    file: session.file,
    duration: a.duration,
    cadence,
    noise,
    tierTimes: a.tierTimes,
    timeInFlow,
    score: a.summary.score,
    maxMultiplier: a.summary.maxMultiplier,
    normReadyAt: a.normReadyAt,
    suggestion
  };
}

// -- main -------------------------------------------------------------

function curLiftOf(opts) {
  return opts.tuning.liftPerTierSpm !== undefined ? opts.tuning.liftPerTierSpm : TUNING.LIFT_PER_TIER_SPM;
}
function curPushOf(opts) {
  return opts.tuning.pushExcessSpm !== undefined ? opts.tuning.pushExcessSpm : TUNING.PUSH_EXCESS_SPM;
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { json: false, tuning: {} };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--lift') opts.tuning.liftPerTierSpm = parseFloat(argv[++i]);
    else if (arg === '--push') opts.tuning.pushExcessSpm = parseFloat(argv[++i]);
    else if (arg === '--tier') opts.tuning.tierS = parseFloat(argv[++i]);
    else if (arg === '--compare') opts.compare = true;
    else files.push(arg);
  }

  if (!files.length) {
    console.log('usage: node dev/calibrate.js <session.json> [...] [--json]');
    console.log('');
    console.log('Le JSON peut être la payload sauvegardée par l\'app, le workout_data');
    console.log('de la base, ou une liste des deux.');
    process.exit(1);
  }

  const sessions = loadSessions(files);
  if (!sessions.length) {
    console.error('aucune session exploitable.');
    process.exit(1);
  }

  const results = sessions.map((s) => report(s, opts));

  if (opts.compare) {
    console.log('\n── comparaison des seuils ──────────────────────────────');
    for (const session of sessions) {
      const current = analyse(session.samples, opts.tuning);
      const sug = suggest(luckStats(current, session.windows || []), curLiftOf(opts));
      if (!sug) {
        console.log(`  ${path.basename(session.file)} : pas assez de données`);
        continue;
      }
      const alt = analyse(session.samples, {
        ...opts.tuning,
        liftPerTierSpm: sug.lift
      });
      const flowOf = (a) => a.multiplierAt.filter((x) => x.flow).length / Math.max(1, a.multiplierAt.length);
      console.log(`  ${path.basename(session.file)}`);
      const atMax = (a) => {
        const first = a.tierTimes.find((x) => x.m === a.summary.maxMultiplier);
        return first ? `${fmt(first.t, 0)} s` : 'jamais';
      };
      console.log(`    seuils actuels   LIFT ${curLiftOf(opts)} / PUSH ${curPushOf(opts)}` +
                  `   → ×${current.summary.maxMultiplier} en ${atMax(current)}, score ${current.summary.score}`);
      console.log(`    seuils suggérés  LIFT ${sug.lift}` +
                  `   → ×${alt.summary.maxMultiplier} en ${atMax(alt)}, score ${alt.summary.score}`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Across sessions: what the noise floor really is.
  if (results.length > 1) {
    const sds = results.map((r) => r.noise && r.noise.sd).filter((v) => v !== null && v !== undefined);
    if (sds.length) {
      const mean = sds.reduce((a, b) => a + b, 0) / sds.length;
      const max = Math.max(...sds);
      console.log(`\n── sur ${results.length} séances ─────────────────────────────`);
      console.log(`  bruit de l'élévation   σ moyen ${fmt(mean, 3)} spm   (pire ${fmt(max, 3)})`);
      console.log(`  seuil plancher         LIFT_PER_TIER_SPM ≥ ${Math.max(0.5, Math.round((max * 3 + 0.5) * 10) / 10)}`);
      console.log(`  temps en flux moyen    ${(results.reduce((a, r) => a + r.timeInFlow, 0) / results.length * 100).toFixed(0)} %`);
    }
  }
}

if (require.main === module) main();

module.exports = {
  findSamples, analyse, noiseFloor, stats, suggest, luckStats, suggestFromLuck, TARGET_SPREAD
};
