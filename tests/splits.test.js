// =====================================================================
// splits.test.js - end-of-workout splits table: fixed 500m splits (like
// a PM5), fully independent of coaching.js/challenges (see splits.js's
// file header for why they're deliberately kept apart).
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSplits() {
  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'splits.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'splits.js' });
  return sandbox.Splits;
}

// samples mirror ftms_integration.js's session.samples: cumulative
// distance/strokes, ~1 sample/second, hr nullable.
function buildSamples(durationS, fns) {
  const samples = [];
  for (let t = 1; t <= durationS; t++) {
    samples.push({
      time: t,
      distance: fns.distance(t),
      strokes: fns.strokes ? fns.strokes(t) : Math.round(t / 3),
      spm: fns.spm ? fns.spm(t) : 20,
      watts: fns.watts ? fns.watts(t) : 150,
      hr: fns.hr ? fns.hr(t) : 130,
      pace: 0
    });
  }
  return samples;
}

// ---------------------------------------------------------------------
// Constant-speed session: every 500m split takes exactly the same time.
// ---------------------------------------------------------------------
test('constant-speed 20min/4000m session yields 8 exact 500m splits at 2:30.0 each', () => {
  const Splits = loadSplits();
  const total = 1200;
  const samples = buildSamples(total, { distance: (t) => (4000 / 1200) * t });
  const table = Splits.computeSplitsTable(samples, total);

  assert.equal(table.rows.length, 8); // 4000m stays under the 5000m 500m-split bucket
  table.rows.forEach((r) => {
    assert.equal(r.distance, '500 m');
    assert.equal(r.pace, '2:30.0');
    assert.equal(r.duration, '2:30');
    assert.equal(r.insufficientData, false);
  });
  assert.equal(table.total.duration, '20:00');
  assert.equal(table.total.distance, '4000 m');
  assert.equal(table.total.pace, '2:30.0');
});

// ---------------------------------------------------------------------
// Split size scales with distance so a long row never turns into a wall
// of 500m rows (feedback: a 10k with 500m splits is unreadable).
// ---------------------------------------------------------------------
test('split size grows with total distance, like a real rower would report it', () => {
  const Splits = loadSplits();
  const pick = Splits._internals.pickSplitMeters;
  assert.equal(pick(3000), 500);   // short piece: fine-grained
  assert.equal(pick(5000), 500);   // right at the boundary, still fine
  assert.equal(pick(8000), 1000);  // medium piece: coarser
  assert.equal(pick(15000), 2000); // a 10k+: coarser still
  assert.equal(pick(30000), 5000); // an ultra-long row: coarsest
});

test('a 12000m session (over the 500m-split bucket) reports 2000m splits, six rows', () => {
  const Splits = loadSplits();
  const total = 3600;
  const samples = buildSamples(total, { distance: (t) => (12000 / 3600) * t });
  const table = Splits.computeSplitsTable(samples, total);

  assert.equal(table.rows.length, 6); // 12000 / 2000
  table.rows.forEach((r) => assert.equal(r.distance, '2000 m'));
});

// ---------------------------------------------------------------------
// Variable-pace: total pace must come from totals, not an average of the
// (different) 500m splits' own paces.
// ---------------------------------------------------------------------
test('variable-pace splits still yield a total pace computed from totals', () => {
  const Splits = loadSplits();
  const segMeters = [2500, 2400, 2350, 2400, 2350]; // sums to 12000m over 3600s
  const segLenS = 720;
  function distanceAt(t) {
    const segIdx = Math.min(4, Math.floor((t - 1) / segLenS));
    let prior = 0;
    for (let i = 0; i < segIdx; i++) prior += segMeters[i];
    const tInSeg = t - segIdx * segLenS;
    return prior + segMeters[segIdx] * (tInSeg / segLenS);
  }
  const total = 3600;
  const samples = buildSamples(total, { distance: distanceAt });
  const table = Splits.computeSplitsTable(samples, total);

  assert.equal(table.rows.length, 6); // 12000m -> 2000m splits
  const paces = new Set(table.rows.map((r) => r.pace));
  assert.ok(paces.size > 1, 'splits should show genuinely different paces across the session');
  assert.equal(table.total.distance, '12000 m');
  assert.equal(table.total.pace, '2:30.0'); // not an average of the rows above
});

