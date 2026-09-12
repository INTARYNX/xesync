// =====================================================================
// coaching_text.js - message catalog for the coaching module.
//
// English only for now (the app itself has no i18n yet - see
// AMELIORATIONS_PRODUIT.md section 1). Kept separate from coaching.js
// so a future translation pass never has to touch trigger logic, and a
// unit test can assert every textKey coaching.js emits resolves here.
// =====================================================================

var CoachingText = (function () {
  'use strict';

  // m:ss(.t) helper, kept local rather than shared with splits.js's
  // formatter - two small independent formatters are simpler than a shared
  // dependency between a text catalog and a calculation module.
  function fmtMinSec(sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return '--:--';
    var m = Math.floor(sec / 60);
    var s = Math.round(sec - m * 60);
    if (s === 60) { m += 1; s = 0; }
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  var CATALOG = {
    sessionStart:             function ()           { return 'Let\'s go. Find your rhythm.'; },
    firstKm:                  function ()           { return '1 km down!'; },
    milestoneReached:         function (m)          { return (m / 1000) + ' km covered. Nice work!'; },
    milestoneApproach:        function (left, m)    { return left + ' m to go before ' + (m / 1000) + ' km'; },
    durationMark:             function (minutes)    { return 'Already ' + minutes + ' minutes of rowing!'; },
    resumeAfterPause:         function ()           { return 'Back to it, at your own pace.'; },
    cadenceChallengeIntro:    function (targetSpm, countdownS) { return 'Mini-challenge in ' + countdownS + 's: push to ' + targetSpm + '+ spm for 30s'; },
    cadenceChallengeGo:       function ()           { return 'Go! Pick up the cadence.'; },
    cadenceChallengeSuccess:  function ()           { return '30 seconds at a higher cadence. Nice push!'; },
    cadenceChallengeNeutral:  function ()           { return 'Challenge over. Keep going at your pace.'; },
    distanceChallengeIntro:   function (meters, countdownS) { return 'Sprint ' + meters + ' m as fast as you can — go in ' + countdownS + 's!'; },
    distanceChallengeGo:      function ()           { return 'GO! Give it everything.'; },
    distanceChallengeSuccess: function (meters, elapsedS) { return meters + ' m in ' + fmtMinSec(elapsedS) + '!'; },
    distanceChallengeNeutral: function ()           { return 'Sprint over. Keep rowing at your pace.'; },
    // Post-workout recap only (see summarizeCoaching() in controller.js).
    // These are the CARD DETAIL line only - the card's title ("Sprint ·
    // 500 m" / "Cadence 20-24 spm") is built separately in controller.js
    // so view.js can render title and result as two distinct visual lines.
    sprintRecapFirst:      function (elapsedS) { return fmtMinSec(elapsedS) + ' · first time at this distance'; },
    sprintRecapBest:       function (elapsedS) { return fmtMinSec(elapsedS) + ' · new best!'; },
    sprintRecapBehind:     function (elapsedS, prevBestS) { return fmtMinSec(elapsedS) + ' · best: ' + fmtMinSec(prevBestS); },
    sprintRecapIncomplete: function (covered, target) { return covered + ' / ' + target + ' m · not completed'; },
    cadenceRecap:          function (inRangeS, totalS, success) {
      return inRangeS + '/' + totalS + 's above target' + (success ? ' · success' : '');
    }
  };

  function resolve(textKey, textArgs) {
    var fn = CATALOG[textKey];
    if (!fn) return '';
    return fn.apply(null, textArgs || []);
  }

  return { resolve: resolve, CATALOG: CATALOG };
})();

if (typeof window !== 'undefined') window.CoachingText = CoachingText;
