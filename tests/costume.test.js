// =====================================================================
// costume.test.js - the dressing of the game.
//
// The livery is earned by coming back, not by being better than anyone,
// so the rules worth pinning are: it only ever moves forward, everyone
// reaches the same hulls at the same pace, and the boat's colours never
// change what a session is worth.
//
// The other thing worth pinning is that the first livery is the boat's
// own colours: the scene must look exactly as it did before there was a
// dressing at all.
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Costume = require('../costume.js');

function at(y, m, d, h) {
  return new Date(y, m - 1, d, h || 12, 0, 0, 0);
}

// The colours the scene used before the dressing existed. If these
// change, every boat in the app changes with them.
const ORIGINAL = {
  hullTop: [0.75, 0.92, 0.70],
  hullBottom: [0.30, 0.50, 0.30],
  shirt: [0.85, 0.20, 0.15],
  shorts: [0.15, 0.15, 0.18],
  cap: [0.10, 0.25, 0.55]
};

test('the first livery is the boat as it was', () => {
  const lv = Costume.livery(0);
  assert.equal(lv.key, 'club');
  assert.deepEqual(lv.hull[0], ORIGINAL.hullTop);
  assert.deepEqual(lv.hull[1], ORIGINAL.hullBottom);
  assert.deepEqual(lv.shirt, ORIGINAL.shirt);
  assert.deepEqual(lv.shorts, ORIGINAL.shorts);
  assert.deepEqual(lv.cap, ORIGINAL.cap);
});

test('the livery changes at the thresholds, and only there', () => {
  const key = (n) => Costume.livery(n).key;
  assert.equal(key(0), 'club');
  assert.equal(key(4), 'club');
  assert.equal(key(5), 'stripe');
  assert.equal(key(14), 'stripe');
  assert.equal(key(15), 'dawn');
  assert.equal(key(39), 'dawn');
  assert.equal(key(40), 'night');
  assert.equal(key(99), 'night');
  assert.equal(key(100), 'gold');
  assert.equal(key(1000), 'gold');
});

test('the livery only ever moves forward', () => {
  // The count can only grow, but the rule must hold even if it does
  // not: there is no way to lose a livery.
  let last = '';
  for (let n = 0; n <= 200; n++) {
    const key = Costume.livery(n).key;
    const index = Costume.LIVERIES.findIndex((l) => l.key === key);
    const previous = Costume.LIVERIES.findIndex((l) => l.key === last);
    assert.ok(index >= previous, `livery went backwards at ${n} sessions`);
    last = key;
  }
  // And a smaller count never gives a richer livery.
  assert.equal(Costume.livery(3).key, Costume.livery(3).key);
  assert.ok(Costume.LIVERIES.findIndex((l) => l.key === Costume.livery(3).key) <=
            Costume.LIVERIES.findIndex((l) => l.key === Costume.livery(50).key));
});

test('a count that makes no sense is treated as none', () => {
  for (const bad of [-1, NaN, Infinity, undefined, null, 'x']) {
    assert.equal(Costume.livery(bad).key, 'club');
  }
});

test('the livery is a copy: the catalogue cannot be changed from outside', () => {
  const lv = Costume.livery(5);
  lv.hull[0][0] = 0.99;
  lv.shirt[0] = 0.99;
  const again = Costume.livery(5);
  assert.notEqual(again.hull[0][0], 0.99);
  assert.notEqual(again.shirt[0], 0.99);
});

test('the land starts as the scene has always drawn it', () => {
  const bm = Costume.biome(0);
  assert.equal(bm.key, 'conifers');
  assert.deepEqual(bm.ridgeFar, [0.78, 0.55, 0.65]);
  assert.deepEqual(bm.ridgeNear, [0.22, 0.18, 0.30]);
  assert.deepEqual(bm.tree, [0.19, 0.16, 0.28]);
});

test('the land changes when the boat changes', () => {
  // One list of thresholds, two things that follow it: the livery and
  // the biome. A new boat is also a new place.
  const key = (n) => Costume.biome(n).key;
  assert.equal(key(0), 'conifers');
  assert.equal(key(4), 'conifers');
  assert.equal(key(5), 'clearing');
  assert.equal(key(14), 'clearing');
  assert.equal(key(15), 'autumn');
  assert.equal(key(39), 'autumn');
  assert.equal(key(40), 'snow');
  assert.equal(key(99), 'snow');
  assert.equal(key(100), 'gold');
  assert.equal(key(1000), 'gold');

  // And they never drift apart.
  for (const n of [0, 1, 4, 5, 9, 15, 30, 40, 77, 100, 250]) {
    assert.equal(Costume.biome(n).key, Costume.biome(n).key);
    const liveryIndex = Costume.LIVERIES.findIndex((l) => l.key === Costume.livery(n).key);
    const biomeIndex = Costume.BIOMES.findIndex((b) => b.key === Costume.biome(n).key);
    assert.equal(biomeIndex, liveryIndex,
      `at ${n} sessions the boat and the land must be at the same step`);
  }
});

test('the land only ever moves forward', () => {
  let last = '';
  for (let n = 0; n <= 200; n++) {
    const key = Costume.biome(n).key;
    const index = Costume.BIOMES.findIndex((b) => b.key === key);
    const previous = Costume.BIOMES.findIndex((b) => b.key === last);
    assert.ok(index >= previous, `the biome went backwards at ${n} sessions`);
    last = key;
  }
});

