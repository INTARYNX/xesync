// =====================================================================
// ftms.test.js - protocol parsing + session state machine.
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadFtms, buildFrame } = require('./harness');

// A real 20-byte frame, decoded by hand against the documented layout so
// this fixture is independent of buildFrame(). Byte index: value
//   [2]=52          -> spm      52 * 0.5      = 26
//   [4]=1,  [3]=100 -> strokes  1*255 + 100   = 355
//   [6]=2,  [5]=200 -> distance 2*255 + 200   = 710
//   [9]=0,  [8]=125 -> pace     0*255 + 125   = 125
//   [11]=0, [10]=150-> watts                  = 150
//   [13]=0, [12]=45 -> cals                   = 45
//   [16]=142        -> hr                     = 142
//   [19]=0, [18]=90 -> elapsed                = 90
const REAL_FRAME = '0,0,52,100,1,200,2,0,125,0,150,0,45,0,0,0,142,0,90,0';

// ---------------------------------------------------------------------
// 1. Config wiring
// ---------------------------------------------------------------------
test('INACTIVITY_MS follows the debug flag', () => {
  // Regression test for the hoisting bug: INACTIVITY_MS was computed from
  // `var DEBUG` before its assignment ran, so it read `undefined` and the
  // debug build silently got the production 5000ms timeout.
  assert.strictEqual(loadFtms().internals.INACTIVITY_MS, 5000);
  assert.strictEqual(loadFtms({ search: '?debug=true' }).internals.INACTIVITY_MS, 10000);
});

test('debug flag itself is parsed from the querystring', () => {
  assert.strictEqual(loadFtms().internals.DEBUG, false);
  assert.strictEqual(loadFtms({ search: '?debug=true' }).internals.DEBUG, true);
  assert.strictEqual(loadFtms({ search: '?debug=1' }).internals.DEBUG, false);
});

// ---------------------------------------------------------------------
// 2. Parsing
// ---------------------------------------------------------------------
test('known frame decodes to expected metrics', () => {
  const p = loadFtms().internals.parsePacket(REAL_FRAME);
  assert.strictEqual(p.spm, 26);
  assert.strictEqual(p.strokes, 355);
  assert.strictEqual(p.distance, 710);
  assert.strictEqual(p.pace, 125);
  assert.strictEqual(p.watts, 150);
  assert.strictEqual(p.cals, 45);
  assert.strictEqual(p.hr, 142);
  assert.strictEqual(p.elapsed, 90);
});

test('buildFrame round-trips through parsePacket', () => {
  const { parsePacket } = loadFtms().internals;
  const fields = { spm: 30, strokes: 1000, distance: 2540, pace: 118, watts: 205, cals: 88, hr: 155, elapsed: 600 };
  const p = parsePacket(buildFrame(fields));
  for (const k of Object.keys(fields)) {
    assert.strictEqual(p[k], fields[k], `field ${k}`);
  }
});

test('malformed frames are rejected and counted', () => {
  const { internals } = loadFtms();
  const bad = [
    null,
    '',
    '1,2,3',                                   // too short
    'a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t', // non-numeric
    REAL_FRAME.replace('52', 'xx')             // one corrupt field
  ];
  for (const b of bad) {
    assert.strictEqual(internals.parsePacket(b), null, `should reject: ${b}`);
  }
  assert.strictEqual(internals.metrics.badPackets, bad.length);
  assert.strictEqual(internals.metrics.packets, 0);
});

test('a frame longer than 20 bytes still parses', () => {
  // The AI2 path used to deliver extra framing bytes; parsing must key off
  // offsets, not total length.
  const { internals } = loadFtms();
  const p = internals.parsePacket(REAL_FRAME + ',7,7');
  assert.strictEqual(p.distance, 710);
  assert.strictEqual(internals.metrics.badPackets, 0);
});

test('absent heart rate is the 255 sentinel, not a reading', () => {
  const { internals } = loadFtms();
  const p = internals.parsePacket(buildFrame({ spm: 20 }));
  assert.strictEqual(p.hr, internals.HR_ABSENT);
});

// ---------------------------------------------------------------------
// 3. Activity detection
// ---------------------------------------------------------------------
test('activity is not decided by spm alone', () => {
  const { isActive, isSessionStart, parsePacket } = loadFtms().internals;
  const at = (f) => parsePacket(buildFrame(f));

  const prev = at({ spm: 26, strokes: 100, distance: 500, watts: 150 });

  // The old `spm > 0` rule called this inactive; it plainly is not.
  const zeroSpmMidStroke = at({ spm: 0, strokes: 101, distance: 505, watts: 150 });
  assert.strictEqual(isActive(zeroSpmMidStroke, prev), true);

  // Genuinely stopped: nothing moved.
  const stopped = at({ spm: 0, strokes: 100, distance: 500, watts: 0 });
  assert.strictEqual(isActive(stopped, prev), false);
});