// ---------------------------------------------------------------------
// A session shorter than one split is a single partial row.
// ---------------------------------------------------------------------
test('a session under 500m is a single partial row, not an empty table', () => {
  const Splits = loadSplits();
  const total = 100;
  const samples = buildSamples(total, { distance: (t) => t * 3 }); // 300m
  const table = Splits.computeSplitsTable(samples, total);

  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].distance, '300 m');
  assert.equal(table.total.distance, '300 m');
});

// ---------------------------------------------------------------------
// A partial final split after some full ones.
// ---------------------------------------------------------------------
test('a partial final split follows the full 500m splits', () => {
  const Splits = loadSplits();
  const total = 210;
  const samples = buildSamples(total, { distance: (t) => t * 5 }); // 1050m @ 5 m/s
  const table = Splits.computeSplitsTable(samples, total);

  assert.equal(table.rows.length, 3);
  assert.equal(table.rows[0].distance, '500 m');
  assert.equal(table.rows[1].distance, '500 m');
  assert.equal(table.rows[2].distance, '50 m');
  assert.equal(table.rows[2].duration, '0:10'); // 50m @ 5 m/s = 10s
  assert.equal(table.total.distance, '1050 m');
});

// ---------------------------------------------------------------------
// Zero-denominator cases never produce Infinity/NaN
// ---------------------------------------------------------------------
test('a session with no distance shows a dash, never Infinity or NaN', () => {
  const Splits = loadSplits();
  const total = 60;
  const samples = buildSamples(total, { distance: () => 0, strokes: () => 0 });
  const table = Splits.computeSplitsTable(samples, total);
  table.rows.concat([table.total]).forEach((r) => {
    assert.equal(r.pace, '—');
  });
});

// ---------------------------------------------------------------------
// HR coverage below/at-or-above 80% of the session
// ---------------------------------------------------------------------
test('heart rate below 80% coverage is hidden as a dash', () => {
  const Splits = loadSplits();
  const total = 100;
  const samples = buildSamples(total, {
    distance: (t) => t * 3,
    hr: (t) => (t <= 50 ? 140 : null)
  });
  const table = Splits.computeSplitsTable(samples, total);
  assert.equal(table.total.hr, '—');
});

test('heart rate at or above 80% coverage is shown as a number', () => {
  const Splits = loadSplits();
  const total = 100;
  const samples = buildSamples(total, {
    distance: (t) => t * 3,
    hr: (t) => (t <= 90 ? 140 : null)
  });
  const table = Splits.computeSplitsTable(samples, total);
  assert.equal(table.total.hr, 140);
});

// ---------------------------------------------------------------------
// A real gap (pause/BLE loss) at a split boundary marks that split
// insufficient, without breaking the session total (real endpoints).
// ---------------------------------------------------------------------
test('a gap at a split boundary is marked insufficient without breaking the total', () => {
  const Splits = loadSplits();
  // Samples jump from t=10 to t=20 (a 10s gap, well past MAX_GAP_S=3).
  // Distance crosses the 500m split boundary inside that gap.
  const samples = [
    { time: 1,  distance: 50,  strokes: 1,  spm: 20, watts: 150, hr: 130 },
    { time: 10, distance: 450, strokes: 10, spm: 20, watts: 150, hr: 130 },
    { time: 20, distance: 550, strokes: 20, spm: 20, watts: 150, hr: 130 },
    { time: 30, distance: 650, strokes: 30, spm: 20, watts: 150, hr: 130 }
  ];
  const table = Splits.computeSplitsTable(samples, 30);

  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].insufficientData, true, 'the 500m boundary falls inside the 10s gap');
  assert.notEqual(table.total.distance, '—');
  assert.equal(table.total.distance, '650 m');
});
