// =====================================================================
// ghost.js - your own best run, replayed in the scene.
//
// The most direct way to make someone go faster, without ever saying
// "go faster": you race your own best run, on the same water, at the
// same moment of the session. It is the ghost of Alto's Odyssey, and it
// says everything it has to say by being where it is.
//
// No new data is needed. The app already saves every session's samples
// (time, distance, stroke rate) and the server already exposes them:
// `list_workouts` returns the summaries (with the average 500 m split),
// `get_workout` returns the samples of one run. This module turns those
// into a distance-time profile the scene can replay.
//
// Two things make it fair:
//
//   - the comparison is at the same elapsed time, not at the same
//     distance. You are compared with what you did at this point of the
//     session, not with the end of your own past run;
//   - the ghost rows at its own pace, with its own stroke cycle, taken
//     from the same profile. It does not row in lockstep with you.
//
// Pure module: no DOM, no network, no timers.
//
// See docs/GAMIFICATION.md, "Lot 3b".
// =====================================================================

var Ghost = (function () {
  'use strict';

  // What a run has to be before it can be a ghost: long enough to be a
  // session rather than a burst, and far enough to have a pace worth
  // chasing.
  var MIN_DISTANCE_M = 1000;
  var MIN_DURATION_S = 240;

  // How many seconds between two points of the profile. The samples
  // come at about 1 Hz; the scene only needs the shape of the curve.
  var PROFILE_STEP_S = 2;

  // A run is a candidate if it is long enough, and if it has a pace.
  // The pace is the seconds per 500 m: lower is faster.
  function isCandidate(w) {
    if (!w) return false;
    if (!w.distance_m || w.distance_m < MIN_DISTANCE_M) return false;
    if (!w.duration_sec || w.duration_sec < MIN_DURATION_S) return false;
    if (!w.avg_pace_sec || w.avg_pace_sec <= 0) return false;
    return true;
  }

  // The best run to race against: the fastest one that is long enough
  // to be a session. Ties go to the most recent, because a ghost you
  // just rowed is the one you can still beat.
  function bestRun(workouts) {
    if (!workouts || !workouts.length) return null;
    var best = null;
    for (var i = 0; i < workouts.length; i++) {
      var w = workouts[i];
      if (!isCandidate(w)) continue;
      if (!best ||
          w.avg_pace_sec < best.avg_pace_sec ||
          (w.avg_pace_sec === best.avg_pace_sec &&
           String(w.workout_date || '') > String(best.workout_date || ''))) {
        best = w;
      }
    }
    return best;
  }

  // The samples come in two shapes: the app's payload uses
  // [time, distance, strokes, spm, watts, hr, pace], the server's
  // get_workout uses [time, distance, spm, watts, hr, pace]. Both are
  // accepted, because both exist.
  function sampleFields(s) {
    if (Array.isArray(s)) {
      // Seven fields means the app's payload, six means the server's.
      if (s.length >= 7) {
        return { t: s[0], d: s[1], spm: s[3] };
      }
      return { t: s[0], d: s[1], spm: s[2] };
    }
    if (s && typeof s === 'object') {
      return { t: s.time, d: s.distance, spm: s.spm };
    }
    return null;
  }

  // The profile: the distance covered at each moment of the run, with
  // the stroke phase folded in.
  //
  // The phase is integrated from the stroke rate - a rower at 24 spm
  // completes a cycle every 2.5 s - so the ghost rows at its own pace
  // and is not in lockstep with the player. It is the difference
  // between a ghost and a twin.
  function buildProfile(samples, opts) {
    if (!samples || samples.length < 2) return null;
    opts = opts || {};

    var raw = [];
    for (var i = 0; i < samples.length; i++) {
      var f = sampleFields(samples[i]);
      if (!f || typeof f.t !== 'number' || !isFinite(f.t)) continue;
      if (typeof f.d !== 'number' || !isFinite(f.d)) f.d = 0;
      if (typeof f.spm !== 'number' || !isFinite(f.spm) || f.spm < 0) f.spm = 0;
      raw.push(f);
    }
    if (raw.length < 2) return null;

    // The phase at every sample, integrated from the stroke rate.
    var phase = 0;
    var lastT = raw[0].t;
    for (var j = 0; j < raw.length; j++) {
      if (j > 0) {
        var dt = Math.max(0, raw[j].t - lastT);
        phase += (raw[j].spm / 60) * dt;
        lastT = raw[j].t;
      }
      // Unwrapped: a counter that only goes up. A wrapped phase cannot
      // be interpolated - two samples a whole cycle apart both read 0,
      // and the stroke between them would be lost.
      raw[j].phase = phase;
    }

    // Thin the samples down to the profile's step.
    var step = opts.stepS || PROFILE_STEP_S;
    var points = [raw[0]];
    for (var k = 1; k < raw.length; k++) {
      if (raw[k].t - points[points.length - 1].t >= step) points.push(raw[k]);
    }
    if (points[points.length - 1] !== raw[raw.length - 1]) {
      points.push(raw[raw.length - 1]);
    }

    var last = points[points.length - 1];
    return {
      points: points,
      duration: last.t,
      distance: last.d,
      startTime: points[0].t
    };
  }

  // The distance the ghost has covered at time t. Before it starts,
  // nothing; after it finishes, its final distance.
  function distanceAt(profile, t) {
    if (!profile || !profile.points || !profile.points.length) return 0;
    var pts = profile.points;
    if (t <= pts[0].t) return pts[0].d;
    if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].d;

    // The points are sorted by time; find the bracket.
    var lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pts[mid].t <= t) lo = mid; else hi = mid;
    }
    var a = pts[lo], b = pts[hi];
    var span = b.t - a.t;
    var k = span > 0 ? (t - a.t) / span : 0;
    return a.d + (b.d - a.d) * k;
  }

  // The ghost's stroke phase at time t.
  function phaseAt(profile, t) {
    if (!profile || !profile.points || !profile.points.length) return 0;
    var pts = profile.points;
    if (t <= pts[0].t) return pts[0].phase || 0;
    if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].phase || 0;

    var lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pts[mid].t <= t) lo = mid; else hi = mid;
    }
    var a = pts[lo], b = pts[hi];
    var span = b.t - a.t;
    var k = span > 0 ? (t - a.t) / span : 0;
    // The phase is unwrapped in the profile, so this is a plain
    // interpolation; only the reading wraps.
    var v = (a.phase || 0) + ((b.phase || 0) - (a.phase || 0)) * k;
    return v - Math.floor(v);
  }

  // How far ahead (or behind) the ghost is, in metres. Positive means
  // the ghost is ahead of the player.
  function gapMetres(profile, t, playerDistance) {
    if (!profile) return null;
    var ghostDistance = distanceAt(profile, t);
    var player = typeof playerDistance === 'number' && isFinite(playerDistance)
      ? playerDistance
      : 0;
    return ghostDistance - player;
  }

  // The player's own distance at time t, from its samples.
  function playerDistanceAt(samples, t) {
    if (!samples || !samples.length) return 0;
    var pts = [];
    for (var i = 0; i < samples.length; i++) {
      var f = sampleFields(samples[i]);
      if (!f || typeof f.t !== 'number') continue;
      pts.push(f);
    }
    if (!pts.length) return 0;
    if (t <= pts[0].t) return pts[0].d || 0;
    var last = pts[pts.length - 1];
    if (t >= last.t) return last.d || 0;

    var lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pts[mid].t <= t) lo = mid; else hi = mid;
    }
    var a = pts[lo], b = pts[hi];
    var span = b.t - a.t;
    var k = span > 0 ? (t - a.t) / span : 0;
    return (a.d || 0) + ((b.d || 0) - (a.d || 0)) * k;
  }

  // The result of the race, when the session ends.
  //
  // The two runs are compared at the SAME elapsed time - the shorter of
  // the two - so nobody gets to row longer and still be ahead. The
  // returned gap is positive when the PLAYER is ahead.
  //
  // This is the ghost's payoff: on the water it only says something by
  // being where it is, but once the session is over the rower deserves
  // to know how it went.
  function finalGap(profile, samples) {
    if (!profile || !samples || !samples.length) return null;
    var last = sampleFields(samples[samples.length - 1]);
    if (!last || typeof last.t !== 'number') return null;
    var playerEnd = last.t;
    var ghostEnd = profile.duration;
    if (!(playerEnd > 0) || !(ghostEnd > 0)) return null;

    var at = Math.min(playerEnd, ghostEnd);
    var playerD = playerDistanceAt(samples, at);
    var ghostD = distanceAt(profile, at);
    return {
      gapM: Math.round(playerD - ghostD),
      at: Math.round(at),
      playerDistance: Math.round(playerD),
      ghostDistance: Math.round(ghostD),
      // The ghost's own run, for the record.
      ghostDuration: Math.round(ghostEnd),
      ghostDistanceTotal: Math.round(profile.distance)
    };
  }

  // The ghost is only worth drawing while it is running and while it is
  // near enough to be seen.
  function isVisible(profile, t, gapM, maxGap) {
    if (!profile) return false;
    if (t < profile.startTime) return false;
    if (t > profile.duration) return false;
    if (gapM === null || gapM === undefined) return false;
    return Math.abs(gapM) <= (maxGap || 400);
  }

  return {
    bestRun: bestRun,
    buildProfile: buildProfile,
    distanceAt: distanceAt,
    phaseAt: phaseAt,
    gapMetres: gapMetres,
    finalGap: finalGap,
    playerDistanceAt: playerDistanceAt,
    isVisible: isVisible,
    isCandidate: isCandidate,
    MIN_DISTANCE_M: MIN_DISTANCE_M,
    MIN_DURATION_S: MIN_DURATION_S,
    PROFILE_STEP_S: PROFILE_STEP_S
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Ghost;
}
