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
  assert.deepEqual(GameModes.keys(), ['alone', 'coached', 'run']);
  for (const m of GameModes.MODES) {
    assert.ok(m.label && m.label.length > 0, m.key + ' needs a label');
    assert.ok(m.hint && m.hint.length > 0, m.key + ' needs a hint');
  }
});

test('alone is the measures and nothing else', () => {
  const f = GameModes.features('alone');
  assert.equal(f.coaching, false);
  for (const k of GAME) assert.equal(f[k], false, k + ' is off');
});

test('coached is the coaching and the game', () => {
  const f = GameModes.features('coached');
  assert.equal(f.coaching, true);
  for (const k of GAME) assert.equal(f[k], true, k + ' is on');
});

test('the run is the game, and says nothing', () => {
  const f = GameModes.features('run');
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
  assert.equal(GameModes.defaultMode(), 'coached');
  assert.equal(GameModes.features(GameModes.defaultMode()).coaching, true);
});

test('a mode that is not one of the three is not a mode', () => {
  for (const bad of ['', 'nope', 'JUST ROW', null, undefined, 42, {}]) {
    assert.equal(GameModes.parse(bad), 'coached');
    assert.equal(GameModes.serialize(bad), 'coached');
  }
  assert.equal(GameModes.parse('run'), 'run');
  assert.equal(GameModes.serialize('alone'), 'alone');
});

test('an unknown mode falls back on the default, not on nothing', () => {
  const f = GameModes.features('nope');
  assert.equal(f.coaching, true);
  for (const k of GAME) assert.equal(f[k], true, k + ' is on');
});