test('watts alone counts as activity', () => {
  const { isActive, parsePacket } = loadFtms().internals;
  const p = parsePacket(buildFrame({ spm: 0, watts: 120 }));
  assert.strictEqual(isActive(p, null), true);
});

test('coasting distance resumes an active session but does not start one', () => {
  // A flywheel spinning down after the user stops still creeps distance.
  // That must keep a running session alive without un-pausing a session
  // the user just deliberately paused.
  const { isActive, isSessionStart, parsePacket } = loadFtms().internals;
  const prev = parsePacket(buildFrame({ spm: 0, strokes: 50, distance: 900, watts: 0 }));
  const coast = parsePacket(buildFrame({ spm: 0, strokes: 50, distance: 903, watts: 0 }));

  assert.strictEqual(isActive(coast, prev), true);
  assert.strictEqual(isSessionStart(coast, prev), false);
});

test('a new stroke starts a session', () => {
  const { isSessionStart, parsePacket } = loadFtms().internals;
  const prev = parsePacket(buildFrame({ spm: 0, strokes: 50, distance: 900 }));
  const stroke = parsePacket(buildFrame({ spm: 0, strokes: 51, distance: 900 }));
  assert.strictEqual(isSessionStart(stroke, prev), true);
});

// ---------------------------------------------------------------------
// 4. Session lifecycle
// ---------------------------------------------------------------------
function startedSession(opts) {
  const h = loadFtms(opts);
  h.api.init();
  return h;
}

test('session stays idle until real activity arrives', () => {
  const h = startedSession();
  h.api.ingest(buildFrame({ spm: 0, distance: 4000, strokes: 900 }));
  assert.strictEqual(h.internals.getPhase(), 'IDLE');

  h.api.ingest(buildFrame({ spm: 24, distance: 4000, strokes: 900 }));
  assert.strictEqual(h.internals.getPhase(), 'ACTIVE');
});

test('rower baseline is zeroed at session start', () => {
  // The machine's counters are cumulative across users; a session must
  // start from zero without asking the hardware to reset.
  const h = startedSession();
  h.api.ingest(buildFrame({ spm: 24, distance: 4000, strokes: 900, cals: 300 }));

  assert.strictEqual(h.document._text('distance'), 0);
  assert.strictEqual(h.document._text('strokes'), 0);
  assert.strictEqual(h.document._text('cals'), 0);

  h.clock.advance(1000);
  h.api.ingest(buildFrame({ spm: 24, distance: 4010, strokes: 902, cals: 301 }));
  assert.strictEqual(h.document._text('distance'), 10);
  assert.strictEqual(h.document._text('strokes'), 2);
  assert.strictEqual(h.document._text('cals'), 1);
});

test('a mid-session counter reset does not lose accumulated distance', () => {
  const h = startedSession();
  h.api.ingest(buildFrame({ spm: 24, distance: 1000, strokes: 100 }));
  h.clock.advance(1000);
  h.api.ingest(buildFrame({ spm: 24, distance: 1200, strokes: 110 }));
  assert.strictEqual(h.document._text('distance'), 200);

  // Someone hits reset on the console: raw counters drop to near zero.
  h.clock.advance(1000);
  h.api.ingest(buildFrame({ spm: 24, distance: 5, strokes: 1 }));
  assert.strictEqual(h.document._text('distance'), 205,
    'distance before the reset must be carried into the offset');
});

test('inactivity pauses the session after the timeout, not before', () => {
  const h = startedSession();
  h.api.ingest(buildFrame({ spm: 24, distance: 100, strokes: 10 }));
  assert.strictEqual(h.internals.getPhase(), 'ACTIVE');

  h.clock.advance(4000);
  h.tick();
  assert.strictEqual(h.internals.getPhase(), 'ACTIVE', 'still inside the 5s window');

  h.clock.advance(2000);
  h.tick();
  assert.strictEqual(h.internals.getPhase(), 'PAUSED');
  assert.strictEqual(h.document._visible('pauseDialog'), true);
});

test('rowing again resumes a paused session and excludes paused time', () => {
  const h = startedSession();
  h.api.ingest(buildFrame({ spm: 24, distance: 100, strokes: 10 }));

  h.clock.advance(6000);
  h.tick();
  assert.strictEqual(h.internals.getPhase(), 'PAUSED');

  h.clock.advance(30000);              // 30s standing around
  h.api.ingest(buildFrame({ spm: 24, distance: 110, strokes: 12 }));
  assert.strictEqual(h.internals.getPhase(), 'ACTIVE');
  assert.strictEqual(h.document._visible('pauseDialog'), false);

  const paused = h.internals.getSession().totalPausedMs;
  assert.ok(paused >= 30000, `paused time should be tracked, got ${paused}`);
});

