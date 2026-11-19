// =====================================================================
// run_score.js - the game layer: score, flow chain and pushes for a free
// rowing session.
//
// A session here is NOT a workout. There is no programme, no duration to
// pick, no interval to follow, no plan. The session is the run, and the
// run is scored. This module owns the scoring state machine and nothing
// else: no DOM, no network, no timers of its own. It is driven by the
// same per-tick snapshot the coaching module gets, and it emits events
// the view layer can react to.
//
// The design goal is Alto's Odyssey, not a fitness app:
//
//   - The player is never told to go faster. The bar is derived from
//     what they just did, so it always sits just above their own recent
//     effort - and it never nags.
//
//   - Speed is the multiplier, not the goal. Points come from distance
//     covered while in flow, so what is rewarded is sustained quality,
//     and the way to earn more is to hold a higher rate.
//
//   - Leaving the flow does not fail the run, it bleeds the chain a tier
//     at a time.
//
// Two numbers do all the work, and both are continuous - no threshold,
// no knife edge. That matters: a hard gate on a noisy signal (the
// machine's stroke rate jitters by a few tenths of a stroke per minute)
// is a cliff, not a game. Measured on simulated sessions, half a stroke
// per minute of threshold moved the time spent in flow from 0% to 99%.
//
//   NORM = median cadence of the last 30 s. Your own recent effort, and
//          the thing everything else is measured against.
//
//   LIFT = rate - NORM. How far above your own norm you are right now,
//          in strokes per minute. This is the whole game:
//
//            LIFT > 0   the chain builds, and it builds faster the
//                       harder you push;
//            LIFT <= 0  the chain bleeds.
//
// There is no gate to fall through. A steady rower sits at LIFT ~ 0 and
// keeps the base points but builds no chain; a rower who pushes sits at
// LIFT ~ 3 and builds one tier every five seconds.
//
// The ratchet is automatic, because NORM follows the effort: push and
// the norm rises, so the lift shrinks, so you have to push more to keep
// the chain - and ease off and the norm comes back down to meet you.
// The risk of a push is therefore built into the mechanics: it raises
// the very bar you have to keep clearing.
//
// Every metre is worth the base rate always, and the chain and the
// excess on top of it while the lift is positive. A run never pays
// zero, and a calm pace is never punished.
//
// Pure module: state lives in the object returned by createRun(), and
// nothing outside this file is touched. See docs/GAMIFICATION.md for the
// design, and tests/run_score.test.js for the contract.
// =====================================================================

