// =====================================================================
// daily_course.js - the course of the day.
//
// Alto's Odyssey gives everyone the same challenge every day, and it
// works because it is short, common, and you can compare. This is that
// idea, adapted to a rowing app that has no programme and no target.
//
// What the day gives:
//
//   - CONDITIONS. The sky, the weather, the light: drawn from the local
//     date and hour, so everyone rowing at the same moment sees the same
//     scene. The shader already varies per day (u_day); this is what
//     feeds it.
//
//   - A PAR. One goal, on the game's own scale: the chain multiplier to
//     reach today, and how many pushes to land. Not a distance, not a
//     duration, not a pace - the vocabulary the game already speaks.
//
// What it is not:
//
//   - It is not a programme. Nothing is configured before you row.
//   - It is not an instruction. The app never says "reach x3". The par
//     is a mark on the ring, and if you miss it, nothing happens: no
//     message, no streak, no reminder tomorrow.
//   - It is not a ranking. The par is the same challenge for everyone,
//     but how you do against it is yours. The score stays personal.
//
// Pure module: no DOM, no network, no timers. The date goes in, the
// course comes out - the same course on every device, without a server.
// =====================================================================

var DailyCourse = (function () {
  'use strict';

  // The maximum multiplier the chain can reach (mirrors run_score.js).
  var MAX_MULTIPLIER = 6;

  // FNV-1a: a small, well-mixed hash. The same string gives the same
  // number on every device, which is the whole point - the course of a
  // given day must not depend on who computes it.
  function hashString(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // A small seeded generator, so a seed gives a whole series of draws
  // instead of one hash.
  function seeded(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // The local date, as YYYY-MM-DD. Local, not UTC: the course of a day
  // starts when the rower's day starts.
  function dateKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  // The date and the hour: the conditions change through the day.
  function hourKey(date) {
    return dateKey(date) + '-' + pad2(date.getHours());
  }

  // The course of a given moment.
  //
  // chainPar  the multiplier to reach today (2..4)
  // pushPar   how many pushes to land today (1..3)
  // dayIndex  the shader's day index: the day's weather, the same for
  //           everyone rowing at that hour
  function forDate(date) {
    var d = date || new Date();
    var key = dateKey(d);
    var seed = hashString(key);
    var rand = seeded(seed);

    // The chain par. Two is a warm-up's worth of effort; four asks for a
    // real push. The distribution is weighted towards three, which is
    // what the calibrated game can actually deliver in a session.
    var r = rand();
    var chainPar = r < 0.30 ? 2 : (r < 0.80 ? 3 : 4);
    var pushPar = 1 + Math.floor(rand() * 3);
    if (pushPar > MAX_MULTIPLIER - 1) pushPar = MAX_MULTIPLIER - 1;

    return {
      key: key,
      seed: seed,
      chainPar: chainPar,
      pushPar: pushPar,
      // The weather. Hashed from the hour, so the sky changes through
      // the day and everyone sees the same one.
      dayIndex: hashString(hourKey(d)) % 1000
    };
  }

  // The fraction of the ring the par's notch sits at. The ring fills
  // clockwise from three o'clock, and the chain runs from x1 to x6, so
  // the notch for a par of x3 is a third of the way round.
  function parFraction(par) {
    if (!par || par <= 1) return 0;
    var f = (par - 1) / (MAX_MULTIPLIER - 1);
    return Math.max(0, Math.min(1, f));
  }

  // Whether a run has met the course. Both parts count: the par is
  // reached when the chain got there AND the pushes landed.
  function isReached(course, state) {
    if (!course || !state) return false;
    var chain = (state.maxMultiplier || 1) >= course.chainPar;
    var pushes = (state.pushes || 0) >= course.pushPar;
    return chain && pushes;
  }

  return {
    forDate: forDate,
    parFraction: parFraction,
    isReached: isReached,
    dateKey: dateKey,
    hashString: hashString,
    MAX_MULTIPLIER: MAX_MULTIPLIER
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DailyCourse;
}
