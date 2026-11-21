// =====================================================================
// costume.js - the livery of the boat, the kit of the rower, and the
// theme of the scene.
//
// Lot 4: the game gets dressed.
//
// Three families, one rule each:
//
//   THE LIVERY (the hull) and THE KIT (the rower) come from how many
//   sessions the rower has done. A livery is earned by coming back, not
//   by being better than anyone: a recreational rower and a training
//   rower reach the same hulls at the same pace.
//
//   THE THEME comes from the course of the day, so the whole frame
//   wears the weather of the hour - the same for everyone rowing at
//   that moment.
//
// What it is not:
//
//   - It is not a shop. Nothing is bought, nothing is configured, there
//     is no menu of costumes. The boat wears what the history earned
//     it, and the rower wears what goes with it.
//
//   - It is not a progress bar. The app never says "two sessions to the
//     racing stripe": that would be an instruction, and the game does
//     not give instructions. The livery simply changes, and the scene
//     shows it.
//
//   - It is not a score. Nothing here can be better or worse. It cannot
//     be lost, it never changes what a session is worth, and it never
//     compares two people.
//
// The first livery is the boat's own colours: the scene looks exactly
// as it did before there was a dressing at all.
//
// Pure module: no DOM, no network, no timers. The count goes in, the
// outfit comes out.
// =====================================================================

