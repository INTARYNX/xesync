// =====================================================================
// game_modes.test.js - the switches of the game layer.
//
// The game layer is optional: the rower decides what they want. The
// rules worth pinning are the two the switches promise:
//
//   - off means off: a feature the rower turned off is off, whatever
//     the mode says;
//   - a feature nobody touched follows the mode, so the calm mode
//     still quiets the game the way it always did.
//
// And the storage has to be forgiving: a broken or half-written state
// must never take the app down - it reads as "never touched".
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const GameModes = require('../game_modes.js');

const ALL = ['score', 'daily', 'ghost', 'dressing', 'koi'];

test('the switches cover the whole game layer', () => {
  assert.deepEqual(GameModes.keys(), ALL);
  // A switch nobody understands is a switch nobody touches.
  for (const f of GameModes.FEATURES) {
    assert.ok(f.label && f.label.length > 0, f.key + ' needs a label');
    assert.ok(f.hint && f.hint.length > 0, f.key + ' needs a hint');
  }
});

test('a fresh state follows the mode: on in coaching, off in the calm mode', () => {
  const s = GameModes.empty();
  const on = GameModes.resolve(s, false);
  const off = GameModes.resolve(s, true);
  for (const k of ALL) {
    assert.equal(on[k], true, k + ' is on while the coaching talks');
    assert.equal(off[k], false, k + ' is off in the calm mode');
  }
});

test('an explicit choice outlives the mode', () => {
  const s = GameModes.empty();

  // Off in the calm mode, and it stays off when the coaching comes back.
  GameModes.set(s, 'ghost', false);
  assert.equal(GameModes.resolve(s, true).ghost, false);
  assert.equal(GameModes.resolve(s, false).ghost, false);

  // On in the calm mode, and it stays on.
  const t = GameModes.empty();
  GameModes.set(t, 'koi', true);
  assert.equal(GameModes.resolve(t, true).koi, true);
  assert.equal(GameModes.resolve(t, false).koi, true);
});

test('setting an unknown switch changes nothing', () => {
  const s = GameModes.empty();
  GameModes.set(s, 'nope', true);
  assert.equal(s.nope, undefined);
  assert.deepEqual(Object.keys(s).sort(), ALL.slice().sort());
});

test('only true and false are choices', () => {
  const s = GameModes.parse('{"score":true,"daily":false,"ghost":"yes","dressing":1,"koi":null}');
  assert.equal(s.score, true);
  assert.equal(s.daily, false);
  assert.equal(s.ghost, null, 'a string is not a choice');
  assert.equal(s.dressing, null, 'a number is not a choice');
  assert.equal(s.koi, null, 'null stays untouched');
});

test('a broken state reads as an untouched state', () => {
  for (const raw of ['', 'not json', '{', '[]', '"a string"', '42', 'null']) {
    const s = GameModes.parse(raw);
    assert.deepEqual(Object.keys(s).sort(), ALL.slice().sort());
    for (const k of ALL) assert.equal(s[k], null, k + ' stays untouched');
    // And an untouched state is simply the mode's default.
    assert.equal(GameModes.resolve(s, false).score, true);
    assert.equal(GameModes.resolve(s, true).score, false);
  }
});

test('only the explicit choices are written', () => {
  const s = GameModes.empty();
  GameModes.set(s, 'score', false);
  GameModes.set(s, 'koi', true);
  const raw = GameModes.serialize(s);
  assert.deepEqual(JSON.parse(raw), { score: false, koi: true });
});

test('the state survives a round trip through storage', () => {
  const s = GameModes.empty();
  GameModes.set(s, 'daily', false);
  GameModes.set(s, 'dressing', true);
  const back = GameModes.parse(GameModes.serialize(s));
  assert.deepEqual(back, s);
});
