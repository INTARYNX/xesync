// =====================================================================
// game_modes.test.js - the three ways to row.
//
// The game layer is optional, and so is the coaching. There are three
// ways to row, one of them is chosen, and the rules worth pinning are:
//
//   - the game comes as a whole: the score, the day's par, the ghost,
//     the dressing and the koi are never half-on;
//   - the default is what the app did before any of this: the coaching
//     and the game;
//   - a broken or unknown mode is not a mode: it reads as the default,
//     never as something broken.
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const GameModes = require('../game_modes.js');

const GAME = ['score', 'daily', 'ghost', 'dressing', 'koi'];

test('there are three ways to row', () => {
  assert.deepEqual(GameModes.keys(), ['justRow', 'coaching', 'play']);
  for (const m of GameModes.MODES) {
    assert.ok(m.label && m.label.length > 0, m.key + ' needs a label');
    assert.ok(m.hint && m.hint.length > 0, m.key + ' needs a hint');
  }
});

test('just row is the measures and nothing else', () => {
  const f = GameModes.features('justRow');
  assert.equal(f.coaching, false);
  for (const k of GAME) assert.equal(f[k], false, k + ' is off');
});

test('coaching is the coaching and the game', () => {
  const f = GameModes.features('coaching');
  assert.equal(f.coaching, true);
  for (const k of GAME) assert.equal(f[k], true, k + ' is on');
});

test('just play is the game, and says nothing', () => {
  const f = GameModes.features('play');
  assert.equal(f.coaching, false);
  for (const k of GAME) assert.equal(f[k], true, k + ' is on');
});

test('the game is never half-on', () => {
  for (const m of GameModes.MODES) {
    const f = GameModes.features(m.key);
    const on = GAME.filter((k) => f[k]);
    assert.ok(on.length === 0 || on.length === GAME.length,
      m.key + ' has a half-on game');
  }
});

test('the default is what the app did before the modes existed', () => {
  assert.equal(GameModes.defaultMode(), 'coaching');
  assert.equal(GameModes.features(GameModes.defaultMode()).coaching, true);
});

test('a mode that is not one of the three is not a mode', () => {
  for (const bad of ['', 'nope', 'JUST ROW', null, undefined, 42, {}]) {
    assert.equal(GameModes.parse(bad), 'coaching');
    assert.equal(GameModes.serialize(bad), 'coaching');
  }
  assert.equal(GameModes.parse('play'), 'play');
  assert.equal(GameModes.serialize('justRow'), 'justRow');
});

test('an unknown mode falls back on the default, not on nothing', () => {
  const f = GameModes.features('nope');
  assert.equal(f.coaching, true);
  for (const k of GAME) assert.equal(f[k], true, k + ' is on');
});
