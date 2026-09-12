// =====================================================================
// coaching.test.js - encouragement / milestone / mini-challenge rules.
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// coaching.js has no DOM/network/clock dependency at all - a bare sandbox
// with a `window` stub is enough, unlike ftms_integration.js's harness.
function loadCoaching() {
  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'coaching.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'coaching.js' });
  return sandbox.Coaching;
}

// ---------------------------------------------------------------------
// Just Row mode
// ---------------------------------------------------------------------
test('Just Row mode produces no messages and no journal entries', () => {
  const Coaching = loadCoaching();
  Coaching.setMode('justRow');
  let sawEvent = false;
  let distance = 0;
  for (let t = 1; t <= 300; t++) {
    distance += 3;
    const evt = Coaching.tick({ activeSeconds: t, distance, spm: 24, watts: 150 });
    if (evt) sawEvent = true;
  }
  assert.equal(sawEvent, false);
  assert.equal(Coaching.getSessionEvents().length, 0);
});

// ---------------------------------------------------------------------
// Cadence-boost challenge adapts its reference to the person's own recent
// cadence, but success requires actually pushing above it (feedback: just
// continuing your current cadence must never count as "success").
// ---------------------------------------------------------------------
function cadenceChallengeSuccessCase(baselineSpm) {
  const Coaching = loadCoaching();
  const ANNOUNCE_S = Coaching._internals.CADENCE_ANNOUNCE_S;
  const BOOST = Coaching._internals.CADENCE_BOOST_SPM;
  let startEvt = null;
  // Freeze distance during setup so tryStartDistanceChallenge (tried first)
  // finds dd<=0 and falls through to the cadence challenge - isolates the
  // cadence math from the challenge-type alternation.
  for (let t = 1; t <= 120; t++) {
    const evt = Coaching.tick({ activeSeconds: t, distance: 0, spm: baselineSpm, watts: 150 });
    if (evt && evt.type === 'challenge_started') startEvt = evt;
  }
  assert.ok(startEvt, 'a challenge should have started at the 2-minute mark');
  const challenge = Coaching.getChallenge();
  assert.equal(challenge.kind, 'cadence');
  assert.equal(challenge.phase, 'announce');
  assert.equal(challenge.reference, baselineSpm);
  assert.equal(challenge.targetSpm, baselineSpm + BOOST);

  // Merely holding the baseline cadence must NOT accumulate any in-range
  // time during the announce countdown or beyond.
  const pushedSpm = baselineSpm + BOOST;

  // Announce countdown, then the 30s scoring window - pushed above baseline.
  let endEvt = null;
  let distance = 0;
  for (let i = 1; i <= ANNOUNCE_S + 30 + 2 && !endEvt; i++) {
    distance += 3;
    const evt = Coaching.tick({ activeSeconds: 120 + i, distance, spm: pushedSpm, watts: 150 });
    if (evt && evt.type === 'challenge_ended') endEvt = evt;
  }
  assert.ok(endEvt);
  assert.equal(endEvt.textKey, 'cadenceChallengeSuccess');
  const journal = Coaching.getSessionEvents().filter((e) => e.type === 'challenge');
  assert.equal(journal.length, 1);
  assert.equal(journal[0].outcome, 'success');
  assert.equal(journal[0].reference, baselineSpm);
  assert.equal(journal[0].targetSpm, baselineSpm + BOOST);
}

test('holding the baseline cadence (no push) never succeeds the challenge', () => {
  const Coaching = loadCoaching();
  const ANNOUNCE_S = Coaching._internals.CADENCE_ANNOUNCE_S;
  const baselineSpm = 20;
  for (let t = 1; t <= 120; t++) Coaching.tick({ activeSeconds: t, distance: 0, spm: baselineSpm, watts: 150 });
  assert.ok(Coaching.getChallenge(), 'a challenge should have started');

  let endEvt = null;
  for (let i = 1; i <= ANNOUNCE_S + 30 + 2 && !endEvt; i++) {
    // Same cadence as the recent baseline the whole time - never pushes higher.
    const evt = Coaching.tick({ activeSeconds: 120 + i, distance: 0, spm: baselineSpm, watts: 150 });
    if (evt && evt.type === 'challenge_ended') endEvt = evt;
  }
  assert.ok(endEvt);
  assert.equal(endEvt.textKey, 'cadenceChallengeNeutral', 'no real push means no success, ever');
});

test('cadence challenge adapts its range to an 18 spm baseline', () => cadenceChallengeSuccessCase(18));
test('cadence challenge adapts its range to a 28 spm baseline', () => cadenceChallengeSuccessCase(28));