test('the forest is thicker in some places than in others', () => {
  // The density is part of the place: a clearing is thinner than a
  // forest. The first biome keeps the density the scene always had.
  assert.equal(Costume.biome(0).density, 0.30);
  for (const b of Costume.BIOMES) {
    assert.ok(typeof b.density === 'number');
    assert.ok(b.density >= 0 && b.density < 1);
  }
  // And the biome carries it.
  assert.equal(Costume.biome(40).density, Costume.BIOMES[3].density);
});

test('the land carries three colours, and only three', () => {
  const bm = Costume.biome(15);
  assert.equal(bm.ridgeFar.length, 3);
  assert.equal(bm.ridgeNear.length, 3);
  assert.equal(bm.tree.length, 3);
  for (const c of [bm.ridgeFar, bm.ridgeNear, bm.tree]) {
    for (const v of c) {
      assert.ok(typeof v === 'number' && isFinite(v));
      assert.ok(v >= 0 && v <= 1);
    }
  }
  // The far ridge is the pale one, the near one the deep one: that
  // gradient is what makes the distance read.
  for (const b of Costume.BIOMES) {
    const far = b.ridgeFar[0] * 0.3 + b.ridgeFar[1] * 0.5 + b.ridgeFar[2] * 0.2;
    const near = b.ridgeNear[0] * 0.3 + b.ridgeNear[1] * 0.5 + b.ridgeNear[2] * 0.2;
    assert.ok(far > near, `the ${b.key} biome has no depth`);
  }
});

test('the theme follows the course of the day', () => {
  const course = { dayIndex: 17 };
  assert.equal(Costume.theme(course).key, Costume.theme({ dayIndex: 17 }).key);
  // The day's index is the hour's hash, so two different hours can give
  // two different themes - but the same hour always gives the same one.
  assert.equal(Costume.theme({ dayIndex: 17 }).key, Costume.theme({ dayIndex: 17 }).key);
});

test('the theme is gentle', () => {
  // A theme that announced itself would be a scene, not a weather. Each
  // channel stays within a tenth of neutral.
  for (const course of [{ dayIndex: 0 }, { dayIndex: 1 }, { dayIndex: 2 },
                        { dayIndex: 3 }, { dayIndex: 999 }]) {
    const tint = Costume.theme(course).tint;
    assert.equal(tint.length, 3);
    for (const channel of tint) {
      assert.ok(channel > 0.85 && channel < 1.15,
        `the theme's channel ${channel} is too strong`);
    }
  }
});

test('a day with no course still gets a theme', () => {
  const t = Costume.theme(null);
  assert.ok(t.key);
  assert.equal(t.tint.length, 3);
});

test('the outfit carries everything the scene needs', () => {
  const outfit = Costume.outfit(15, { dayIndex: 4 });
  assert.equal(outfit.livery.key, 'dawn');
  assert.equal(outfit.theme.key, Costume.theme({ dayIndex: 4 }).key);
  // The shader reads six colours and a progress value.
  assert.equal(outfit.livery.hull.length, 2);
  for (const c of [outfit.livery.shirt, outfit.livery.shorts, outfit.livery.cap,
                   outfit.livery.hull[0], outfit.livery.hull[1], outfit.theme.tint]) {
    assert.equal(c.length, 3);
    for (const v of c) {
      assert.ok(typeof v === 'number' && isFinite(v));
      assert.ok(v >= 0 && v <= 1);
    }
  }
});

test('with the dressing off, the scene is the one before the dressing', () => {
  const plain = Costume.plain();
  // The boat's own colours, the first land, and no grade over the frame.
  assert.equal(plain.livery.key, 'club');
  assert.equal(plain.biome.key, 'conifers');
  assert.deepEqual(plain.theme.tint, [1, 1, 1], 'no grade at all');
  assert.deepEqual(plain.livery.hull[0], ORIGINAL.hullTop);
  // And it does not depend on the history or the hour: the same scene,
  // whatever the rower has done.
  assert.deepEqual(Costume.plain(), Costume.plain());
});

test('the game says when the livery changed, and only then', () => {
  assert.equal(Costume.changed({ key: 'club' }, { key: 'club' }), false);
  assert.equal(Costume.changed({ key: 'club' }, { key: 'stripe' }), true);
  // Nothing to compare against: nothing to announce.
  assert.equal(Costume.changed(null, { key: 'club' }), false);
  assert.equal(Costume.changed({ key: 'club' }, null), false);
});

test('every livery looks like a boat and a rower', () => {
  for (const l of Costume.LIVERIES) {
    assert.ok(l.key && l.name, 'a livery needs a key and a name');
    assert.ok(typeof l.at === 'number' && l.at >= 0);
    assert.equal(l.hull.length, 2);
    for (const c of [l.shirt, l.shorts, l.cap, l.hull[0], l.hull[1]]) {
      assert.equal(c.length, 3);
    }
  }
  // The thresholds are strictly increasing, so each livery is reached
  // at its own moment.
  for (let i = 1; i < Costume.LIVERIES.length; i++) {
    assert.ok(Costume.LIVERIES[i].at > Costume.LIVERIES[i - 1].at);
  }
});
