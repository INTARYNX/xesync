// =====================================================================
// splits.js - end-of-workout splits table: fixed 500m splits, the way a
// rower actually reads a session (time and pace per 500m, like a PM5),
// not a table shaped around when a milestone or mini-challenge happened.
//
// Challenge results are reported separately (controller.js's
// coachingSummary highlight text, above the table) - this file has no
// idea coaching.js even exists, on purpose: "pour les défis ça doit être
// à part" was explicit feedback after mixing the two produced a table
// nobody could read (rows tagged SPRINT/KM, cumulative-time columns that
// needed mental subtraction, a row whose tag silently vanished depending
// on exactly when the session ended).
//
// Pure function of (samples, totalSeconds): no DOM, no clock, no globals
// mutated. Called from controller.js's window.onBeforeSave hook, right
// before ftms_integration.js resets the session.
//
//   samples - session.samples from ftms_integration.js:
//             [{ time, distance, strokes, spm, watts, hr, pace }, ...]
//             time/distance/strokes are already cumulative and already
//             corrected for rower counter resets - nothing here needs
//             to re-derive that.
// =====================================================================

var Splits = (function () {
  'use strict';

  var SPLITS_VERSION  = 3;
  var MAX_GAP_S        = 3;    // beyond this between-sample gap, don't trust interpolation across it
  var HR_COVERAGE_MIN  = 0.8;  // doc's starting quality bar for showing a numeric HR average

  // Split size scales with the session so the table stays a reasonable
  // length regardless of distance - 500m splits on a 10km row would be 20
  // rows, unreadable on a small screen. Same convention a real rower uses:
  // finer splits on a short piece, coarser ones on a long one.
  var SPLIT_TABLE = [
    { maxDistance: 5000,  splitMeters: 500  },
    { maxDistance: 10000, splitMeters: 1000 },
    { maxDistance: 20000, splitMeters: 2000 }
  ];
  var MAX_SPLIT_METERS = 5000; // anything longer still than the table above

  function pickSplitMeters(totalDistance) {
    for (var i = 0; i < SPLIT_TABLE.length; i++) {
      if (totalDistance <= SPLIT_TABLE[i].maxDistance) return SPLIT_TABLE[i].splitMeters;
    }
    return MAX_SPLIT_METERS;
  }

  // -- Sample lookup / interpolation --------------------------------------
  function findBracket(samples, t) {
    if (!samples.length) return null;
    if (t <= samples[0].time) return { before: samples[0], after: samples[0] };
    var last = samples[samples.length - 1];
    if (t >= last.time) return { before: last, after: last };
    for (var i = 0; i < samples.length - 1; i++) {
      if (samples[i].time <= t && t <= samples[i + 1].time) return { before: samples[i], after: samples[i + 1] };
    }
    return { before: last, after: last };
  }

  // Only ever called for 'distance'/'strokes': both are counters that
  // ftms_integration.js zeroes at session start, so t=0 is always exactly 0
  // regardless of when the first sample actually landed (recordSample()'s
  // own minimum spacing means it's rarely exactly at t=0).
  function interpAt(samples, t, key) {
    if (!samples.length) return null;
    if (t <= 0) return 0;
    var br = findBracket(samples, t);
    if (!br) return null;
    if (br.before === br.after) return br.before[key];
    var span = br.after.time - br.before.time;
    if (span <= 0) return br.before[key];
    var frac = (t - br.before.time) / span;
    return br.before[key] + (br.after[key] - br.before[key]) * frac;
  }

  // Inverse of interpAt for 'distance': given a target distance, find the
  // time it was reached. Distance is monotonically non-decreasing (already
  // corrected for rower resets upstream), so a single forward scan is safe.
  function findTimeAtDistance(samples, targetDistance) {
    if (!samples.length || targetDistance <= 0) return 0;
    var last = samples[samples.length - 1];
    if (targetDistance >= last.distance) return null; // never reached this split
    for (var i = 0; i < samples.length - 1; i++) {
      var a = samples[i], b = samples[i + 1];
      if (a.distance <= targetDistance && targetDistance <= b.distance) {
        var span = b.distance - a.distance;
        if (span <= 0) return a.time;
        var frac = (targetDistance - a.distance) / span;
        return a.time + (b.time - a.time) * frac;
      }
    }
    return null;
  }

  // True only when `t` lands strictly between two real samples that are
  // farther apart than MAX_GAP_S - i.e. a pause/BLE gap, not just the
  // ordinary ~1s sampling cadence. The two portion endpoints that matter
  // most (0 and totalSeconds) always coincide with a real sample, so the
  // session total is never penalised by a gap elsewhere in the session.
  function hasGapAt(samples, t) {
    var br = findBracket(samples, t);
    if (!br || br.before === br.after) return false;
    return (br.after.time - br.before.time) > MAX_GAP_S;
  }

  // Time-weighted HR coverage in [a,b]. Each sample's reading is treated as
  // holding from its own timestamp until the next sample's (capped at
  // MAX_GAP_S), which is what "pondérer par le temps réellement couvert"
  // means for irregularly-spaced FTMS packets.
  function hrCoverage(samples, a, b) {
    var idx = -1;
    for (var i = 0; i < samples.length; i++) { if (samples[i].time <= a) idx = i; else break; }
    var points = idx >= 0 ? [samples[idx]] : [];
    for (var j = idx + 1; j < samples.length && samples[j].time <= b; j++) points.push(samples[j]);

    var weighted = 0, covered = 0;
    for (var k = 0; k < points.length; k++) {
      var segStart = Math.max(a, points[k].time);
      var segEndRaw = (k + 1 < points.length) ? points[k + 1].time : b;
      var segEnd = Math.min(b, segEndRaw);
      var span = Math.min(segEnd - segStart, MAX_GAP_S);
      if (span <= 0) continue;
      if (points[k].hr != null) { weighted += points[k].hr * span; covered += span; }
    }
    return { weighted: weighted, covered: covered };
  }

  function computePortion(samples, a, b) {
    var durationS = b - a;
    if (durationS <= 0) return { durationS: 0, distance: null, pace: null, cadence: null, hr: null, insufficientData: true };

    var insufficientData = hasGapAt(samples, a) || hasGapAt(samples, b);
    var distA = interpAt(samples, a, 'distance'), distB = interpAt(samples, b, 'distance');
    var strA  = interpAt(samples, a, 'strokes'),  strB  = interpAt(samples, b, 'strokes');
    var distance = (distA != null && distB != null) ? Math.max(0, distB - distA) : null;
    var strokes  = (strA  != null && strB  != null) ? Math.max(0, strB  - strA)  : null;

    var pace    = (distance != null && distance > 0) ? (500 * durationS / distance) : null;
    var cadence = (strokes  != null && durationS > 0) ? (60 * strokes / durationS)  : null;

    var cov = hrCoverage(samples, a, b);
    var hrCoverageFrac = durationS > 0 ? cov.covered / durationS : 0;
    var hr = (hrCoverageFrac >= HR_COVERAGE_MIN && cov.covered > 0) ? (cov.weighted / cov.covered) : null;

    return {
      durationS: durationS,
      distance:  insufficientData ? null : distance,
      pace:      insufficientData ? null : pace,
      cadence:   insufficientData ? null : cadence,
      hr:        hr, // HR nulling is coverage-driven only, independent of insufficientData
      insufficientData: insufficientData
    };
  }

  // -- Row boundaries: fixed 500m splits -------------------------------
  // Every full SPLIT_METERS crossed becomes a row boundary (time found by
  // interpolating the real samples, not assumed from a constant pace), plus
  // one final partial row for whatever's left. A session shorter than one
  // split is just a single (partial) row.
  function buildSplitBoundaries(samples, totalSeconds) {
    var totalDistance = interpAt(samples, totalSeconds, 'distance') || 0;
    var splitMeters = pickSplitMeters(totalDistance);
    var bounds = [];
    var prevT = 0;
    var target = splitMeters;
    while (target < totalDistance) {
      var t = findTimeAtDistance(samples, target);
      if (t == null || t <= prevT) break; // guards against pathological/non-monotonic input
      bounds.push({ start: prevT, end: t });
      prevT = t;
      target += splitMeters;
    }
    bounds.push({ start: prevT, end: totalSeconds });
    return bounds;
  }

  // -- Formatting (doc section 4: "arrondir uniquement à l'affichage") ----
  function formatTime(s) {
    s = Math.max(0, Math.round(s));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var mm = (h > 0 && m < 10 ? '0' : '') + m;
    var ss = (sec < 10 ? '0' : '') + sec;
    return h > 0 ? (h + ':' + mm + ':' + ss) : (m + ':' + ss);
  }

  function formatPace(sec) {
    if (sec == null || !isFinite(sec) || sec <= 0) return '—';
    var m = Math.floor(sec / 60);
    var s = Math.round((sec - m * 60) * 10) / 10;
    if (s >= 60) { m += 1; s -= 60; }
    var sStr = s.toFixed(1);
    if (s < 10) sStr = '0' + sStr;
    return m + ':' + sStr;
  }

  function formatIntOrDash(v) { return v == null ? '—' : Math.round(v); }
  function formatMeters(v)    { return v == null ? '—' : Math.round(v) + ' m'; }

  // -- Public API -----------------------------------------------------
  function computeSplitsTable(samples, totalSeconds) {
    samples = samples || [];
    if (totalSeconds == null) totalSeconds = samples.length ? samples[samples.length - 1].time : 0;

    var bounds = buildSplitBoundaries(samples, totalSeconds);

    // Each row's own duration, not a cumulative time-of-day - "how long did
    // this 500m take" is the actual question, not something to work out by
    // subtracting two nearly-identical numbers.
    var rows = bounds.map(function (b) {
      var p = computePortion(samples, b.start, b.end);
      return {
        duration:  formatTime(b.end - b.start),
        distance:  p.insufficientData ? '—' : formatMeters(p.distance),
        pace:      p.insufficientData ? '—' : formatPace(p.pace),
        cadence:   p.insufficientData ? '—' : formatIntOrDash(p.cadence),
        hr:        formatIntOrDash(p.hr),
        insufficientData: p.insufficientData
      };
    });

    var totalPortion = computePortion(samples, 0, totalSeconds);
    var total = {
      duration: formatTime(totalSeconds),
      distance: formatMeters(totalPortion.distance),
      pace:     formatPace(totalPortion.pace),
      cadence:  formatIntOrDash(totalPortion.cadence),
      hr:       formatIntOrDash(totalPortion.hr)
    };

    return { version: SPLITS_VERSION, rows: rows, total: total };
  }

  return {
    computeSplitsTable: computeSplitsTable,
    SPLITS_VERSION: SPLITS_VERSION,
    _internals: {
      pickSplitMeters: pickSplitMeters, MAX_GAP_S: MAX_GAP_S, HR_COVERAGE_MIN: HR_COVERAGE_MIN,
      computePortion: computePortion, buildSplitBoundaries: buildSplitBoundaries,
      formatTime: formatTime, formatPace: formatPace,
      interpAt: interpAt, findTimeAtDistance: findTimeAtDistance
    }
  };
})();

if (typeof window !== 'undefined') window.Splits = Splits;