// ---------------------------------------------------------------------
// Distance-goal challenge ("fais un X m")
// ---------------------------------------------------------------------
test('distance challenge proposes a capped target and completes it', () => {
  const Coaching = loadCoaching();
  let distance = 0;
  let startEvt = null;
  for (let t = 1; t <= 120; t++) {
    distance += 3; // steady 3 m/s
    const evt = Coaching.tick({ activeSeconds: t, distance, spm: 24, watts: 150 });
    if (evt && evt.type === 'challenge_started') startEvt = evt;
  }
  assert.ok(startEvt);
  const challenge = Coaching.getChallenge();
  assert.equal(challenge.kind, 'distance');
  assert.equal(challenge.phase, 'announce');
  assert.ok(challenge.target >= 300 && challenge.target <= 3000);

  let endEvt = null;
  let t = 120;
  while (!endEvt && t < 120 + 600) {
    t++;
    distance += 3;
    const evt = Coaching.tick({ activeSeconds: t, distance, spm: 24, watts: 150 });
    if (evt && evt.type === 'challenge_ended') endEvt = evt;
  }
  assert.ok(endEvt, 'the distance challenge should resolve well before the timeout');
  assert.equal(endEvt.textKey, 'distanceChallengeSuccess');
  assert.equal(endEvt.target, challenge.target);
  assert.ok(endEvt.elapsedS > 0, 'elapsed time should be reported for a completed sprint');
  const journal = Coaching.getSessionEvents().filter((e) => e.type === 'challenge');
  assert.equal(journal.length, 1);
  assert.equal(journal[0].outcome, 'success');
  assert.equal(journal[0].kind, 'distance');
});

// ---------------------------------------------------------------------
// Sustained slowdown suspends new proposals (two 15s windows, not one packet)
// ---------------------------------------------------------------------
test('a sustained drop in effort suspends new challenge proposals', () => {
  const Coaching = loadCoaching();
  for (let t = 1; t <= 90; t++) {
    Coaching.tick({ activeSeconds: t, distance: 0, spm: 24, watts: 150 });
  }
  // Two 15s windows: watts drops by >10% between them.
  for (let t = 91; t <= 105; t++) Coaching.tick({ activeSeconds: t, distance: 0, spm: 24, watts: 150 });
  for (let t = 106; t <= 120; t++) Coaching.tick({ activeSeconds: t, distance: 0, spm: 24, watts: 120 });

  assert.equal(Coaching.getChallenge(), null, 'no challenge should start while the trend is down');

  // Effort stabilises again - eventually a challenge should be allowed.
  let started = false;
  for (let t = 121; t <= 260; t++) {
    const evt = Coaching.tick({ activeSeconds: t, distance: 0, spm: 24, watts: 120 });
    if (evt && evt.type === 'challenge_started') { started = true; break; }
  }
  assert.equal(started, true);
});

// ---------------------------------------------------------------------
// Ignored challenges space out proposals, and two in a row stop them
// ---------------------------------------------------------------------
test('an ignored cadence challenge widens the gap before the next proposal', () => {
  const Coaching = loadCoaching();
  const ANNOUNCE_S = Coaching._internals.CADENCE_ANNOUNCE_S;

  // Distance stays frozen through the whole 30s reference window leading up
  // to the eligibility point, so tryStartDistanceChallenge sees dd<=0 and
  // falls through to the cadence challenge - isolates the "ignored" path
  // from the type-alternation coin flip.
  let distance = 0;
  for (let t = 1; t < 90; t++) {
    distance += 3;
    Coaching.tick({ activeSeconds: t, distance, spm: 20, watts: 150 });
  }
  const frozen = distance;
  let startT = null;
  for (let t = 90; t < 150; t++) {
    const evt = Coaching.tick({ activeSeconds: t, distance: frozen, spm: 20, watts: 150 });
    if (evt && evt.type === 'challenge_started') { startT = t; break; }
  }
  assert.ok(startT, 'a challenge should have started by t=120');
  assert.equal(Coaching.getChallenge().kind, 'cadence');

  // Let the announce countdown run out (nothing is scored yet).
  for (let i = 1; i <= ANNOUNCE_S; i++) {
    Coaching.tick({ activeSeconds: startT + i, distance: frozen, spm: 20, watts: 150 });
  }
  const activeStartT = startT + ANNOUNCE_S;
  assert.equal(Coaching.getChallenge().phase, 'active');

  // Fail it: never actually pushes above the baseline for the full 30s.
  for (let i = 1; i <= 30; i++) {
    Coaching.tick({ activeSeconds: activeStartT + i, distance: frozen, spm: 20, watts: 150 });
  }
  const firstEnd = activeStartT + 30;
  assert.equal(Coaching._internals.getFlags().ignoredStreak, 1);

  // Too soon (< 5 minutes after an ignored challenge): nothing new starts,
  // even though the normal 3-minute gap has long passed.
  let sawStartTooSoon = false;
  for (let t = firstEnd + 1; t <= firstEnd + 200; t++) {
    const evt = Coaching.tick({ activeSeconds: t, distance: frozen, spm: 20, watts: 150 });
    if (evt && evt.type === 'challenge_started') sawStartTooSoon = true;
  }
  assert.equal(sawStartTooSoon, false);

  // Past the 5-minute mark, a new proposal is allowed again.
  let sawStartAfterGap = false;
  for (let t = firstEnd + 201; t <= firstEnd + 320; t++) {
    const evt = Coaching.tick({ activeSeconds: t, distance: frozen, spm: 20, watts: 150 });
    if (evt && evt.type === 'challenge_started') { sawStartAfterGap = true; break; }
  }
  assert.equal(sawStartAfterGap, true);
});

