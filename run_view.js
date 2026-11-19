// =====================================================================
// run_view.js - the DOM for the game layer.
//
// Same contract as coaching_view.js: it renders, it decides nothing. It
// is handed the run state produced by run_score.js and draws it. All
// the rules live in run_score.js; all the orchestration in controller.js.
//
// The HUD is deliberately quiet, the way Alto's score counter is: a
// number, a ring that fills as the chain grows, and nothing else. No
// message, no banner, no celebration - the game is seen, not heard.
//
// The chip is hidden in the calm mode (Coaching 'justRow'), because that
// mode promises a screen with nothing but the measures.
// =====================================================================

var RunView = (function () {
  'use strict';

  // Radius of the chain ring, in the SVG's own units.
  var RING_R = 26;
  var RING_C = 2 * Math.PI * RING_R;

  var root = null;
  var scoreEl = null;
  var multEl = null;
  var ringEl = null;
  var liftEl = null;
  var parEl = null;
  var pushDotsEl = null;
  var pushDots = [];
  var dailyCourse = null;
  var hidden = false;

  function el(id) { return document.getElementById(id); }

  // Called once, when the rowing screen is entered.
  function mount() {
    root = el('run-hud');
    if (!root) return;
    scoreEl = el('run-score-value');
    multEl = el('run-chain-mult');
    ringEl = el('run-chain-ring');
    liftEl = el('run-lift-fill');
    parEl = el('run-chain-par');
    pushDotsEl = el('run-push-dots');
    if (ringEl) {
      ringEl.setAttribute('stroke-dasharray', RING_C);
      ringEl.setAttribute('stroke-dashoffset', RING_C);
    }
  }

  // Show or hide the whole chip. The calm mode hides it; the score is
  // still computed and still saved.
  function setVisible(v) {
    hidden = !v;
    if (!root) mount();
    if (root) root.style.display = v ? '' : 'none';
  }

  // The course of the day. Two marks, and not one word:
  //
  //   - a notch on the ring, at the angle where the day's chain par
  //     sits. The chain fills towards it, and nothing else is needed to
  //     know what today is;
  //   - one dot per push the day asks for, lighting up as they land.
  //
  // There is no label, no counter, no reminder. If the par is missed,
  // nothing happens at all.
  function setDailyCourse(course) {
    dailyCourse = course || null;
    if (!root) mount();

    if (parEl) {
      if (dailyCourse) {
        var f = DailyCourse.parFraction(dailyCourse.chainPar);
        // The ring fills clockwise from three o'clock; the notch starts
        // at twelve.
        var angle = f * 360 - 90;
        parEl.setAttribute('transform', 'rotate(' + angle.toFixed(2) + ' 32 32)');
        parEl.style.display = '';
      } else {
        parEl.style.display = 'none';
      }
    }

    if (pushDotsEl) {
      pushDotsEl.innerHTML = '';
      pushDots = [];
      if (dailyCourse) {
        for (var i = 0; i < dailyCourse.pushPar; i++) {
          var dot = document.createElement('span');
          dot.className = 'run-push-dot';
          pushDotsEl.appendChild(dot);
          pushDots.push(dot);
        }
        pushDotsEl.style.display = '';
      } else {
        pushDotsEl.style.display = 'none';
      }
    }
  }

  function fmtScore(n) {
    // No thousands separator: the counter ticks up, and a separator that
    // changes width makes it jitter.
    return String(Math.round(n));
  }

  // `state` is the run state from run_score.js.
  function render(state) {
    if (!root) mount();
    if (!root || !state) return;

    if (scoreEl) scoreEl.textContent = fmtScore(state.score);
    if (multEl) multEl.textContent = '×' + state.multiplier;

    // The ring fills with the progress towards the next tier: the
    // fractional part of the chain heat.
    if (ringEl) {
      var heat = state.heat || 0;
      var frac = heat - Math.floor(heat);
      if (state.multiplier >= MAX_MULTIPLIER_REACHED) frac = 1;
      ringEl.setAttribute('stroke-dashoffset', String(RING_C * (1 - frac)));
    }

    // The lift: how far above your own norm you are right now. It is
    // the thing the game is about, so it gets a shape of its own.
    if (liftEl) {
      var lift = state.liftSpm || 0;
      var pct = Math.max(0, Math.min(1, lift / LIFT_FULL_SCALE));
      liftEl.style.height = (pct * 100).toFixed(0) + '%';
      liftEl.style.opacity = lift > 0 ? '1' : '0.25';
    }

    // The ring turns green while there is a lift: the one piece of
    // colour that tells you, without a word, that you are above your
    // own pace.
    if (root) {
      root.classList.toggle('lifting', (state.liftSpm || 0) > 0);
    }

    // The day's marks: the notch lights up when the chain gets there,
    // the dots light up as the pushes land.
    if (parEl && dailyCourse) {
      parEl.classList.toggle('reached',
        (state.maxMultiplier || 1) >= dailyCourse.chainPar);
    }
    for (var i = 0; i < pushDots.length; i++) {
      pushDots[i].classList.toggle('lit', (state.pushes || 0) > i);
    }
  }

  function reset() {
    if (scoreEl) scoreEl.textContent = '0';
    if (multEl) multEl.textContent = '×1';
    if (ringEl) ringEl.setAttribute('stroke-dashoffset', String(RING_C));
    if (liftEl) { liftEl.style.height = '0%'; liftEl.style.opacity = '0.25'; }
    if (root) root.classList.remove('lifting');
    if (parEl) parEl.classList.remove('reached');
    for (var i = 0; i < pushDots.length; i++) {
      pushDots[i].classList.remove('lit');
    }
  }

  // The maximum multiplier the chain can reach, and the lift that counts
  // as a full bar. Both mirror run_score.js; the view only needs them to
  // draw a proportion.
  var MAX_MULTIPLIER_REACHED = 6;
  var LIFT_FULL_SCALE = 4;

  return {
    mount: mount,
    render: render,
    reset: reset,
    setVisible: setVisible,
    setDailyCourse: setDailyCourse,
    MAX_MULTIPLIER_REACHED: MAX_MULTIPLIER_REACHED,
    LIFT_FULL_SCALE: LIFT_FULL_SCALE
  };
})();
