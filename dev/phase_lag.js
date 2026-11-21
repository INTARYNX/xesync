'use strict';
// Mesure le retard de l'animation du rameur.
//
//   node dev/phase_lag.js
//
// La meme simulation que tests/rowing_sync.test.js : un rameur dont les
// fins de trainee sont connues, une machine qui emet un paquet par
// seconde, et le tracker de rowing_display.js qui s'y accroche. On
// mesure l'ecart entre la phase dessinee et la phase vraie, en
// secondes - c'est le retard que le rameur voit a l'ecran.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  const drawn = [];
  let phase = 0, lastPhase = 0, backsteps = 0, spm = 0, pi = 0, prev = null, next = 0;
  // La part de la trainee que la pose montre comme propulsion : elle
  // s'ease avec le tempo, comme dans l'app.
  let driveFraction = RA.DRIVE_FRACTION;
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
    phase = tracker.advance(phase, dt, now, spm);
    driveFraction += (RA.driveFractionForSpm(spm) - driveFraction) *
        Math.min(1.0, dt * RA.DRIVE_EASE_RATE);

    let step = phase - lastPhase;
    if (step < -0.5) step += 1;
    if (step < 0) backsteps++;
    lastPhase = phase;

    // Ce que l'oeil voit : la phase rendue, pas la phase brute.
    const shown = RA.toRenderPhase(phase, driveFraction);
    while (next < finishes.length && finishes[next] <= now) {
      const trueShown = RA.toRenderPhase(
        ((FINISH + (now - finishes[next]) / periodAt(next)) % 1 + 1) % 1, driveFraction);
      const d = wrapHalf(shown - trueShown) * periodAt(next);
      errors.push({ stroke: next, seconds: d });
      drawn.push(d);
      next++;
    }
  }
  // Diagnostic : l'ancre du tracker (le temps de fin estime) contre la
  // vraie fin, en millisecondes.
  const anchor = [];
  for (let k = 0; k < 12; k++) {
    const t = finishes[k];
    const idx = errors.findIndex((e) => e.stroke === k);
    anchor.push(t.toFixed(2) + ' -> ' + (idx >= 0 ? errors[idx].seconds.toFixed(3) : '?'));
  }
  return { errors, backsteps, drawn, anchor };
}

function stats(result, from) {
  const errs = result.errors.filter((e) => e.stroke >= from);
  const abs = errs.map((e) => Math.abs(e.seconds));
  const signed = errs.map((e) => e.seconds);
  const sum = abs.reduce((a, b) => a + b, 0) / abs.length;
  const mean = signed.reduce((a, b) => a + b, 0) / signed.length;
  return {
    max: Math.max(...abs),
    mean: sum,
    signed: mean,
    backsteps: result.backsteps
  };
}

const SCENARIOS = [
  { name: 'regulier 24 spm', opts: { periodAt: () => 2.5 } },
  { name: 'regulier 26 spm', opts: { periodAt: () => 60 / 26 } },
  { name: 'regulier 20 spm', opts: { periodAt: () => 3.0 } },
  { name: 'palier 3,0 s (le pire alignement)', opts: { periodAt: () => 3.0, tickOffset: 0.05 } },
  { name: 'rampe 18 -> 30 spm', opts: { periodAt: (k) => 60 / (18 + 12 * Math.min(k / 40, 1)) } },
  { name: 'paquets perdus (1 sur 6)', opts: { periodAt: () => 2.5, dropEvery: 6 } }
];

console.log('scenario                            | moyen   | max     | signe');
console.log('');
console.log('------------------------------------+---------+---------+-------');
for (const s of SCENARIOS) {
  const st = stats(simulate(s.opts), 6);
  console.log(
    s.name.padEnd(36) + ' | ' +
    st.mean.toFixed(3).padStart(7) + ' | ' +
    st.max.toFixed(3).padStart(7) + ' | ' +
    (st.signed > 0 ? 'en avance' : 'en retard'));
}
