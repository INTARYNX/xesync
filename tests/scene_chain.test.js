// =====================================================================
// scene_chain.test.js - the scene's half of the game layer.
//
// The game layer has two halves that meet in the middle: run_score.js
// decides how well the rower is holding above their own pace, and
// rowing_display.js answers it by moving the world. controller.js passes
// the chain level from one to the other.
//
// These tests cover the junction - the level reaches the renderer, it is
// clamped, and a tier up gives the scene its short surge. What the shader
// does with it is covered by tests/e2e/shader.spec.js, which compiles the
// real GLSL.
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAnimation() {
  const sandbox = {
    window: { parent: { postMessage() {} } },
    document: {},
    performance: { now: () => 0 },
    requestAnimationFrame() {},
    cancelAnimationFrame() {},
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const file = path.join(__dirname, '..', 'rowing_display.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.RowingAnimation;
}

const RA = loadAnimation();

test('the chain level reaches the renderer', () => {
  RA.setChainLevel(0.7);
  assert.equal(RA._internals.chainLevel(), 0.7);
});

test('the chain level is clamped to what a level can be', () => {
  RA.setChainLevel(5);
  assert.equal(RA._internals.chainLevel(), 1);
  RA.setChainLevel(-2);
  assert.equal(RA._internals.chainLevel(), 0);
});

test('a level that is not a number is ignored, not trusted', () => {
  RA.setChainLevel('nope');
  assert.equal(RA._internals.chainLevel(), 0);
  RA.setChainLevel(NaN);
  assert.equal(RA._internals.chainLevel(), 0);
  RA.setChainLevel(undefined);
  assert.equal(RA._internals.chainLevel(), 0);
});

test('a tier up gives the scene its surge', () => {
  RA.pulseChain();
  assert.equal(RA._internals.chainPulse(), 1);
});

test('the scene moves faster with the chain, but not without limit', () => {
  const I = RA._internals;
  assert.ok(I.CHAIN_TIME_SCALE > 0, 'the world runs faster with the chain');
  assert.ok(I.CHAIN_TIME_SCALE < 1, 'but it never runs away');
  assert.ok(I.CHAIN_SCROLL_SCALE > 0, 'the scenery scrolls faster too');
  assert.ok(I.CHAIN_SCROLL_SCALE < 1);
  // A surge, not an earthquake.
  assert.ok(I.PULSE_S < 1, 'the pulse is short');
  assert.ok(I.PULSE_SCALE > 0 && I.PULSE_SCALE < 0.3, 'and discreet');
});
