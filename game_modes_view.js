// =====================================================================
// game_modes_view.js - the switches of the game layer, on the screen
// that waits for the first stroke.
//
// That screen has a job of its own: the rower is asked not to row yet,
// because a session always starts cold - the score, the chain and the
// lift all begin at zero whatever was done before. And it holds the
// switches.
//
// It is a screen of its own, not a card over the scene: the rowing
// screen belongs to the session, and the rower should not have to look
// at a panel of switches to reach the water.
//
// Reads what controller.js hands it, decides nothing itself - same
// contract as coaching_view.js.
// =====================================================================

var GameModesView = (function () {
  'use strict';

  function panel() { return document.getElementById('game-panel'); }
  function rowsHost() { return document.getElementById('game-panel-rows'); }

  // One row: a label, a line of explanation, and a switch. The
  // explanation is not decoration - a switch nobody understands is a
  // switch nobody touches.
  function makeRow(label, hint, isOn, onClick) {
    var row = document.createElement('div');
    row.className = 'gi-row';

    var text = document.createElement('div');
    text.className = 'gi-text';

    var name = document.createElement('div');
    name.className = 'gi-label';
    name.textContent = label;
    text.appendChild(name);

    var sub = document.createElement('div');
    sub.className = 'gi-hint';
    sub.textContent = hint;
    text.appendChild(sub);

    row.appendChild(text);

    var sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'gi-switch' + (isOn ? ' on' : '');
    sw.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    sw.setAttribute('aria-label', label);
    sw.addEventListener('click', onClick);
    row.appendChild(sw);

    return row;
  }

  // The rows are built once - the features do not change while the app
  // runs - and only their state is refreshed afterwards.
  function buildRows() {
    var host = rowsHost();
    if (!host) return;
    host.innerHTML = '';

    // The coaching mode comes first: it is the app's mode, and every
    // other switch follows it until the rower says otherwise.
    host.appendChild(makeRow(
      'COACHING',
      'the coaching messages, the milestones and the challenges',
      !isCalmMode(),
      function () { toggleCoachingMode(); }
    ));

    if (typeof GameModes === 'undefined') return;
    for (var i = 0; i < GameModes.FEATURES.length; i++) {
      (function (f) {
        host.appendChild(makeRow(f.label, f.hint, false, function () {
          toggleGameFeature(f.key);
        }));
      })(GameModes.FEATURES[i]);
    }
  }

  function isCalmMode() {
    return typeof Coaching !== 'undefined' && Coaching.getMode() === 'justRow';
  }

  // The state of every switch, as the game sees it.
  function render(resolved) {
    var host = rowsHost();
    if (!host || !resolved) return;
    var switches = host.getElementsByClassName('gi-switch');

    // The first switch is the coaching mode, the rest are the features
    // in the order they were built.
    if (switches.length) {
      setSwitch(switches[0], !isCalmMode());
    }
    if (typeof GameModes !== 'undefined') {
      for (var i = 0; i < GameModes.FEATURES.length; i++) {
        var idx = i + 1;
        if (switches[idx]) setSwitch(switches[idx], !!resolved[GameModes.FEATURES[i].key]);
      }
    }
  }

  function setSwitch(sw, on) {
    sw.classList.toggle('on', !!on);
    sw.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // The screen that waits for the first stroke: the card is built and
  // shows the state the rower chose last time.
  function showWaiting() {
    buildRows();
    if (typeof renderGameModes === 'function') renderGameModes();
  }

  // The session has started: the screen goes away with it, and the game
  // keeps whatever the rower chose.
  function hideWaiting() {}

  return {
    showWaiting: showWaiting,
    hideWaiting: hideWaiting,
    render: render
  };
})();