// ---------------------------------------------------------------------
// 5. Sampling
// ---------------------------------------------------------------------
test('samples are recorded at most once per second', () => {
  const h = startedSession();
  h.api.ingest(buildFrame({ spm: 24, distance: 100, strokes: 10 }));

  // Ten frames inside one second: the burst must collapse to the first.
  for (let i = 0; i < 10; i++) {
    h.clock.advance(90);
    h.api.ingest(buildFrame({ spm: 24, distance: 101 + i, strokes: 10 }));
  }
  assert.strictEqual(h.internals.getSession().samples.length, 1);

  h.clock.advance(1100);
  h.api.ingest(buildFrame({ spm: 24, distance: 130, strokes: 12 }));
  assert.strictEqual(h.internals.getSession().samples.length, 2);
});

test('sample count is capped', () => {
  const h = startedSession();
  const s = h.internals.getSession;
  h.api.ingest(buildFrame({ spm: 24, distance: 100, strokes: 10 }));

  // Fill past the cap directly - pushing 15000 frames through ingest would
  // make this test take minutes for no extra coverage. Timestamps run up to
  // -1 so they stay in the past relative to the live session clock, or the
  // once-per-second rate limiter would reject the next sample before the
  // cap is ever consulted.
  const session = s();
  const cap = h.internals.MAX_SAMPLES;
  session.samples.length = 0;
  while (session.samples.length < cap) {
    session.samples.push({
      time: session.samples.length - cap,
      distance: 0, strokes: 0, spm: 0, watts: 0, hr: null, pace: 120
    });
  }

  h.clock.advance(5000);
  h.api.ingest(buildFrame({ spm: 24, distance: 200, strokes: 20 }));
  assert.strictEqual(s().samples.length, cap, 'must not grow past the cap');
  assert.ok(s().droppedSamples > 0, 'drops must be counted, not silent');
});

// ---------------------------------------------------------------------
// 6. Pace
// ---------------------------------------------------------------------
test('rolling pace is derived from distance over time, machine pace is not', () => {
  const h = startedSession();
  h.api.ingest(buildFrame({ spm: 24, distance: 0, strokes: 1, pace: 999 }));

  // 40m in 20s -> 500m would take 250s. The gap has to stay inside the 30s
  // rolling window, or the older point ages out and there is nothing to
  // difference against.
  h.clock.advance(20000);
  h.api.ingest(buildFrame({ spm: 24, distance: 40, strokes: 20, pace: 999 }));

  const session = h.internals.getSession();
  assert.ok(Math.abs(session.rollingPace - 250) < 1,
    `rollingPace should be ~250, got ${session.rollingPace}`);
  assert.strictEqual(session.machinePace, 999,
    'machinePace must stay the raw reported value');
});

test('rolling pace holds its last good value when movement stalls', () => {
  const h = startedSession();
  h.api.ingest(buildFrame({ spm: 24, distance: 0, strokes: 1 }));
  h.clock.advance(50000);
  h.api.ingest(buildFrame({ spm: 24, distance: 100, strokes: 20 }));

  const held = h.internals.getSession().rollingPace;

  h.clock.advance(1000);
  h.api.ingest(buildFrame({ spm: 24, distance: 100, strokes: 21 })); // no distance gained
  assert.strictEqual(h.internals.getSession().rollingPace, held,
    'must hold, not divide by zero distance');
  assert.ok(isFinite(h.internals.getSession().rollingPace));
});

// ---------------------------------------------------------------------
// 7. Workout identity + payload
// ---------------------------------------------------------------------
test('workout ids do not collide within the same second', () => {
  const h = loadFtms();                    // clock frozen: same second for all
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(h.internals.workoutTag());
  assert.strictEqual(ids.size, 500);
});

test('workout id keeps the workout_ prefix the offline queue scans for', () => {
  const tag = loadFtms().internals.workoutTag();
  assert.ok(tag.startsWith('workout_'), tag);
  assert.ok(tag.length <= 50, `must fit workout_id VARCHAR(50), got ${tag.length}`);
});

test('payload carries a summary and compact sample rows', () => {
  const h = startedSession();
  h.api.ingest(buildFrame({ spm: 24, distance: 0, strokes: 1, watts: 100, hr: 140 }));
  h.clock.advance(1200);
  h.api.ingest(buildFrame({ spm: 26, distance: 20, strokes: 3, watts: 120, hr: 145 }));

  const payload = h.internals.buildPayload();
  assert.strictEqual(payload.version, 1);
  assert.ok(payload.summary);
  assert.strictEqual(payload.summary.distance, 20);
  assert.strictEqual(payload.samples.length, 2);

  // [time, distance, strokes, spm, watts, hr, pace]
  assert.strictEqual(payload.samples[0].length, 7);
  assert.strictEqual(payload.samples[1][5], 145, 'hr column');
});

test('missing heart rate stores null, not a fictitious zero', () => {
  const h = startedSession();
  h.api.ingest(buildFrame({ spm: 24, distance: 0, strokes: 1 }));   // hr defaults to 255
  h.clock.advance(1200);
  h.api.ingest(buildFrame({ spm: 24, distance: 20, strokes: 3 }));

  const payload = h.internals.buildPayload();
  assert.strictEqual(payload.summary.avgHr, null);
  assert.strictEqual(payload.samples[0][5], null);
});
