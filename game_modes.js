// =====================================================================
// game_modes.js - what the game layer is allowed to do.
//
// The game layer is not a religion: the rower decides what they want to
// see. Each piece of it can be switched on or off, and the switches live
// on the screen that waits for the first stroke - the screen that says
// "do not row yet", because a session always starts cold.
//
// Two rules make the switches worth having:
//
//   1. Off means off. A feature that is off is neither shown nor saved:
//      no score on the card, no koi mark, no ghost in the water. Nothing
//      half-on, where the game quietly counts something nobody can see.
//
//   2. A feature nobody has touched follows the mode: on while the
//      coaching talks, off in the calm mode. So the calm mode quiets the
//      game the way it always did, and leaving it brings the game back -
//      unless the rower has decided otherwise.
//
// The state is a plain object - { score: true|false|null, ... } - where
// null means "never touched". The storage is the caller's business.
//
// Pure module: no DOM, no network, no timers. See tests/game_modes.test.js
// for the contract, and docs/CONCEPT.md for why the switches are there.
// =====================================================================

var GameModes = (function () {
  'use strict';

  // The features, in the order the panel shows them.
  //
  // `key` is what is stored, `label` is what the switch says, `hint` is
  // the line under it - a switch nobody understands is a switch nobody
  // touches.
  //
  // The coaching mode is not in this list: it is the app's mode, it
  // already has its own button in the top bar, and it is stored under
  // its own key. It is what the untouched features follow.
  var FEATURES = [
    {
      key: 'score',
      label: 'SCORE',
      hint: 'the score, the chain ring and the lift bar'
    },
    {
      key: 'daily',
      label: 'DAILY PAR',
      hint: "today's par: the notch on the ring, the mark on the card"
    },
    {
      key: 'ghost',
      label: 'GHOST',
      hint: 'the ghost of your best run'
    },
    {
      key: 'dressing',
      label: 'DRESSING',
      hint: 'the livery, the kit, the theme of the hour, the land'
    },
    {
      key: 'koi',
      label: 'KOI',
      hint: 'the koi the push calls'
    }
  ];

  function keys() {
    var out = [];
    for (var i = 0; i < FEATURES.length; i++) out.push(FEATURES[i].key);
    return out;
  }

  function has(key) {
    return keys().indexOf(key) >= 0;
  }

  // A fresh state: nothing touched, so everything follows the mode.
  function empty() {
    var s = {};
    var ks = keys();
    for (var i = 0; i < ks.length; i++) s[ks[i]] = null;
    return s;
  }

  // What is actually on, right now.
  //
  // `justRow` is the calm mode: there, the game is off unless the
  // rower has explicitly asked for it. Everywhere else it is on unless
  // the rower has explicitly turned it off.
  function resolve(state, justRow) {
    var out = { justRow: !!justRow };
    var ks = keys();
    for (var i = 0; i < ks.length; i++) {
      var v = state ? state[ks[i]] : null;
      out[ks[i]] = (v === true || v === false) ? v : !justRow;
    }
    return out;
  }

  // An explicit choice. This is what survives: from here on, the mode
  // has no say about this feature.
  function set(state, key, on) {
    if (!state || !has(key)) return state;
    state[key] = !!on;
    return state;
  }

  // Storage. The raw string in, the state out, and a broken or partial
  // string never takes the game down: an unreadable state is an
  // untouched state.
  function parse(raw) {
    var s = empty();
    if (!raw) return s;
    var o = null;
    try { o = JSON.parse(raw); } catch (e) { return s; }
    if (!o || typeof o !== 'object') return s;
    var ks = keys();
    for (var i = 0; i < ks.length; i++) {
      if (o[ks[i]] === true || o[ks[i]] === false) s[ks[i]] = o[ks[i]];
    }
    return s;
  }

  // Only the explicit choices are written: "never touched" stays
  // "never touched", so the mode keeps the last word on it.
  function serialize(state) {
    var o = {};
    var ks = keys();
    for (var i = 0; i < ks.length; i++) {
      if (state && (state[ks[i]] === true || state[ks[i]] === false)) {
        o[ks[i]] = state[ks[i]];
      }
    }
    return JSON.stringify(o);
  }

  return {
    FEATURES: FEATURES,
    keys: keys,
    has: has,
    empty: empty,
    resolve: resolve,
    set: set,
    parse: parse,
    serialize: serialize
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GameModes;
}
