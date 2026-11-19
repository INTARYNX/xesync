// =====================================================================
// ghost.test.js - the ghost of your own best run.
//
// Pure module, no browser: the profile is built from the samples, the
// ghost is placed at the same elapsed time as the player, and it rows
// at its own pace.
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Ghost = require('../ghost.js');

// The app's payload shape: [time, distance, strokes, spm, watts, hr, pace]
function appSamples(points) {
  return points.map((p) => [p[0], p[1], Math.round(p[0] * 0.4), p[2], 180, null, 120]);
}

// The server's get_workout shape: [time, distance, spm, watts, hr, pace]
function serverSamples(points) {
  return points.map((p) => [p[0], p[1], p[2], 180, null, 120]);
}

test('the best run is the fastest one long enough to be a session', () => {
  const workouts = [
    { workout_id: 'a', distance_m: 5000, duration_sec: 1200, avg_pace_sec: 110 },
    { workout_id: 'b', distance_m: 5200, duration_sec: 1250, avg_pace_sec: 105 },
    { workout_id: 'c', distance_m: 100, duration_sec: 40, avg_pace_sec: 90 }
  ];
  const best = Ghost.bestRun(workouts);
  assert.equal(best.workout_id, 'b', 'c is too short to be a ghost');
});

test('a run that is too short, or has no pace, is not a ghost', () => {
  assert.equal(Ghost.bestRun([]), null);
  assert.equal(Ghost.bestRun(null), null);
  assert.equal(Ghost.isCandidate({ distance_m: 900, duration_sec: 600, avg_pace_sec: 100 }), false);
  assert.equal(Ghost.isCandidate({ distance_m: 5000, duration_sec: 100, avg_pace_sec: 100 }), false);
  assert.equal(Ghost.isCandidate({ distance_m: 5000, duration_sec: 600, avg_pace_sec: 0 }), false);
  assert.equal(Ghost.isCandidate({ distance_m: 5000, duration_sec: 600, avg_pace_sec: 100 }), true);
});

test('the profile is built from either sample shape', () => {
  const points = [[0, 0, 20], [10, 50, 22], [20, 105, 24], [30, 165, 24]];
  const fromApp = Ghost.buildProfile(appSamples(points));
  const fromServer = Ghost.buildProfile(serverSamples(points));

  assert.equal(fromApp.duration, 30);
  assert.equal(fromApp.distance, 165);
  assert.equal(fromServer.distance, 165);
  assert.equal(Ghost.distanceAt(fromApp, 20), 105);
  assert.equal(Ghost.distanceAt(fromServer, 20), 105);
});

test('the profile interpolates between the points', () => {
  const profile = Ghost.buildProfile(serverSamples([
    [0, 0, 20], [10, 50, 20], [20, 100, 20]
  ]));
  assert.equal(Ghost.distanceAt(profile, 5), 25);
  assert.equal(Ghost.distanceAt(profile, 15), 75);
  // Before the start and after the end, the edges.
  assert.equal(Ghost.distanceAt(profile, -5), 0);
  assert.equal(Ghost.distanceAt(profile, 999), 100);
});

test('the ghost rows at its own pace, not in lockstep', () => {
  // 20 spm is a cycle every 3 s. After 3 s the ghost has completed one
  // cycle and is back where it started.
  const profile = Ghost.buildProfile(serverSamples([
    [0, 0, 20], [3, 20, 20], [6, 40, 20], [9, 60, 20]
  ]));
  const at3 = Ghost.phaseAt(profile, 3);
  assert.ok(Math.abs(at3 - 0) < 0.01 || Math.abs(at3 - 1) < 0.01,
    `one full cycle should bring the phase back (${at3})`);
  const at1 = Ghost.phaseAt(profile, 1);
  assert.ok(Math.abs(at1 - 1 / 3) < 0.05,
    `a third of a cycle after one second (${at1})`);
});

test('the gap is measured at the same elapsed time', () => {
  const profile = Ghost.buildProfile(serverSamples([
    [0, 0, 24], [60, 300, 24], [120, 600, 24]
  ]));
  // At one minute the ghost has covered 300 m. The player, at 250 m,
  // is 50 m behind.
  assert.equal(Ghost.gapMetres(profile, 60, 250), 50);
  // Ahead: the player has done 350 m, the ghost is 50 m back.
  assert.equal(Ghost.gapMetres(profile, 60, 350), -50);
});

test('the ghost is only drawn while it is running and near enough', () => {
  const profile = Ghost.buildProfile(serverSamples([
    [0, 0, 24], [60, 300, 24], [120, 600, 24]
  ]));
  assert.equal(Ghost.isVisible(profile, 30, 0, 400), true);
  assert.equal(Ghost.isVisible(profile, -1, 0, 400), false, 'before it starts');
  assert.equal(Ghost.isVisible(profile, 500, 0, 400), false, 'after it finishes');
  assert.equal(Ghost.isVisible(profile, 30, 900, 400), false, 'too far to see');
  assert.equal(Ghost.isVisible(null, 30, 0, 400), false);
});

test('the race is settled at the same elapsed time for both', () => {
  // The ghost rows 600 m in the first minute and stops.
  const profile = Ghost.buildProfile(serverSamples([
    [0, 0, 24], [30, 300, 24], [60, 600, 24]
  ]));
  // The player rows 500 m in that minute and keeps going for another
  // two. The comparison is settled at the ghost's end - the player does
  // not get to row longer and still be ahead.
  const player = serverSamples([
    [0, 0, 24], [30, 250, 24], [60, 500, 24], [180, 1200, 24]
  ]);
  const result = Ghost.finalGap(profile, player);
  assert.equal(result.at, 60, 'settled at the shorter of the two runs');
  assert.equal(result.gapM, -100, 'the ghost was 100 m ahead');
});

test('a session that outrows the ghost is ahead', () => {
  const profile = Ghost.buildProfile(serverSamples([
    [0, 0, 24], [60, 600, 24]
  ]));
  const player = serverSamples([
    [0, 0, 24], [60, 660, 24]
  ]);
  const result = Ghost.finalGap(profile, player);
  assert.equal(result.gapM, 60);
  assert.equal(result.ghostDistance, 600);
  assert.equal(result.playerDistance, 660);
});

test('without a ghost, there is no result', () => {
  assert.equal(Ghost.finalGap(null, [[0, 0, 24]]), null);
  assert.equal(Ghost.finalGap(Ghost.buildProfile(serverSamples([[0, 0, 24], [10, 50, 24]])), []), null);
});

test('a profile that cannot be built is null, not a broken one', () => {
  assert.equal(Ghost.buildProfile(null), null);
  assert.equal(Ghost.buildProfile([]), null);
  assert.equal(Ghost.buildProfile([[0, 0, 20]]), null);
});
