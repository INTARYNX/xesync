// =====================================================================
// view.js - all DOM rendering. Reads `ui`, writes the DOM. Nothing here
// makes decisions, calls the network, or talks to the native bridge.
// render() is the single function that syncs the whole UI to `ui`.
// =====================================================================

function render() {
  // Active screen
  var activeId = SCREEN_IDS[ui.screen];
  Object.keys(SCREEN_IDS).forEach(function(name) {
    var el = document.getElementById(SCREEN_IDS[name]);
    if (el) el.classList.toggle('active', SCREEN_IDS[name] === activeId);
  });

  // Overlay (only the one named in ui.overlay)
  Object.keys(OVERLAY_IDS).forEach(function(name) {
    var el = document.getElementById(OVERLAY_IDS[name]);
    if (el) el.classList.toggle('visible', name === ui.overlay);
  });

  // Top bar visibility
  var bar = document.getElementById('topbar');
  var showBar = !FULLSCREEN[ui.screen];
  if (bar) bar.classList.toggle('visible', showBar);
  document.body.classList.toggle('with-bar', showBar);

  // Top bar buttons
  if (showBar) {
    var onConnecting = ui.screen === 'connecting';
    setDisplay('tbar-scan-btn',       !onConnecting && !ui.connected && !ui.scanning);
    setDisplay('tbar-debug-btn',      ui.debug && !onConnecting);
    setDisplay('tbar-row-btn',        ui.connected);
    setDisplay('tbar-disconnect-btn', ui.connected);
    setDisplay('tbar-coaching-btn',   ui.connected);
    var coachingBtn = document.getElementById('tbar-coaching-btn');
    if (coachingBtn) {
      var justRow = typeof Coaching !== 'undefined' && Coaching.getMode() === 'justRow';
      coachingBtn.textContent = justRow ? 'JUST ROW' : 'COACHING';
      coachingBtn.classList.toggle('accent', !justRow);
    }
  }

  // Scan sub-views
  setDisplay('scan-idle',   !ui.scanning, 'flex');
  setDisplay('scan-active',  ui.scanning, 'flex');

  // Offline prompts
  setDisplay('offline-notice',   ui.offline && ui.screen === 'login');
  setDisplay('scan-offline-msg', ui.offline);
}

function setDisplay(id, visible, displayValue) {
  var el = document.getElementById(id);
  if (!el) return;
  el.style.display = visible ? (displayValue || '') : 'none';
}

// -- State transitions (mutate ui, then render) ----------------------
function goScreen(name) {
  ui.overlay = null;
  ui.screen = name;
  render();
}

function openOverlay(name) {
  ui.overlay = name;
  render();
}

function closeOverlay() {
  ui.overlay = null;
  render();
}

// -- Small view helpers ----------------------------------------------
function setUserBadge(username) {
  var el = document.getElementById('tbar-user');
  if (!el) return;
  el.innerHTML = username
    ? '<div class="tbar-avatar">' + username.slice(0, 2).toUpperCase() + '</div>'
    : '';
}

function setLoginStatus(msg) {
  var el = document.getElementById('login-status');
  if (el) el.textContent = msg;
}

