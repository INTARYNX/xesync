// =====================================================================
// coaching.js - automatic encouragement / milestone / mini-challenge
// rules engine. Pure logic: no DOM, no network, no timers of its own.
//
// Driven entirely by tick()/onPause()/onResume()/reset() calls made by
// controller.js from the callbacks ftms_integration.js exposes
// (window.onFtmsTick / onFtmsPause / onFtmsResume / onFtmsSessionStart).
// ftms_integration.js never requires this file to exist.
//
// tick() returns AT MOST one event descriptor per call:
//   { type, textKey, textArgs, priority }
// controller.js hands that straight to CoachingView. The session's
// milestone/challenge journal (getSessionEvents()) is what splits.js
// reads at save time to shape the end-of-workout table.
//
// Constants below are the doc's own "starting hypotheses"
// (AMELIORATIONS_PRODUIT.md sections 1-3) - expected to move once real
// sessions are observed, not physiological thresholds.
// =====================================================================

var Coaching = (function () {
  'use strict';

  // -- Milestones / encouragements --------------------------------------
  var MILESTONE_STEP_M        = 1000;
  var MILESTONE_APPROACH_M    = 100;
  var DURATION_MARKS_S        = [5 * 60];
  var MESSAGE_DISPLAY_S       = 4;

  // -- Cadence-boost challenge --------------------------------------------
  // Originally spec'd as "hold your current cadence steady," renamed after
  // feedback: benchmarking success against the person's own recent cadence
  // meant "success" could be achieved by doing nothing differently at all.
  // The challenge now requires a real, measurable push above the recent
  // baseline.
  var CADENCE_MIN_ACTIVE_S    = 120;
  var CADENCE_WINDOW_S        = 30;
  var CADENCE_BOOST_SPM       = 3;    // required increase over the recent baseline
  var CADENCE_SUCCESS_S       = 24;
  var CADENCE_ANNOUNCE_S      = 5;    // lead-in before timing starts ("mini-challenge in 5s")
  var REFERENCE_WINDOW_S      = 30;   // recent-measurement window (median spm / speed estimate)
  var MIN_REFERENCE_SAMPLES   = 10;   // enough fresh points before trusting a reference

  // -- Distance-goal challenge ("fais un 3000 m") ------------------------
  var DISTANCE_MIN_M          = 300;
  var DISTANCE_MAX_M          = 3000; // a high ceiling - most proposals will be shorter than this
  var DISTANCE_DURATIONS_S    = [120, 180, 150]; // deterministic cycle, no RNG needed for variety
  var DISTANCE_TIMEOUT_FACTOR = 3;    // give up (neutral) after this multiple of the estimated duration
  var DISTANCE_ANNOUNCE_S     = 10;   // lead-in so the person can accelerate before timing starts
  var PACE_STATUS_WINDOW_S    = 6;    // short window for the live "faster/slower" read-out
  var PACE_STATUS_MARGIN      = 0.08; // +/-8% of baseline speed before flipping the status

  // -- Spacing / adaptation ----------------------------------------------
  var CHALLENGE_MIN_GAP_S     = 180;  // >=3 min active between proposals
  var CHALLENGE_IGNORED_GAP_S = 300;  // >=5 min after a challenge that wasn't followed
  var CHALLENGE_MAX_IGNORED   = 2;    // after this many in a row, stop proposing for the rest of the session
  var TREND_WINDOW_S          = 15;
  var TREND_WATTS_DROP_FRAC   = 0.10;
  var TREND_SPM_DROP          = 2;
  var MAX_TICK_GAP_S          = 2;    // beyond this, data is too stale to keep a challenge running

  // -- State ---------------------------------------------------------------
  var mode = 'coaching'; // 'coaching' | 'justRow'
  var events = [];       // session journal consumed by splits.js
  var recent = [];       // ring buffer {t, spm, watts, distance}, last REFERENCE_WINDOW_S seconds
  var lastTick = null;   // { t } of the previous tick, for dt computation
  var challenge = null;  // active challenge state, or null
  var flags;

  function freshFlags() {
    return {
      firstEffortShown:          false,
      pendingResume:             false,
      nextMilestoneM:            MILESTONE_STEP_M,
      approachShownForMilestone: null,
      durationShown:             {},
      lastMessageEndS:           -Infinity,
      lastChallengeEndS:         -Infinity,
      ignoredStreak:             0,
      challengesDisabled:        false,
      lastChallengeKind:         null,
      distanceChallengeCount:    0
    };
  }

  function reset() {
    events = [];
    recent = [];
    lastTick = null;
    challenge = null;
    flags = freshFlags();
  }
  reset();

  function setMode(m) { mode = (m === 'justRow') ? 'justRow' : 'coaching'; }
  function getMode()  { return mode; }

  // -- Recent-measurement window -----------------------------------------
  function pushRecent(snap) {
    recent.push(snap);
    var cutoff = snap.t - REFERENCE_WINDOW_S;
    while (recent.length && recent[0].t < cutoff) recent.shift();
  }

  function windowSince(t, windowS) {
    var cutoff = t - windowS;
    return recent.filter(function (r) { return r.t >= cutoff && r.t <= t; });
  }

  function median(values) {
    if (!values.length) return null;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function avgOf(arr, key) {
    if (!arr.length) return null;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i][key];
    return sum / arr.length;
  }

  function recentSpeedMps(t, windowS) {
    var win = windowSince(t, windowS);
    if (win.length < 2) return null;
    var first = win[0], last = win[win.length - 1];
    var dt = last.t - first.t, dd = last.distance - first.distance;
    return dt > 0 ? dd / dt : null;
  }

  // Two 15s windows compared, not two isolated packets - a real, sustained
  // decline suspends new proposals until things settle, so the coaching
  // stays responsive to what's actually happening right now.
  function isTrendingDown(t) {
    var older = windowSince(t - TREND_WINDOW_S, TREND_WINDOW_S);
    var newer = windowSince(t, TREND_WINDOW_S);
    if (older.length < 3 || newer.length < 3) return false;
    var oldWatts = avgOf(older, 'watts'), newWatts = avgOf(newer, 'watts');
    var oldSpm   = avgOf(older, 'spm'),   newSpm   = avgOf(newer, 'spm');
    if (oldWatts > 0 && (oldWatts - newWatts) / oldWatts >= TREND_WATTS_DROP_FRAC) return true;
    if ((oldSpm - newSpm) >= TREND_SPM_DROP) return true;
    return false;
  }

  function isBusy(t) { return t < flags.lastMessageEndS; }

  // -- Milestones (section 2) ---------------------------------------------
  // Always advances state / logs the journal entry, independent of whether
  // the resulting message actually gets displayed this tick.
  function checkMilestones(t, distance) {
    if (distance >= flags.nextMilestoneM - MILESTONE_APPROACH_M &&
        distance < flags.nextMilestoneM &&
        flags.approachShownForMilestone !== flags.nextMilestoneM) {
      flags.approachShownForMilestone = flags.nextMilestoneM;
      return {
        priority: 2, type: 'milestone_approach', textKey: 'milestoneApproach',
        textArgs: [Math.round(flags.nextMilestoneM - distance), flags.nextMilestoneM]
      };
    }
    if (distance >= flags.nextMilestoneM) {
      var reachedM = flags.nextMilestoneM;
      events.push({ type: 'milestone', t: t, distance: reachedM });
      flags.nextMilestoneM += MILESTONE_STEP_M;
      flags.approachShownForMilestone = null;
      return {
        priority: 3, type: 'milestone_reached',
        textKey: reachedM === MILESTONE_STEP_M ? 'firstKm' : 'milestoneReached',
        textArgs: [reachedM]
      };
    }
    return null;
  }

  function checkDurationMarks(t) {
    for (var i = 0; i < DURATION_MARKS_S.length; i++) {
      var mark = DURATION_MARKS_S[i];
      if (t >= mark && !flags.durationShown[mark]) {
        flags.durationShown[mark] = true;
        return { priority: 1, type: 'encouragement', textKey: 'durationMark', textArgs: [Math.round(mark / 60)] };
      }
    }
    return null;
  }

  // -- Cadence-regularity challenge -----------------------------------------
  // Both challenges open with an "announce" phase (5s cadence / 10s distance)
  // before any scoring starts, and for the sprint specifically the lead-in
  // exists so the person has time to accelerate before the clock actually
  // starts (real-device feedback: a sprint proposed with zero warning never
  // got faster than cruising pace).
  function tryStartCadenceChallenge(t) {
    var win = windowSince(t, CADENCE_WINDOW_S);
    if (win.length < MIN_REFERENCE_SAMPLES) return null;
    var ref = median(win.map(function (r) { return r.spm; }));
    if (!ref || ref <= 0) return null;
    ref = Math.round(ref);
    var targetSpm = ref + CADENCE_BOOST_SPM;
    challenge = {
      kind: 'cadence', phase: 'announce', announceEndT: t + CADENCE_ANNOUNCE_S, countdownS: CADENCE_ANNOUNCE_S,
      reference: ref, targetSpm: targetSpm,
      startT: null, inRangeS: 0, totalS: 0, lastSpm: null
    };
    return {
      priority: 4, type: 'challenge_started', kind: 'cadence',
      textKey: 'cadenceChallengeIntro', textArgs: [targetSpm, CADENCE_ANNOUNCE_S]
    };
  }

  // -- Distance-goal challenge ----------------------------------------------
  function tryStartDistanceChallenge(t) {
    var speed = recentSpeedMps(t, REFERENCE_WINDOW_S);
    if (speed == null || speed <= 0 || windowSince(t, REFERENCE_WINDOW_S).length < MIN_REFERENCE_SAMPLES) return null;
    var durationS = DISTANCE_DURATIONS_S[flags.distanceChallengeCount % DISTANCE_DURATIONS_S.length];
    var target = Math.round((durationS * speed) / 50) * 50;
    target = Math.max(DISTANCE_MIN_M, Math.min(DISTANCE_MAX_M, target));
    flags.distanceChallengeCount++;
    challenge = {
      kind: 'distance', phase: 'announce', announceEndT: t + DISTANCE_ANNOUNCE_S, countdownS: DISTANCE_ANNOUNCE_S,
      target: target, timeoutS: durationS * DISTANCE_TIMEOUT_FACTOR, baselineSpeed: speed,
      startT: null, startDistance: null, lastDistance: null, paceStatus: null
    };
    return {
      priority: 4, type: 'challenge_started', kind: 'distance',
      textKey: 'distanceChallengeIntro', textArgs: [target, DISTANCE_ANNOUNCE_S]
    };
  }

  function requiredGapAfterLast() {
    return flags.ignoredStreak > 0 ? CHALLENGE_IGNORED_GAP_S : CHALLENGE_MIN_GAP_S;
  }

  // Alternates challenge type for variety, rather than always proposing
  // the same mechanic.
  function tryStartChallenge(t) {
    if (flags.challengesDisabled) return null;
    if (t < CADENCE_MIN_ACTIVE_S) return null;
    if (t - flags.lastChallengeEndS < requiredGapAfterLast()) return null;
    if (isTrendingDown(t)) return null;
    var preferDistance = flags.lastChallengeKind !== 'distance';
    var started = preferDistance ? tryStartDistanceChallenge(t) : tryStartCadenceChallenge(t);
    if (!started) started = preferDistance ? tryStartCadenceChallenge(t) : tryStartDistanceChallenge(t);
    return started;
  }

  function endChallenge(t, outcome) {
    var c = challenge;
    events.push({
      type: 'challenge', kind: c.kind, outcome: outcome, tStart: c.startT, tEnd: t,
      distanceStart: c.kind === 'distance' ? c.startDistance : null,
      distanceEnd:   c.kind === 'distance' ? c.lastDistance   : null,
      target:        c.kind === 'distance' ? c.target         : null,
      reference:     c.kind === 'cadence'  ? c.reference      : null,
      targetSpm:     c.kind === 'cadence'  ? c.targetSpm      : null,
      // Real measured values for the post-workout "challenges" recap, not
      // just a pass/fail label (feedback: the summary needs actual numbers).
      inRangeS:      c.kind === 'cadence'  ? c.inRangeS       : null,
      totalS:        c.kind === 'cadence'  ? c.totalS         : null
    });
    flags.lastChallengeEndS = t;
    flags.lastChallengeKind = c.kind;
    challenge = null;
    if (outcome === 'success') {
      flags.ignoredStreak = 0;
    } else if (outcome === 'ignored') {
      flags.ignoredStreak++;
      if (flags.ignoredStreak >= CHALLENGE_MAX_IGNORED) flags.challengesDisabled = true;
    }
    // 'interrupted' (pause / stale data / reset): neutral, no streak change.
  }

  // Only called once the announce countdown has elapsed (challenge.phase
  // === 'active'); the announce->active transition itself is handled in
  // tick() below, since it needs to capture a fresh startDistance/startT at
  // the actual go moment, not at proposal time.
  function tickChallenge(t, snap, dt) {
    if (challenge.kind === 'cadence') {
      challenge.lastSpm = snap.spm;
      challenge.totalS += dt;
      if (snap.spm >= challenge.targetSpm) challenge.inRangeS += dt;
      if (challenge.totalS >= CADENCE_WINDOW_S) {
        var success = challenge.inRangeS >= CADENCE_SUCCESS_S;
        var evt2 = { priority: 5, type: 'challenge_ended', kind: 'cadence', outcome: success ? 'success' : 'ignored',
          textKey: success ? 'cadenceChallengeSuccess' : 'cadenceChallengeNeutral', textArgs: null };
        endChallenge(t, success ? 'success' : 'ignored');
        return evt2;
      }
      return null;
    }
    // distance challenge
    challenge.lastDistance = snap.distance;
    var curSpeed = recentSpeedMps(t, PACE_STATUS_WINDOW_S);
    if (curSpeed != null && challenge.baselineSpeed) {
      var ratio = curSpeed / challenge.baselineSpeed;
      challenge.paceStatus = ratio >= 1 + PACE_STATUS_MARGIN ? 'ahead'
        : ratio <= 1 - PACE_STATUS_MARGIN ? 'behind' : 'onPace';
    }
    var covered = snap.distance - challenge.startDistance;
    if (covered >= challenge.target) {
      var elapsedS = t - challenge.startT;
      var evt3 = { priority: 5, type: 'challenge_ended', kind: 'distance', outcome: 'success',
        textKey: 'distanceChallengeSuccess', textArgs: [challenge.target, elapsedS],
        target: challenge.target, elapsedS: elapsedS };
      endChallenge(t, 'success');
      return evt3;
    }
    if (t - challenge.startT >= challenge.timeoutS) {
      var evt4 = { priority: 5, type: 'challenge_ended', kind: 'distance', outcome: 'ignored',
        textKey: 'distanceChallengeNeutral', textArgs: null };
      endChallenge(t, 'ignored');
      return evt4;
    }
    return null;
  }

  // -- Public tick -----------------------------------------------------
  // snapshot: { activeSeconds, distance, strokes, spm, watts }
  function tick(snap) {
    var t = snap.activeSeconds;
    if (mode === 'justRow') { lastTick = { t: t }; return null; }

    var dt = lastTick ? Math.max(0, t - lastTick.t) : 0;
    pushRecent({ t: t, spm: snap.spm, watts: snap.watts, distance: snap.distance });

    var wasInChallenge = !!challenge;
    var challengeEvt = null;
    if (challenge) {
      if (dt > MAX_TICK_GAP_S) {
        var neutralKey = challenge.kind === 'cadence' ? 'cadenceChallengeNeutral' : 'distanceChallengeNeutral';
        challengeEvt = { priority: 5, type: 'challenge_ended', kind: challenge.kind, outcome: 'interrupted',
          textKey: neutralKey, textArgs: null };
        endChallenge(t, 'interrupted');
      } else if (challenge.phase === 'announce') {
        if (t >= challenge.announceEndT) {
          challenge.phase = 'active';
          challenge.startT = t;
          if (challenge.kind === 'distance') { challenge.startDistance = snap.distance; challenge.lastDistance = snap.distance; }
          challengeEvt = {
            priority: 4, type: 'challenge_go', kind: challenge.kind,
            textKey: challenge.kind === 'cadence' ? 'cadenceChallengeGo' : 'distanceChallengeGo', textArgs: null
          };
        } else {
          challenge.countdownS = Math.max(0, Math.ceil(challenge.announceEndT - t));
        }
      } else {
        challengeEvt = tickChallenge(t, snap, dt);
      }
    }

    var resumeEvt = null;
    if (flags.pendingResume) {
      flags.pendingResume = false;
      resumeEvt = { priority: 1, type: 'encouragement', textKey: 'resumeAfterPause', textArgs: null };
    }
    var firstEffortEvt = null;
    if (!flags.firstEffortShown) {
      flags.firstEffortShown = true;
      firstEffortEvt = { priority: 1, type: 'encouragement', textKey: 'sessionStart', textArgs: null };
    }

    // Always run (state advancement + journal), independent of display.
    var milestoneEvt = checkMilestones(t, snap.distance);
    var durationEvt  = checkDurationMarks(t);

    var candidate = null;
    if (challengeEvt) {
      candidate = challengeEvt; // top priority, allowed to preempt a busy banner
    } else if (wasInChallenge) {
      candidate = null; // challenge still running: suppress everything else
    } else if (milestoneEvt && milestoneEvt.type === 'milestone_reached') {
      candidate = milestoneEvt; // allowed to preempt
    } else if (!isBusy(t)) {
      candidate = milestoneEvt || durationEvt || resumeEvt || firstEffortEvt || null;
    }

    if (candidate) flags.lastMessageEndS = t + MESSAGE_DISPLAY_S;

    if (!challenge && !flags.challengesDisabled && !candidate && !isBusy(t)) {
      var startEvt = tryStartChallenge(t);
      if (startEvt) { candidate = startEvt; flags.lastMessageEndS = t + MESSAGE_DISPLAY_S; }
    }

    lastTick = { t: t };
    return candidate;
  }

  // Pause interrupts a running challenge without counting it as a failure.
  function onPause() {
    if (challenge) {
      // Still counting down when the pause hit: nothing timed actually
      // happened yet, so there's no journal-worthy attempt to log.
      if (challenge.phase === 'active') {
        events.push({
          type: 'challenge', kind: challenge.kind, outcome: 'interrupted',
          tStart: challenge.startT, tEnd: lastTick ? lastTick.t : challenge.startT,
          distanceStart: challenge.kind === 'distance' ? challenge.startDistance : null,
          distanceEnd:   challenge.kind === 'distance' ? challenge.lastDistance   : null,
          target:        challenge.kind === 'distance' ? challenge.target        : null,
          reference:     challenge.kind === 'cadence'  ? challenge.reference     : null
        });
      }
      challenge = null;
    }
  }

  function onResume() {
    lastTick = null; // next tick's dt starts at 0 instead of spanning the pause
    flags.pendingResume = true;
  }

  return {
    reset:            reset,
    setMode:          setMode,
    getMode:          getMode,
    tick:             tick,
    onPause:          onPause,
    onResume:         onResume,
    getSessionEvents: function () { return events.slice(); },
    getChallenge:     function () { return challenge ? JSON.parse(JSON.stringify(challenge)) : null; },
    // Exposed for unit tests and diagnostics, same spirit as FtmsInternals.
    _internals: {
      MILESTONE_STEP_M: MILESTONE_STEP_M, MILESTONE_APPROACH_M: MILESTONE_APPROACH_M,
      DURATION_MARKS_S: DURATION_MARKS_S, MESSAGE_DISPLAY_S: MESSAGE_DISPLAY_S,
      CADENCE_MIN_ACTIVE_S: CADENCE_MIN_ACTIVE_S, CADENCE_WINDOW_S: CADENCE_WINDOW_S,
      CADENCE_BOOST_SPM: CADENCE_BOOST_SPM, CADENCE_SUCCESS_S: CADENCE_SUCCESS_S,
      CADENCE_ANNOUNCE_S: CADENCE_ANNOUNCE_S, DISTANCE_ANNOUNCE_S: DISTANCE_ANNOUNCE_S,
      DISTANCE_MIN_M: DISTANCE_MIN_M, DISTANCE_MAX_M: DISTANCE_MAX_M,
      CHALLENGE_MIN_GAP_S: CHALLENGE_MIN_GAP_S, CHALLENGE_IGNORED_GAP_S: CHALLENGE_IGNORED_GAP_S,
      CHALLENGE_MAX_IGNORED: CHALLENGE_MAX_IGNORED, MAX_TICK_GAP_S: MAX_TICK_GAP_S,
      getFlags: function () { return flags; }
    }
  };
})();

if (typeof window !== 'undefined') window.Coaching = Coaching;