var Costume = (function () {
  'use strict';

  // -------------------------------------------------------------------
  // The liveries, in the order they are earned.
  //
  // `at` is the number of sessions the rower has done. The thresholds
  // are spaced so that a rower who comes back a few times a week sees
  // the boat change every few weeks - often enough to feel it, rare
  // enough to still be an event.
  //
  // The colours are the ones the scene already used for the boat, the
  // jersey, the shorts and the cap: the club livery is the scene as it
  // was, and every other livery is a recolouring of the same shapes.
  // -------------------------------------------------------------------
  var LIVERIES = [
    {
      key: 'club',
      at: 0,
      name: 'the club colours',
      hull: [[0.75, 0.92, 0.70], [0.30, 0.50, 0.30]],
      shirt: [0.85, 0.20, 0.15],
      shorts: [0.15, 0.15, 0.18],
      cap: [0.10, 0.25, 0.55]
    },
    {
      key: 'stripe',
      at: 5,
      name: 'the racing stripe',
      hull: [[0.95, 0.95, 0.93], [0.16, 0.32, 0.62]],
      shirt: [0.16, 0.32, 0.62],
      shorts: [0.93, 0.93, 0.90],
      cap: [0.93, 0.93, 0.90]
    },
    {
      key: 'dawn',
      at: 15,
      name: 'the dawn varnish',
      hull: [[1.00, 0.78, 0.42], [0.62, 0.28, 0.24]],
      shirt: [0.96, 0.90, 0.78],
      shorts: [0.45, 0.32, 0.28],
      cap: [0.20, 0.22, 0.30]
    },
    {
      key: 'night',
      at: 40,
      name: 'the night varnish',
      hull: [[0.38, 0.44, 0.78], [0.12, 0.14, 0.34]],
      shirt: [0.10, 0.12, 0.20],
      shorts: [0.55, 0.58, 0.70],
      cap: [0.85, 0.88, 0.95]
    },
    {
      key: 'gold',
      at: 100,
      name: 'the golden hull',
      hull: [[1.00, 0.88, 0.45], [0.66, 0.42, 0.10]],
      shirt: [0.98, 0.96, 0.90],
      shorts: [0.18, 0.18, 0.22],
      cap: [0.85, 0.62, 0.16]
    }
  ];

  // -------------------------------------------------------------------
  // The biomes: what the land looks like.
  //
  // The same progression as the liveries, and on purpose: the boat and
  // the world it crosses change together, so a new livery is also a new
  // place. Each biome gives the two ends of the ridge - the far haze
  // and the near band - and the pines that stand on it.
  //
  // The first biome is the one the scene has always had.
  // -------------------------------------------------------------------
  var BIOMES = [
    {
      key: 'conifers',
      name: 'the conifers',
      ridgeFar: [0.78, 0.55, 0.65],
      ridgeNear: [0.22, 0.18, 0.30],
      tree: [0.19, 0.16, 0.28],
      density: 0.30
    },
    {
      key: 'clearing',
      name: 'the clearing',
      ridgeFar: [0.84, 0.74, 0.60],
      ridgeNear: [0.19, 0.26, 0.22],
      tree: [0.13, 0.24, 0.16],
      density: 0.48
    },
    {
      key: 'autumn',
      name: 'the autumn',
      ridgeFar: [0.88, 0.64, 0.40],
      ridgeNear: [0.30, 0.18, 0.20],
      tree: [0.34, 0.19, 0.13],
      density: 0.28
    },
    {
      key: 'snow',
      name: 'the snow',
      ridgeFar: [0.84, 0.88, 0.96],
      ridgeNear: [0.24, 0.29, 0.38],
      tree: [0.11, 0.16, 0.24],
      density: 0.58
    },
    {
      key: 'gold',
      name: 'the golden coast',
      ridgeFar: [0.93, 0.80, 0.50],
      ridgeNear: [0.31, 0.23, 0.25],
      tree: [0.22, 0.19, 0.28],
      density: 0.22
    }
  ];

  // -------------------------------------------------------------------
  // The themes: a grade laid over the whole frame, the way a film is
  // graded. They come from the course of the day, so the scene's mood
  // follows the same hour the par comes from.
  //
  // They are deliberately gentle - a few percent each way. A theme that
  // announced itself would be a scene, not a weather.
  // -------------------------------------------------------------------
  var THEMES = [
    { key: 'clear', name: 'a clear sky',  tint: [1.00, 1.00, 1.00] },
    { key: 'cold',  name: 'a cold morning', tint: [0.92, 0.97, 1.07] },
    { key: 'warm',  name: 'a warm afternoon', tint: [1.07, 0.99, 0.90] },
    { key: 'haze',  name: 'a hazy noon',   tint: [1.02, 0.99, 0.99] }
  ];

  function clampInt(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  // The livery the history has earned. The count only ever goes up, so
  // the livery only ever moves forward: there is no way to lose it.
  function livery(sessions) {
    var n = clampInt(sessions);
    var found = LIVERIES[0];
    for (var i = 0; i < LIVERIES.length; i++) {
      if (n >= LIVERIES[i].at) found = LIVERIES[i];
      else break;
    }
    return {
      key: found.key,
      name: found.name,
      at: found.at,
      hull: [[found.hull[0][0], found.hull[0][1], found.hull[0][2]],
             [found.hull[1][0], found.hull[1][1], found.hull[1][2]]],
      shirt: [found.shirt[0], found.shirt[1], found.shirt[2]],
      shorts: [found.shorts[0], found.shorts[1], found.shorts[2]],
      cap: [found.cap[0], found.cap[1], found.cap[2]]
    };
  }

  // The theme of the moment. It follows the course of the day, so two
  // people rowing at the same hour wear the same weather.
  function theme(course) {
    var index = course && typeof course.dayIndex === 'number' && isFinite(course.dayIndex)
      ? Math.floor(course.dayIndex) % THEMES.length
      : 0;
    if (index < 0) index += THEMES.length;
    var t = THEMES[index];
    return {
      key: t.key,
      name: t.name,
      tint: [t.tint[0], t.tint[1], t.tint[2]]
    };
  }

  // The biome the history has earned. It follows the livery exactly -
  // the boat and the land change at the same moment, and there is only
  // one list of thresholds to keep straight.
  function biome(sessions) {
    var n = clampInt(sessions);
    var index = 0;
    for (var i = 0; i < LIVERIES.length; i++) {
      if (n >= LIVERIES[i].at) index = i;
      else break;
    }
    var b = BIOMES[index] || BIOMES[0];
    return {
      key: b.key,
      name: b.name,
      ridgeFar: [b.ridgeFar[0], b.ridgeFar[1], b.ridgeFar[2]],
      ridgeNear: [b.ridgeNear[0], b.ridgeNear[1], b.ridgeNear[2]],
      tree: [b.tree[0], b.tree[1], b.tree[2]],
      density: typeof b.density === 'number' ? b.density : 0.3
    };
  }

  // The whole outfit: what the boat wears, what the land looks like,
  // and the grade over the frame.
  function outfit(sessions, course) {
    return {
      livery: livery(sessions),
      biome: biome(sessions),
      theme: theme(course)
    };
  }

  // The scene as it was before there was a dressing at all: the boat's
  // own colours, the first land, and no grade over the frame. This is
  // what the rower gets when the dressing is switched off
  // (game_modes.js) - the scene exactly as it was, not a poorer one.
  function plain() {
    return {
      livery: LIVERIES[0],
      biome: BIOMES[0],
      theme: THEMES[0]
    };
  }

  // Whether two liveries are different outfits, and so whether the
  // scene has something to show: a sweep of light along the hull, the
  // only thing the game ever announces by itself.
  function changed(previous, next) {
    if (!previous || !next) return false;
    return previous.key !== next.key;
  }

  return {
    livery: livery,
    biome: biome,
    theme: theme,
    outfit: outfit,
    plain: plain,
    changed: changed,
    LIVERIES: LIVERIES,
    BIOMES: BIOMES,
    THEMES: THEMES
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Costume;
}
