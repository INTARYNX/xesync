// =====================================================================
// coaching_view.js - DOM rendering for the coaching overlay: a short
// message banner and a live mini-challenge indicator, layered above the
// WebGL rowing scene (see coaching.css for stacking). Reads what
// coaching.js/controller.js hand it, decides nothing itself - same
// contract as view.js.
// =====================================================================

var CoachingView = (function () {
  'use strict';

  var MESSAGE_DISPLAY_MS = 4000;
  var hideTimer = null;

  function ensureEl(id, className) {
    var el = document.getElementById(id);
    if (el) return el;
    el = document.createElement('div');
    el.id = id;
    el.className = className;
    var wrapper = document.getElementById('wrapper');
    (wrapper || document.body).appendChild(el);
    return el;
  }

  function showMessage(text) {
    if (!text) return;
    var el = ensureEl('coaching-banner', 'coaching-banner');
    el.textContent = text;
    el.classList.add('visible');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { el.classList.remove('visible'); }, MESSAGE_DISPLAY_MS);
  }

  function hideMessage() {
    var el = document.getElementById('coaching-banner');
    if (el) el.classList.remove('visible');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function cadenceWindowS() {
    return (typeof Coaching !== 'undefined' && Coaching._internals && Coaching._internals.CADENCE_WINDOW_S) || 30;
  }

  var STATUS_CLASSES = ['status-ahead', 'status-behind', 'status-onpace', 'status-inrange', 'status-outrange'];

  // Live status during the effort (not just at the end) so the person can
  // actually correct course mid-challenge, not just find out afterwards.
  function renderChallenge(challenge) {
    var el = ensureEl('coaching-challenge', 'coaching-challenge');
    if (!challenge) { el.classList.remove('visible'); return; }
    STATUS_CLASSES.forEach(function (c) { el.classList.remove(c); });

    var label;
    if (challenge.phase === 'announce') {
      label = 'Get ready… ' + (challenge.countdownS != null ? challenge.countdownS : '') + 's';
    } else if (challenge.kind === 'cadence') {
      var left = Math.max(0, Math.round(cadenceWindowS() - challenge.totalS));
      label = challenge.targetSpm + '+ spm · ' + left + 's';
      if (challenge.lastSpm != null) {
        el.classList.add(challenge.lastSpm >= challenge.targetSpm ? 'status-inrange' : 'status-outrange');
      }
    } else {
      var covered = Math.max(0, Math.round((challenge.lastDistance || challenge.startDistance) - challenge.startDistance));
      var arrow = challenge.paceStatus === 'ahead' ? ' ↑' : challenge.paceStatus === 'behind' ? ' ↓' : '';
      label = covered + ' / ' + challenge.target + ' m' + arrow;
      if (challenge.paceStatus) el.classList.add('status-' + (challenge.paceStatus === 'onPace' ? 'onpace' : challenge.paceStatus));
    }
    el.textContent = label;
    el.classList.add('visible');
  }

  function hideChallenge() {
    var el = document.getElementById('coaching-challenge');
    if (el) el.classList.remove('visible');
  }

  function reset() {
    hideMessage();
    hideChallenge();
  }

  return {
    showMessage:    showMessage,
    hideMessage:    hideMessage,
    renderChallenge: renderChallenge,
    hideChallenge:  hideChallenge,
    reset:          reset
  };
})();

if (typeof window !== 'undefined') window.CoachingView = CoachingView;