var RunScore = (function () {
  'use strict';

  var VERSION = 1;

  // -- tunables ---------------------------------------------------------
  // Every one of these is a guess to be tuned on real sessions. They are
  // parameters of the game, not physiological thresholds: nothing here
  // says anything about what a person should be able to do.

  // Short window used to measure "what you are doing right now" - the
  // rate the flow decision and the excess are read from. Median, not
  // mean: the machine's stroke rate jitters, and one bad packet should
  // not move anything.
  var SHORT_WINDOW_S = 3;
  // Window used to measure "what you have been doing" - the ratchet.
  var REF_WINDOW_S = 30;
  var MIN_REF_SAMPLES = 10;

  // The target shown to the rower sits this far above their own recent
  // median. It is a display value, not a gate.
  var BAR_OFFSET_SPM = 2;

  // Strokes per minute of sustained lift above your own norm that buy
  // one chain tier per TIER_S, raised to LIFT_EXPONENT. 3 means: three
  // strokes per minute above your norm, held for ten seconds, is one
  // tier.
  //
  // Calibrated on the simulator (dev/sim_session.js, dev/calibrate.js).
  // The measurement that settled it: with a slower, linear response, a
  // warm-up - a slow ramp the rower does automatically - fills the
  // chain before the session has really started, because the trailing
  // norm lags the ramp and the lift stays slightly positive for
  // minutes. At 3, with the quadratic drive, only a genuine push builds
  // the chain, and the rower who never varies their rate never gets a
  // tier at all.
  var LIFT_PER_TIER_SPM = 3;

  // How sharply the lift counts towards the chain. 2 means the chain
  // rewards intensity over duration: without it, a slow warm-up ramp
  // accumulates more lift over minutes than a sharp push does over
  // seconds, and every session fills its chain before it starts.
  var LIFT_EXPONENT = 2;

  // Seconds of continuous flow that buy one multiplier tier.
  var TIER_S = 10;
  var MAX_MULTIPLIER = 6;

  // Seconds out of flow before the chain starts to bleed at all.
  var FLOW_GRACE_S = 8;

  // Seconds out of flow to lose one tier, once the grace period is over.
  // The chain bleeds, it does not snap - a single missed packet should
  // not end a good run.
  var DECAY_STEP_S = 6;

  // How far above the norm earns a push, and how long it must be held.
  // 2.5 strokes per minute above your own norm, held for five seconds.
  // The duration matters as much as the level: the machine's jitter
  // reaches 2.5 in a single sample, but never holds it for five
  // seconds - so a push has to be an effort, not a spike.
  var PUSH_EXCESS_SPM = 2.5;
  var PUSH_MIN_S = 5;
  var PUSH_COOLDOWN_S = 8;
  var PUSH_BONUS = 250;

  // Points. Distance is the fuel: points come from ground covered while
  // in flow, multiplied by the chain and by the excess factor.
  var SCORE_PER_METER = 10;
  var TIER_BONUS = 100;

  // -- helpers ----------------------------------------------------------

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  function median(values) {
    if (!values.length) return null;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Median of the samples recorded within `windowS` seconds of `t`.
  function windowMedian(buf, t, windowS) {
    var values = [];
    for (var i = buf.length - 1; i >= 0; i--) {
      if (t - buf[i].t > windowS) break;
      values.push(buf[i].spm);
    }
    if (!values.length) return null;
    return median(values);
  }

  function countInWindow(buf, t, windowS) {
    var n = 0;
    for (var i = buf.length - 1; i >= 0; i--) {
      if (t - buf[i].t > windowS) break;
      n++;
    }
    return n;
  }

  // -- state ------------------------------------------------------------

  function createRun(opts) {
    opts = opts || {};
    return {
      version: VERSION,

      score: 0,
      // Continuous chain level in [0, MAX_MULTIPLIER - 1]. The multiplier
      // is 1 + floor(heat): the fractional part carries the progress
      // towards the next tier, so a break costs a tier but not the whole
      // tier's worth of work.
      heat: 0,
      multiplier: 1,
      maxMultiplier: 1,

      flowSeconds: 0,
      streakSeconds: 0,
      totalSeconds: 0,
      distanceAtFlow: 0,

      pushes: 0,
      bestPushSpm: 0,

      // The bar, the norm it comes from, and the lift over the norm.
      barSpm: null,
      refSpm: null,
      liftSpm: 0,

      // The course of the day (see daily_course.js). Null when the day
      // has no par to chase; the rules below simply never fire.
      dailyPar: null,
      dailyParReached: false,

      // The result of the race against the ghost of the best run, once
      // the session is over.
      ghostResult: null,

      // The livery the boat wore during the run (see costume.js), and
      // whether it changed while the rower was on the water.
      livery: null,
      liveryChanged: false,

      inFlow: false,
      lastTickT: null,
      lastDistance: null,

      pushSeconds: 0,
      lastPushT: -Infinity,
      outOfFlowSeconds: 0,

      samples: [],
      events: [],

      // The tunables, per run, so the balance can be tried without
      // editing the file. Defaults are the constants above.
      tuning: {
        barOffsetSpm: opts.barOffsetSpm === undefined ? BAR_OFFSET_SPM : opts.barOffsetSpm,
        liftPerTierSpm: opts.liftPerTierSpm === undefined ? LIFT_PER_TIER_SPM : opts.liftPerTierSpm,
        tierS: opts.tierS === undefined ? TIER_S : opts.tierS,
        decayStepS: opts.decayStepS === undefined ? DECAY_STEP_S : opts.decayStepS,
        shortWindowS: opts.shortWindowS === undefined ? SHORT_WINDOW_S : opts.shortWindowS,
        refWindowS: opts.refWindowS === undefined ? REF_WINDOW_S : opts.refWindowS,
        pushExcessSpm: opts.pushExcessSpm === undefined ? PUSH_EXCESS_SPM : opts.pushExcessSpm,
        pushMinS: opts.pushMinS === undefined ? PUSH_MIN_S : opts.pushMinS,
        pushCooldownS: opts.pushCooldownS === undefined ? PUSH_COOLDOWN_S : opts.pushCooldownS,
        flowGraceS: opts.flowGraceS === undefined ? FLOW_GRACE_S : opts.flowGraceS,
        // How sharply the lift counts. 1 is linear, 2 rewards intensity
        // over duration. See the heat computation in tick().
        liftExponent: opts.liftExponent === undefined ? LIFT_EXPONENT : opts.liftExponent
      }
    };
  }

  // The course of the day. The rules for reaching it live here, with
  // the rest of the rules - the view only draws the mark and the
  // controller only orchestrates.
  // The race against the ghost, settled. The controller computes it
  // from the session's samples; the scoring layer only carries it.
  function setGhostResult(state, result) {
    state.ghostResult = result || null;
    return state;
  }

  // The livery of the boat. Not a score and not a rule: the run simply
  // remembers what it wore, so the post-workout screen can say so when
  // it changed.
  function setLivery(state, livery) {
    state.livery = livery || null;
    state.liveryChanged = !!(livery && livery.changed);
  }

  function setDailyPar(state, par) {
    state.dailyPar = par || null;
    state.dailyParReached = false;
    return state;
  }

  function reset(state) {
    var tuning = state.tuning;
    var fresh = createRun({});
    for (var k in fresh) {
      if (Object.prototype.hasOwnProperty.call(fresh, k)) state[k] = fresh[k];
    }
    state.tuning = tuning;
    return state;
  }

  function push(state, evt) {
    state.events.push(evt);
    return evt;
  }

  // The ratchet: the median cadence of the last REF_WINDOW_S seconds,
  // plus one stroke per minute. null until there is enough data to be
  // worth anything.
  function computeBar(state, t) {
    var win = state.tuning.refWindowS;
    var ref = windowMedian(state.samples, t, win);
    if (ref === null) return { ref: null, bar: null };
    if (countInWindow(state.samples, t, win) < MIN_REF_SAMPLES) {
      return { ref: ref, bar: null };
    }
    return { ref: ref, bar: ref + state.tuning.barOffsetSpm };
  }

  // The multiplier follows the continuous heat, so it only ever moves by
  // one tier at a time.
  //
  // The epsilon matters: heat grows by repeated additions of dt/TIER_S,
  // and ten additions of 1/10 land at 0.9999999999999999 in binary
  // floating point. Without the epsilon a tier is silently lost the
  // moment the rower has earned it.
  function multiplierForHeat(heat) {
    return clamp(1 + Math.floor(heat + 1e-9), 1, MAX_MULTIPLIER);
  }

  // What every metre covered with a lift is worth, on top of the chain:
  // 1x at the norm, up to 2x at PUSH_EXCESS_SPM above it.
  function excessFactor(lift, pushExcessSpm) {
    return 1 + clamp(lift, 0, pushExcessSpm) / pushExcessSpm;
  }

  // -- the tick ---------------------------------------------------------

  // `snap` is the same shape the coaching module receives:
  // { activeSeconds, distance, strokes, spm, watts }
  //
  // Returns the event to show, or null. The event list is kept on the
  // state too, for the end-of-session summary.
  function tick(state, snap) {
    if (!snap) return null;
    var t = snap.activeSeconds;
    var dt = state.lastTickT === null ? 0 : Math.max(0, t - state.lastTickT);
    state.lastTickT = t;
    state.totalSeconds = t;

    // A stroke rate of zero means the flywheel is still spinning down
    // after a pause: not a measurement, and it must not drag the ratchet
    // down or be counted as distance in flow.
    if (snap.spm > 0) {
      state.samples.push({ t: t, spm: snap.spm });
      // Keep the buffer bounded; the reference window is 30 s.
      while (state.samples.length && t - state.samples[0].t > state.tuning.refWindowS * 2) {
        state.samples.shift();
      }
    }

    var distance = snap.distance || 0;
    var distDelta = state.lastDistance === null ? 0 : Math.max(0, distance - state.lastDistance);
    state.lastDistance = distance;

    var band = computeBar(state, t);
    // The norm is only published once it is worth something: a median of
    // three samples is not a norm.
    state.refSpm = band.bar === null ? null : band.ref;
    state.barSpm = band.bar;

    // The ground is always worth something, even before the norm exists:
    // the first seconds of a session are scored at the base rate, they
    // simply cannot build a chain yet. A run never pays zero.
    var base = Math.round(distDelta * SCORE_PER_METER);

    if (band.bar === null) {
      // Not enough data to set a norm yet. Nothing is judged - the run
      // simply has no bar to clear.
      state.score += base;
      return null;
    }

    var bar = band.bar;
    // Short rate for the decision (noisy), norm for the comparison (slow).
    var shortRate = windowMedian(state.samples, t, state.tuning.shortWindowS);
    var rate = shortRate === null ? snap.spm : shortRate;

    // The lift: how far above your own norm you are, right now.
    var lift = rate - band.ref;
    state.liftSpm = lift;

    // No threshold: the chain simply builds in proportion to the lift.
    var nowInFlow = lift > 0;

    var wasInFlow = state.inFlow;
    var event = null;

    if (nowInFlow) {
      state.flowSeconds += dt;
      state.streakSeconds += dt;
      state.distanceAtFlow += distDelta;
      // In flow, a metre is worth the chain and the excess.
      state.score += Math.round(
        distDelta * SCORE_PER_METER * state.multiplier *
        excessFactor(lift, state.tuning.pushExcessSpm)
      );

      if (!wasInFlow) {
        state.inFlow = true;
        state.outOfFlowSeconds = 0;
        event = push(state, {
          type: 'flow_entered', t: t, barSpm: bar, rate: rate
        });
      }

      // The chain heats up, in proportion to the lift: one tier per
      // TIER_S at LIFT_PER_TIER_SPM above your norm, twice as fast at
      // twice the lift.
      //
      // The exponent is what keeps a warm-up from filling the chain. A
      // warm-up is a slow ramp, and the trailing norm lags it by about
      // half its window, so the lift sits at a small but constant value
      // for minutes: integrated over time, that beats a sharp push. The
      // chain is supposed to reward intensity, not duration, so the
      // drive is the lift raised to an exponent: at 2, a +3 spm push
      // counts nine times what a +0.4 spm ramp counts.
      var before = state.multiplier;
      var drive = Math.pow(Math.max(0, lift), state.tuning.liftExponent);
      var driveUnit = Math.pow(state.tuning.liftPerTierSpm, state.tuning.liftExponent);
      state.heat = clamp(state.heat +
        dt * drive / (driveUnit * state.tuning.tierS),
        0, MAX_MULTIPLIER - 1);
      state.multiplier = multiplierForHeat(state.heat);
      if (state.multiplier > before) {
        state.maxMultiplier = Math.max(state.maxMultiplier, state.multiplier);
        var bonus = TIER_BONUS * state.multiplier;
        state.score += bonus;
        event = push(state, {
          type: 'chain_up', t: t, multiplier: state.multiplier, bonus: bonus
        });
        // The day's par is reached when the chain gets there. It is a
        // mark, not a reward: nothing is added to the score, nothing is
        // said. The only thing that happens is the visual beat - the
        // event carries the flag, it does not replace the tier event.
        if (state.dailyPar && !state.dailyParReached &&
            state.multiplier >= state.dailyPar.chainPar) {
          state.dailyParReached = true;
          event.parReached = state.dailyPar.chainPar;
        }
      }

      // A push: a sustained excursion above the bar. It pays, and it is
      // also what raises the bar for the next half-minute - the risk is
      // built into the mechanism, there is no separate rule.
      if (lift >= state.tuning.pushExcessSpm) {
        state.pushSeconds += dt;
        if (state.pushSeconds >= state.tuning.pushMinS &&
            t - state.lastPushT >= state.tuning.pushCooldownS) {
          state.pushes++;
          state.lastPushT = t;
          state.pushSeconds = 0;
          state.bestPushSpm = Math.max(state.bestPushSpm, rate);
          var pushBonus = PUSH_BONUS * state.multiplier;
          state.score += pushBonus;
          event = push(state, {
            type: 'push', t: t, rate: rate, barSpm: bar,
            multiplier: state.multiplier, bonus: pushBonus
          });
          // The day's par can also be reached by landing the pushes it
          // asks for. Same thing: a mark, a visual beat, no words.
          if (state.dailyPar && !state.dailyParReached &&
              state.pushes >= state.dailyPar.pushPar) {
            state.dailyParReached = true;
            event.parReached = state.dailyPar.pushPar;
          }
        }
      } else {
        state.pushSeconds = 0;
      }
    } else {
      // Out of flow the ground still counts, at the base rate. A run
      // never pays zero: rowing steadily for twenty minutes is worth
      // something, it simply does not build a chain.
      state.score += base;

      if (wasInFlow) {
        state.inFlow = false;
        state.streakSeconds = 0;
        event = push(state, {
          type: 'flow_left', t: t, flowSeconds: state.flowSeconds, rate: rate
        });
      }
      state.pushSeconds = 0;

      // The chain bleeds one tier at a time - but not the instant you
      // ease off. A grace period first: the chain holds for a few
      // seconds out of flow, then starts to go. Without it, a push
      // that ends would cost its multiplier in the same breath, and the
      // reward for the hardest effort of the session would be a flash.
      var was = state.multiplier;
      state.outOfFlowSeconds += dt;
      if (state.outOfFlowSeconds >= state.tuning.flowGraceS) {
        state.heat = clamp(state.heat - dt / state.tuning.decayStepS, 0, MAX_MULTIPLIER - 1);
      }
      state.multiplier = multiplierForHeat(state.heat);
      if (state.multiplier < was) {
        event = push(state, {
          type: 'chain_down', t: t, multiplier: state.multiplier
        });
      }
    }

    return event;
  }

  // -- end of run -------------------------------------------------------

  // Attached to the workout payload by controller.js's onBeforeSave hook.
  // The payload is archived verbatim in xesync.workout_data (JSONB), so
  // this needs no server-side migration to be stored.
  function summarize(state) {
    return {
      version: VERSION,
      score: Math.round(state.score),
      maxMultiplier: state.maxMultiplier,
      flowSeconds: Math.round(state.flowSeconds),
      streakSeconds: Math.round(state.streakSeconds),
      totalSeconds: Math.round(state.totalSeconds),
      distanceAtFlow: Math.round(state.distanceAtFlow),
      pushes: state.pushes,
      barSpm: state.barSpm === null ? null : Math.round(state.barSpm * 10) / 10,
      refSpm: state.refSpm === null ? null : Math.round(state.refSpm * 10) / 10,
      liftSpm: Math.round(state.liftSpm * 10) / 10,
      // The race against the ghost of the best run, if there was one.
      ghost: state.ghostResult ? {
        gapM: state.ghostResult.gapM,
        at: state.ghostResult.at,
        playerDistance: state.ghostResult.playerDistance,
        ghostDistance: state.ghostResult.ghostDistance
      } : null,
      // The livery the boat wore, if there was one.
      livery: state.livery ? {
        key: state.livery.key,
        name: state.livery.name,
        changed: !!state.liveryChanged
      } : null,
      dailyPar: state.dailyPar ? {
        key: state.dailyPar.key,
        chainPar: state.dailyPar.chainPar,
        pushPar: state.dailyPar.pushPar,
        reached: !!state.dailyParReached
      } : null
    };
  }

  // The chain as a 0..1 proportion, for the scene. Zero means the chain
  // is empty, one means it is full. The scene uses it to move faster and
  // look better - never to tell the rower anything.
  function chainLevel(state) {
    return clamp(state.heat / (MAX_MULTIPLIER - 1), 0, 1);
  }

  return {
    VERSION: VERSION,
    createRun: createRun,
    reset: reset,
    tick: tick,
    summarize: summarize,
    chainLevel: chainLevel,
    setDailyPar: setDailyPar,
    setLivery: setLivery,
    setGhostResult: setGhostResult,
    // Exposed for tests.
    _internals: {
      TIER_S: TIER_S,
      MAX_MULTIPLIER: MAX_MULTIPLIER,
      BAR_OFFSET_SPM: BAR_OFFSET_SPM,
      LIFT_PER_TIER_SPM: LIFT_PER_TIER_SPM,
      LIFT_EXPONENT: LIFT_EXPONENT,
      REF_WINDOW_S: REF_WINDOW_S,
      MIN_REF_SAMPLES: MIN_REF_SAMPLES,
      SHORT_WINDOW_S: SHORT_WINDOW_S,
      DECAY_STEP_S: DECAY_STEP_S,
      PUSH_EXCESS_SPM: PUSH_EXCESS_SPM,
      FLOW_GRACE_S: FLOW_GRACE_S,
      PUSH_MIN_S: PUSH_MIN_S,
      PUSH_COOLDOWN_S: PUSH_COOLDOWN_S,
      SCORE_PER_METER: SCORE_PER_METER,
      TIER_BONUS: TIER_BONUS,
      PUSH_BONUS: PUSH_BONUS
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RunScore;
}
