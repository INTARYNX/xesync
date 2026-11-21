// =====================================================================
// game_modes.js - the three ways to row.
//
// The game layer is not something the rower has to accept, and the
// coaching is not either. There are three ways to row:
//
//   ALONE   - the measures, the water, and nothing else. No voice, no
//             game: the scene stays as it is, the hills stay round,
//             the boat wears the colours it had before there was a
//             dressing.
//
//   COACHED - the coaching talks - messages, milestones, the "sprint
//             X m" challenge - and the game plays with it. This is
//             what the app did before any of this.
//
//   THE RUN - the game plays, and says nothing. The chain still makes
//             the world move, the score still counts, the ghost is
//             still on the water and the koi still comes: none of it
//             is ever said.
//
// The rower chooses on the screen that waits for the first stroke, and
// the choice is the phone's own - a same-device preference, like the
// coaching mode it replaces.
//
// One value, not a list of switches: three ways to row, one of them
// chosen. A mode that says nothing more cannot be half-on.
//
// Pure module: no DOM, no network, no timers. See tests/game_modes.test.js
// for the contract, and docs/CONCEPT.md for why the modes are there.
// =====================================================================

var GameModes = (function () {
  'use strict';

  // The three ways to row, in the order they are offered.
  //
  // `label` is what the screen says, `hint` is the line under it - a
  // choice nobody understands is a choice nobody makes.
  //
  // `coaching` is the verbal layer, `game` the visual one. The pieces
  // of the game are not separate switches: they belong together, the
  // way a session belongs together.
  var MODES = [
    {
      key: 'alone',
      label: 'ALONE',
      hint: 'the measures, the water, and nothing else',
      coaching: false,
      game: false
    },
    {
      key: 'coached',
      label: 'COACHED',
      hint: 'the coaching talks, and the game plays with it',
      coaching: true,
      game: true
    },
    {
      key: 'run',
      label: 'THE RUN',
      hint: 'the game plays, and says nothing',
      coaching: false,
      game: true
    }
  ];

  // What the app does by default: the coaching and the game, the way
  // the app behaved before the modes existed.
  var DEFAULT = 'coached';

  function keys() {
    var out = [];
    for (var i = 0; i < MODES.length; i++) out.push(MODES[i].key);
    return out;
  }

  function has(key) {
    return keys().indexOf(key) >= 0;
  }

  function find(key) {
    for (var i = 0; i < MODES.length; i++) {
      if (MODES[i].key === key) return MODES[i];
    }
    return null;
  }

  // What is on, right now. The game comes as a whole: score, day's par,
  // ghost, dressing and koi. There is no half a game.
  function features(key) {
    var m = find(key) || find(DEFAULT);
    var game = !!m.game;
    return {
      coaching: !!m.coaching,
      score: game,
      daily: game,
      ghost: game,
      dressing: game,
      koi: game
    };
  }

  // The mode the app starts in.
  function defaultMode() { return DEFAULT; }

  // A mode that is not one of the three is not a mode: it reads as the
  // default, never as something broken.
  function parse(raw) {
    if (typeof raw === 'string' && has(raw)) return raw;
    return DEFAULT;
  }

  function serialize(key) {
    return has(key) ? key : DEFAULT;
  }

  return {
    MODES: MODES,
    DEFAULT: DEFAULT,
    keys: keys,
    has: has,
    find: find,
    features: features,
    defaultMode: defaultMode,
    parse: parse,
    serialize: serialize
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GameModes;
}