// ---------------------------------------------------------------------
// Pause mid-challenge cancels it neutrally - not a failure
// ---------------------------------------------------------------------
test('pausing mid-challenge interrupts it without counting as ignored', () => {
  const Coaching = loadCoaching();
  const ANNOUNCE_S = Coaching._internals.CADENCE_ANNOUNCE_S;
  for (let t = 1; t <= 120 + ANNOUNCE_S + 2; t++) Coaching.tick({ activeSeconds: t, distance: 0, spm: 20, watts: 150 });
  const challenge = Coaching.getChallenge();
  assert.ok(challenge, 'a challenge should be running');
  assert.equal(challenge.phase, 'active', 'the announce countdown should have elapsed by now');

  Coaching.onPause();
  assert.equal(Coaching.getChallenge(), null);
  const journal = Coaching.getSessionEvents().filter((e) => e.type === 'challenge');
  assert.equal(journal.length, 1);
  assert.equal(journal[0].outcome, 'interrupted');
  assert.equal(Coaching._internals.getFlags().ignoredStreak, 0);
});

// ---------------------------------------------------------------------
// A milestone crossed mid-challenge is logged but does not show a message
// ---------------------------------------------------------------------
test('a milestone reached during a challenge is logged but not displayed', () => {
  const Coaching = loadCoaching();
  let distance = 0;
  for (let t = 1; t <= 120; t++) {
    distance += 8; // fast enough to approach 1km without finishing the setup phase
    Coaching.tick({ activeSeconds: t, distance, spm: 20, watts: 150 });
  }
  const challenge = Coaching.getChallenge();
  assert.ok(challenge, 'expected a challenge to be running');

  // Push distance across the 1km milestone while the challenge is active.
  // challenge_started/_go/_ended are legitimate challenge events, not the
  // "ordinary" milestone/encouragement messages this test is guarding
  // against leaking out while a challenge owns the banner.
  const ORDINARY_TYPES = ['encouragement', 'milestone_reached', 'milestone_approach'];
  let messageDuringCross = null;
  for (let i = 1; i <= 15 && Coaching.getChallenge(); i++) {
    distance += 50;
    const evt = Coaching.tick({ activeSeconds: 120 + i, distance, spm: 20, watts: 150 });
    if (distance >= 1000 && evt && ORDINARY_TYPES.indexOf(evt.type) >= 0) messageDuringCross = evt;
  }
  const milestoneLogged = Coaching.getSessionEvents().some((e) => e.type === 'milestone' && e.distance === 1000);
  assert.equal(milestoneLogged, true);
  if (Coaching.getChallenge()) {
    // Challenge still running past the crossing: no ordinary message should have leaked out.
    assert.equal(messageDuringCross, null);
  }
});

// ---------------------------------------------------------------------
// A new session clears the journal
// ---------------------------------------------------------------------
test('reset() clears the session journal for a new session', () => {
  const Coaching = loadCoaching();
  for (let t = 1; t <= 140; t++) Coaching.tick({ activeSeconds: t, distance: 0, spm: 20, watts: 150 }); // mid-challenge, not yet resolved
  assert.ok(Coaching.getChallenge(), 'a challenge should be running before reset');
  Coaching.reset();
  // Cross-realm arrays (this module runs in its own vm context) don't
  // satisfy assert.deepStrictEqual against a same-realm [] literal -
  // .length is what actually matters here.
  assert.equal(Coaching.getSessionEvents().length, 0);
  assert.equal(Coaching.getChallenge(), null);
});
