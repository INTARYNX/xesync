// =====================================================================
// game_modes_view.js - the three ways to row, on the screen that waits
// for the first stroke.
//
// That screen has a job of its own: the rower is asked not to row yet,
// because a session always starts cold - the score, the chain and the
// lift all begin at zero whatever was done before. And it holds the
// choice.
//
// It is a screen of its own, not a card over the scene: the rowing
// screen belongs to the session, and the rower should not have to look
// at a panel of choices to reach the water.
//
// Reads what controller.js hands it, decides nothing itself - same
// contract as coaching_view.js.
// =====================================================================

var GameModesView = (function () {
  'use strict';

  function panel() { return document.getElementById('game-panel'); }
  function rowsHost() { return document.getElementById('game-panel-rows'); }

  // One choice: a label, a line of explanation, and the mark that says
  // this is the one. The explanation is not decoration - a choice
  // nobody understands is a choice nobody makes.
  function makeRow(mode, selected, onClick) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'gi-row' + (selected ? ' selected' : '');
    row.setAttribute('aria-pressed', selected ? 'true' : 'false');

    var text = document.createElement('div');
    text.className = 'gi-text';

    var name = document.createElement('div');
    name.className = 'gi-label';
    name.textContent = mode.label;
    text.appendChild(name);

    var sub = document.createElement('div');
    sub.className = 'gi-hint';
    sub.textContent = mode.hint;
    text.appendChild(sub);

    row.appendChild(text);

    var mark = document.createElement('span');
    mark.className = 'gi-mark';
    row.appendChild(mark);

    row.addEventListener('click', onClick);
    return row;
  }

  // The rows are built once - the ways to row do not change while the
  // app runs - and only the selected one is refreshed afterwards.
  function buildRows() {
    var host = rowsHost();
    if (!host || typeof GameModes === 'undefined') return;
    host.innerHTML = '';

    for (var i = 0; i < GameModes.MODES.length; i++) {
      (function (mode) {
        host.appendChild(makeRow(mode, false, function () {
          chooseGameMode(mode.key);
        }));
      })(GameModes.MODES[i]);
    }
  }

  // The state of every choice, as the game sees it.
  function render(selected) {
    var host = rowsHost();
    if (!host || !selected || typeof GameModes === 'undefined') return;
    var rows = host.getElementsByClassName('gi-row');
    for (var i = 0; i < rows.length && i < GameModes.MODES.length; i++) {
      var on = GameModes.MODES[i].key === selected;
      rows[i].classList.toggle('selected', on);
      rows[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // The screen that waits for the first stroke: the choices are built
  // and show what the rower chose last time.
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