function setRegisterStatus(msg, ok) {
  var el = document.getElementById('register-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? '#00A2E8' : '#f44336';
}

function setConnectingLabel(text) {
  var el = document.getElementById('connecting-label');
  if (el) el.textContent = text;
}

function showLoadingOverlay() {
  var el = document.getElementById('loading-overlay');
  if (el) el.classList.add('visible');
}

function hideLoadingOverlay() {
  var el = document.getElementById('loading-overlay');
  if (el) el.classList.remove('visible');
}

// Render the scanning sub-view in its "searching" state
function renderScanSearching() {
  document.getElementById('device-list').innerHTML = '';
  document.getElementById('pulse-ring').style.display = '';
  document.getElementById('scan-label').textContent = 'SCANNING...';
}

// Render the list of found devices; onPick(device) is called on tap
function renderDeviceList(devices, onPick) {
  document.getElementById('pulse-ring').style.display = 'none';
  document.getElementById('scan-label').textContent = 'SELECT ROWER';
  var list = document.getElementById('device-list');
  list.innerHTML = '';
  if (!devices.length) {
    list.innerHTML = '<div class="empty-msg">No rower found</div>';
    return;
  }
  devices.forEach(function(d) {
    var item = document.createElement('div');
    item.className = 'device-item';
    item.innerHTML = '<span>' + escHtml(d.name) + '</span>' +
                     '<span class="device-rssi">' + escHtml(d.id) + '</span>';
    item.onclick = function() { onPick(d); };
    list.appendChild(item);
  });
}

// Fill the post-workout overlay text + workouts button visibility, plus the
// coaching highlights and splits table when the session produced them.
// splitsTable/coachingSummary are undefined for a workout saved before this
// feature existed - both render blocks just stay hidden in that case.
function renderPostWorkout(savedState, hasToken, splitsTable, coachingSummary) {
  var title = document.getElementById('pw-title');
  var sub   = document.getElementById('pw-subtitle');
  if (savedState === 'online') {
    title.textContent = 'WORKOUT SAVED';
    sub.textContent   = 'synced to your account';
  } else if (savedState === 'offline') {
    title.textContent = 'WORKOUT SAVED';
    sub.textContent   = 'stored offline, will sync on next login';
  } else if (savedState === 'error') {
    title.textContent = 'SAVE FAILED';
    sub.textContent   = 'could not store your workout';
  } else {
    title.textContent = 'WORKOUT ENDED';
    sub.textContent   = 'not saved';
  }
  document.getElementById('pw-workouts-btn').style.display = hasToken ? '' : 'none';

  renderCoachingSummary(coachingSummary);
  renderSplitsTable(splitsTable);
}

// Same stroke-line SVG style as the HUD tiles (rowing_display.html) - not a
// new icon language, just reused at a smaller size.
var PW_ICON = {
  target:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>',
  bars:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="20" x2="6" y2="14"/><line x1="12" y1="20" x2="12" y2="8"/><line x1="18" y1="20" x2="18" y2="4"/></svg>',
  sprint:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  cadence: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
  check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
};

// A separate section from the splits table on purpose - real measured
// numbers per challenge attempt (time, distance covered, seconds in range),
// not folded into the distance-split rows below.
function renderCoachingSummary(summary) {
  var el = document.getElementById('pw-coaching-summary');
  if (!el) return;
  if (!summary || !summary.challenges || !summary.challenges.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  var cards = summary.challenges.map(function (c) {
    var cls = c.outcome === 'success' ? ' success' : '';
    var icon = c.kind === 'distance' ? PW_ICON.sprint : PW_ICON.cadence;
    var pill = c.outcome === 'success'
      ? '<span class="pw-pill success">' + PW_ICON.check + 'Success</span>'
      : '<span class="pw-pill">Not completed</span>';
    return '<div class="pw-challenge-card' + cls + '">'
      + '<div class="pw-challenge-icon">' + icon + '</div>'
      + '<div class="pw-challenge-body">'
      +   '<div class="pw-challenge-row">'
      +     '<div class="pw-challenge-title">' + escHtml(c.title) + '</div>' + pill
      +   '</div>'
      +   '<div class="pw-challenge-detail">' + escHtml(c.detail) + '</div>'
      + '</div>'
      + '</div>';
  }).join('');
  el.innerHTML = '<div class="pw-section-label">' + PW_ICON.target + '<span>CHALLENGES</span></div>' + cards;
  el.style.display = '';
}

function renderSplitsTable(splitsTable) {
  var el = document.getElementById('pw-splits-table');
  if (!el) return;
  if (!splitsTable || !splitsTable.rows || !splitsTable.rows.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  // Fixed 500m splits, like a PM5 - challenge results are reported
  // separately (renderCoachingSummary above), this table has no idea a
  // sprint or a milestone even happened.
  var rowsHtml = splitsTable.rows.map(function (r, i) {
    var distCell = r.insufficientData ? '<span class="pw-insufficient">insufficient data</span>' : escHtml(r.distance);
    return '<tr>'
      + '<td class="pw-split-num">' + (i + 1) + '</td>'
      + '<td>' + escHtml(r.duration) + '</td>'
      + '<td>' + distCell + '</td>'
      + '<td>' + escHtml(r.pace) + '</td>'
      + '<td>' + escHtml(String(r.cadence)) + '</td>'
      + '<td>' + escHtml(String(r.hr)) + '</td>'
      + '</tr>';
  }).join('');

  el.innerHTML =
    '<div class="pw-section-label">' + PW_ICON.bars + '<span>SPLITS</span>'
      + '<span class="pw-split-count">' + splitsTable.rows.length + ' split' + (splitsTable.rows.length === 1 ? '' : 's') + '</span></div>' +
    '<div class="pw-splits-card">' +
      '<table class="pw-splits">' +
        '<thead><tr><th></th><th>TIME</th><th>DIST</th><th>/500M</th><th>S/M</th><th>HR</th></tr></thead>' +
        '<tbody>' +
          '<tr class="pw-splits-total">' +
            '<td class="pw-split-num">–</td>' +
            '<td>' + escHtml(splitsTable.total.duration) + '</td>' +
            '<td>' + escHtml(splitsTable.total.distance) + '</td>' +
            '<td>' + escHtml(splitsTable.total.pace) + '</td>' +
            '<td>' + escHtml(String(splitsTable.total.cadence)) + '</td>' +
            '<td>' + escHtml(String(splitsTable.total.hr)) + '</td>' +
          '</tr>' +
          rowsHtml +
        '</tbody>' +
      '</table>' +
    '</div>';
  el.style.display = '';
}

function hideBootSplash() {
  var s = document.getElementById('boot-splash');
  if (!s) return;
  s.classList.add('hidden');
  setTimeout(function() { if (s.parentNode) s.parentNode.removeChild(s); }, 300);
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
