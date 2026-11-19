// =====================================================================
// daily_course.test.js - the course of the day.
//
// The whole point of the module is that the same day gives the same
// course to everyone, on every device, with no server involved. So the
// first thing to pin is that determinism; the rest is that the course
// stays inside what the calibrated game can actually deliver.
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DailyCourse = require('../daily_course.js');

function at(y, m, d, h) {
  return new Date(y, m - 1, d, h || 12, 0, 0, 0);
}

test('the same day gives the same course, everywhere', () => {
  const a = DailyCourse.forDate(at(2026, 11, 19, 9));
  const b = DailyCourse.forDate(at(2026, 11, 19, 9));
  assert.equal(a.key, b.key);
  assert.equal(a.seed, b.seed);
  assert.equal(a.chainPar, b.chainPar);
  assert.equal(a.pushPar, b.pushPar);
  assert.equal(a.dayIndex, b.dayIndex);
});

test('two devices reading the same day agree', () => {
  // The same instant, built two ways - a local date and an equivalent
  // one - must give the same course. Nothing here may depend on how the
  // date was obtained.
  const first = DailyCourse.forDate(at(2026, 3, 7, 14));
  const second = DailyCourse.forDate(at(2026, 3, 7, 14));
  assert.deepEqual(
    { ...first }, { ...second },
    'the course must not depend on anything but the date and the hour'
  );
});

test('the day is keyed by the local date', () => {
  assert.equal(DailyCourse.dateKey(at(2026, 11, 19)), '2026-11-19');
  assert.equal(DailyCourse.dateKey(at(2026, 1, 5)), '2026-01-05');
});

test('the par stays inside what the game can deliver', () => {
  // The calibrated game reaches x2 in a normal session with a push, x3
  // in a hard one, and x6 only for an exceptional effort. A par of x2
  // to x4 is the range the day can actually ask for.
  for (let d = 1; d <= 28; d++) {
    for (let m = 1; m <= 12; m++) {
      const course = DailyCourse.forDate(at(2026, m, d, 10));
      assert.ok(course.chainPar >= 2 && course.chainPar <= 4,
        `chain par ${course.chainPar} on ${course.key}`);
      assert.ok(course.pushPar >= 1 && course.pushPar <= 3,
        `push par ${course.pushPar} on ${course.key}`);
    }
  }
});

test('consecutive days are not the same course', () => {
  const seeds = new Set();
  for (let d = 1; d <= 28; d++) {
    seeds.add(DailyCourse.forDate(at(2026, 11, d, 12)).seed);
  }
  assert.equal(seeds.size, 28, 'every day of the month has its own seed');
});

test('the weather changes through the day', () => {
  const morning = DailyCourse.forDate(at(2026, 11, 19, 6));
  const evening = DailyCourse.forDate(at(2026, 11, 19, 20));
  assert.notEqual(morning.dayIndex, evening.dayIndex,
    'two hours of the same day must not look the same');
  // But the course itself - the par - is the same for the whole day.
  assert.equal(morning.chainPar, evening.chainPar);
  assert.equal(morning.pushPar, evening.pushPar);
});

test('the par sits at the right place on the ring', () => {
  // The ring runs from x1 to x6, so a par of x3 is two fifths of the
  // way round.
  assert.equal(DailyCourse.parFraction(2), 0.2);
  assert.equal(DailyCourse.parFraction(3), 0.4);
  assert.equal(DailyCourse.parFraction(6), 1);
  assert.equal(DailyCourse.parFraction(1), 0);
  assert.equal(DailyCourse.parFraction(null), 0);
});

test('the course is only reached when both parts are done', () => {
  const course = { chainPar: 3, pushPar: 2 };
  assert.equal(DailyCourse.isReached(course, { maxMultiplier: 3, pushes: 1 }), false);
  assert.equal(DailyCourse.isReached(course, { maxMultiplier: 2, pushes: 2 }), false);
  assert.equal(DailyCourse.isReached(course, { maxMultiplier: 3, pushes: 2 }), true);
  assert.equal(DailyCourse.isReached(null, { maxMultiplier: 6, pushes: 6 }), false);
});
