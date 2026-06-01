/**
 * FTMS Integration — session tracking + display sync
 *
 * Public API (called from app.html):
 *   initFtmsTracking()  — call when entering rowing screen
 *   ingestData(csv)     — call for each FTMS packet (20 comma-separated bytes)
 *   saveWorkout()       — save and end session
 *   exitSession()       — discard and end session
 *
 * Callback (must be set by app.html):
 *   window.onWorkoutComplete(savedState)
 *     savedState: 'online' | 'offline' | null (not saved)
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────
  // Config
  // ─────────────────────────────────────────────────────────────────────
  var INACTIVITY_MS   = 5000;
  var INACTIVITY_TICK = 500;
  var INITIAL_PACE    = 150;
  var PACE_WINDOW_MS  = 30000;
  var DEBUG = new URLSearchParams(window.location.search).get('debug') === 'true';

  // ─────────────────────────────────────────────────────────────────────
  // Visual debug log (only active when ?debug=true)
  // ─────────────────────────────────────────────────────────────────────
  var dbgEl = null;
  function dbg(msg) {
    if (!DEBUG) return;
    if (!dbgEl) {
      dbgEl = document.createElement('div');
      dbgEl.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:160px;overflow-y:auto;' +
        'background:rgba(0,0,0,0.85);color:#0f0;font-size:10px;font-family:monospace;' +
        'padding:4px 6px;z-index:9999;pointer-events:none;';
      document.body.appendChild(dbgEl);
    }
    var t = new Date();
    var ts = (t.getMinutes()<10?'0':'')+t.getMinutes()+':'+(t.getSeconds()<10?'0':'')+t.getSeconds();
    var line = document.createElement('div');
    line.textContent = '[' + ts + '] ' + msg;
    dbgEl.appendChild(line);
    dbgEl.scrollTop = dbgEl.scrollHeight;
    // Keep max 30 lines
    while (dbgEl.children.length > 30) dbgEl.removeChild(dbgEl.firstChild);
  }

  // ─────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────
  var phase = 'IDLE';
  var session = null;
  var lastPacket = null;
  var lastActiveAt = 0;
  var inactivityTimerId = null;

  function resetSession() {
    session = {
      startedAt:     null,
      totalPausedMs: 0,
      pausedAt:      null,
      distOffset:    0,
      strokeOffset:  0,
      calOffset:     0,
      rawDist:       0,
      rawStrokes:    0,
      rawCals:       0,
      paceSeconds:   INITIAL_PACE,
      paceHistory:   [],
      samples:       []
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Parsing — Xebex FTMS: 20 bytes, big = byte[hi]*255 + byte[lo]
  // ─────────────────────────────────────────────────────────────────────
  function parsePacket(csv) {
    if (!csv) return null;
    var b = csv.split(',').map(function (s) { return parseInt(s, 10); });
    if (b.length < 20 || b.some(isNaN)) return null;
    var u16 = function (hi, lo) { return b[hi] * 255 + b[lo]; };
    return {
      t:        Date.now(),
      spm:      b[2] * 0.5,
      strokes:  u16(4, 3),
      distance: u16(6, 5),
      pace:     u16(9, 8),
      watts:    u16(11, 10),
      cals:     u16(13, 12),
      hr:       b[16],
      elapsed:  u16(19, 18)
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Session math
  // ─────────────────────────────────────────────────────────────────────
  function applyResetIfNeeded(p) {
    if (p.distance < session.rawDist)    session.distOffset   += session.rawDist;
    if (p.strokes  < session.rawStrokes) session.strokeOffset += session.rawStrokes;
    if (p.cals     < session.rawCals)    session.calOffset    += session.rawCals;
    session.rawDist    = p.distance;
    session.rawStrokes = p.strokes;
    session.rawCals    = p.cals;
  }

  function totalDistance() { return session.distOffset   + session.rawDist; }
  function totalStrokes()  { return session.strokeOffset + session.rawStrokes; }
  function totalCals()     { return session.calOffset    + session.rawCals; }

  function sessionSeconds() {
    if (!session || !session.startedAt) return 0;
    var now = Date.now();
    var pausedMs = session.totalPausedMs;
    if (session.pausedAt != null) pausedMs += (now - session.pausedAt);
    return (now - session.startedAt - pausedMs) / 1000;
  }

  function updatePace(prev, curr) {
    var now = curr.t;
    var currentTotalDist = totalDistance();
    session.paceHistory.push({ t: now, dist: currentTotalDist });
    var cutoff = now - PACE_WINDOW_MS;
    while (session.paceHistory.length > 0 && session.paceHistory[0].t < cutoff) {
      session.paceHistory.shift();
    }
    if (session.paceHistory.length < 2) return;
    var oldestPoint = session.paceHistory[0];
    var dDist = currentTotalDist - oldestPoint.dist;
    var dTime = (now - oldestPoint.t) / 1000;
    if (dDist > 0 && dTime > 0.5) {
      var averagePace = (dTime / dDist) * 500;
      if (isFinite(averagePace) && averagePace > 0) session.paceSeconds = averagePace;
    }
  }

  function recordSample(p) {
    var now = sessionSeconds();
    var last = session.samples.length ? session.samples[session.samples.length - 1] : null;
    if (last && now - last.time < 1.0) return;
    session.samples.push({
      time:     now,
      distance: totalDistance(),
      strokes:  totalStrokes(),
      spm:      p.spm,
      watts:    p.watts,
      hr:       p.hr === 255 ? null : p.hr,
      pace:     session.paceSeconds
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Display
  // ─────────────────────────────────────────────────────────────────────
  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function paceToAnimSpeed(paceSec) {
    if (!paceSec || paceSec <= 0) return 0;
    return (500 / paceSec) * 0.8;
  }

  function render() {
    if (!lastPacket) return;
    setText('heartrate',   lastPacket.hr === 255 ? '-' : lastPacket.hr);
    setText('distance',    totalDistance());
    setText('watts',       Math.round(lastPacket.watts));
    setText('pace',        fmtTime(session.paceSeconds));
    setText('spm',         Math.round(lastPacket.spm));
    setText('cals',        totalCals());
    setText('strokes',     totalStrokes());
    setText('elapsedtime', fmtTime(sessionSeconds()));
    if (typeof setConsoleSpeedAndSpm === 'function') {
      setConsoleSpeedAndSpm(paceToAnimSpeed(session.paceSeconds), lastPacket.spm);
    }
  }

  function renderIdle() {
    setText('heartrate',   '-');
    setText('distance',    '0');
    setText('watts',       '0');
    setText('pace',        '--:--');
    setText('spm',         '0.0');
    setText('cals',        '0');
    setText('strokes',     '0');
    setText('elapsedtime', '00:00');
    if (typeof setConsoleSpeedAndSpm === 'function') setConsoleSpeedAndSpm(0, 0);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Status banner
  // ─────────────────────────────────────────────────────────────────────
  function ensureBanner() {
    var el = document.getElementById('ftmsBanner');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ftmsBanner';
    document.body.appendChild(el);
    return el;
  }
  function showBanner(text) {
    var el = ensureBanner();
    el.textContent = text;
    el.classList.add('visible');
  }
  function hideBanner() {
    var el = document.getElementById('ftmsBanner');
    if (el) el.classList.remove('visible');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Pause dialog — SAVE or EXIT SESSION
  // ─────────────────────────────────────────────────────────────────────
  function tile(id, label, val) {
    return '<div class="ftms-summary-tile">'
      + '<div class="ftms-summary-label">' + label + '</div>'
      + '<div id="' + id + '" class="ftms-summary-value">' + val + '</div>'
      + '</div>';
  }

  function ensurePauseDialog() {
    if (document.getElementById('pauseDialog')) return;
    var html = ''
      + '<div id="pauseDialog" class="ftms-overlay">'
      +   '<div class="ftms-overlay-title">PAUSED</div>'
      +   '<div class="ftms-overlay-subtitle">row again to continue</div>'
      +   '<div class="ftms-summary-grid">'
      +     tile('summaryTime',     'TIME',     '00:00')
      +     tile('summaryDistance', 'DISTANCE', '0m')
      +     tile('summaryStrokes',  'STROKES',  '0')
      +     tile('summaryCalories', 'CALORIES', '0')
      +   '</div>'
      +   '<div class="ftms-actions">'
      +     '<button class="ftms-btn primary"   onclick="saveWorkout()">SAVE</button>'
      +     '<button class="ftms-btn secondary" onclick="exitSession()">EXIT SESSION</button>'
      +   '</div>'
      + '</div>';
    document.body.insertAdjacentHTML('beforeend', html);
  }

  function showPauseDialog() {
    ensurePauseDialog();
    setText('summaryTime',     fmtTime(sessionSeconds()));
    setText('summaryDistance', totalDistance() + 'm');
    setText('summaryStrokes',  totalStrokes());
    setText('summaryCalories', totalCals());
    document.getElementById('pauseDialog').classList.add('visible');
  }

  function hidePauseDialog() {
    var el = document.getElementById('pauseDialog');
    if (el) el.classList.remove('visible');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase transitions
  // ─────────────────────────────────────────────────────────────────────
  function goActive() {
    if (phase === 'ACTIVE') return;
    if (phase === 'PAUSED') {
      if (session.pausedAt != null) {
        session.totalPausedMs += (Date.now() - session.pausedAt);
        session.pausedAt = null;
      }
      hidePauseDialog();
      hideBanner();
      phase = 'ACTIVE';
      lastActiveAt = Date.now();
      dbg('RESUMED');
      return;
    }
    // Fresh start — capture rower baseline so counters always start from 0
    resetSession();
    if (lastPacket) {
      session.distOffset   = -lastPacket.distance;
      session.strokeOffset = -lastPacket.strokes;
      session.calOffset    = -lastPacket.cals;
      session.rawDist      = lastPacket.distance;
      session.rawStrokes   = lastPacket.strokes;
      session.rawCals      = lastPacket.cals;
      dbg('START baseline dist=' + lastPacket.distance + ' spm=' + lastPacket.spm);
    } else {
      dbg('START no baseline');
    }
    session.startedAt = Date.now();
    lastActiveAt = Date.now();
    phase = 'ACTIVE';
    hideBanner();
    hidePauseDialog();
  }

  function goPaused() {
    if (phase !== 'ACTIVE') return;
    session.pausedAt = Date.now();
    phase = 'PAUSED';
    dbg('PAUSED');
    if (typeof setConsoleSpeedAndSpm === 'function') setConsoleSpeedAndSpm(0, 0);
    showPauseDialog();
  }

  function goIdle() {
    phase = 'IDLE';
    resetSession();
    lastPacket = null;
    renderIdle();
    hidePauseDialog();
    hideBanner();
    dbg('IDLE');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Inactivity watchdog
  // ─────────────────────────────────────────────────────────────────────
  function tickInactivity() {
    if (phase !== 'ACTIVE') return;
    if (Date.now() - lastActiveAt > INACTIVITY_MS) goPaused();
  }

  function stopWatchdog() {
    if (inactivityTimerId) { clearInterval(inactivityTimerId); inactivityTimerId = null; }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────
  function initFtmsTracking() {
    ensurePauseDialog();
    stopWatchdog();
    inactivityTimerId = setInterval(tickInactivity, INACTIVITY_TICK);
    goIdle();
    showBanner('READY TO ROW !');
  }

  function ingestData(csv) {
    if (typeof csv === 'string' && csv.indexOf('#data=') === 0) {
      csv = decodeURIComponent(csv.slice(6));
    }
    var p = parsePacket(csv);
    if (!p) return;

    var prev = lastPacket;

    dbg('pkt spm=' + p.spm + ' dist=' + p.distance + ' phase=' + phase);

    if (phase === 'IDLE') {
      if (p.spm > 0) { lastPacket = p; goActive(); } else return;
    } else if (phase === 'PAUSED') {
      if (p.spm > 0) { lastPacket = p; goActive(); } else return;
    } else {
      lastPacket = p;
    }

    applyResetIfNeeded(p);
    updatePace(prev, p);
    if (p.spm > 0) {
      lastActiveAt = Date.now();
      recordSample(p);
    }
    render();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Save / exit — notify app.html via onWorkoutComplete(savedState)
  // ─────────────────────────────────────────────────────────────────────
  function avg(arr, key) {
    if (!arr.length) return 0;
    var s = 0, n = 0;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i][key] == null) continue;
      s += arr[i][key]; n++;
    }
    return n ? s / n : 0;
  }

  function buildPayload() {
    var s = session.samples;
    return {
      version: 1,
      summary: {
        duration: Math.round(sessionSeconds()),
        distance: totalDistance(),
        strokes:  totalStrokes(),
        calories: totalCals(),
        avgSpm:   Math.round(avg(s, 'spm')   * 10) / 10,
        avgPace:  Math.round(avg(s, 'pace')),
        avgWatts: Math.round(avg(s, 'watts')),
        avgHr:    Math.round(avg(s, 'hr'))
      },
      samples: s.map(function (x) {
        return [
          Math.round(x.time * 10) / 10,
          Math.round(x.distance),
          x.strokes,
          Math.round(x.spm * 10) / 10,
          Math.round(x.watts),
          x.hr == null ? null : Math.round(x.hr),
          Math.round(x.pace)
        ];
      })
    };
  }

  function workoutTag() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return 'workout_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function getAppInventor() {
    return (typeof AppInventor !== 'undefined' && AppInventor.setWebViewString)
      ? AppInventor
      : (typeof window.AppInventor !== 'undefined' && window.AppInventor.setWebViewString)
        ? window.AppInventor : null;
  }

  function notifyComplete(savedState) {
    if (typeof window.onWorkoutComplete === 'function') {
      window.onWorkoutComplete(savedState);
    }
  }

  function saveWorkout() {
    hidePauseDialog();
    stopWatchdog();
    phase = 'IDLE';
    var payload = buildPayload();
    var token = typeof appToken !== 'undefined' ? appToken : null;

    showBanner('SAVING...');

    if (!token) {
      var tag = workoutTag();
      var ai = getAppInventor();
      if (ai) {
        ai.setWebViewString(JSON.stringify({ action: 'saveData', workout: tag, data: payload }));
      }
      goIdle();
      setTimeout(function () {
        hideBanner();
        notifyComplete('offline');
      }, 1200);
      return;
    }

    var body = JSON.stringify({ token: token, workout: workoutTag(), data: payload });
    var timeout = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('timeout')); }, 10000);
    });

    Promise.race([
      fetch(XESYNC_CONFIG.apiBaseUrl + '/rpc/save_workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      }).then(function (r) {
        return r.text().then(function (txt) { return { ok: r.ok, txt: txt }; });
      }),
      timeout
    ])
    .then(function (resp) {
      hideBanner();
      if (!resp.ok) { notifyComplete('offline'); return; }
      var json;
      try { json = JSON.parse(resp.txt); } catch (e) { notifyComplete('offline'); return; }
      var row = Array.isArray(json) ? json[0] : json;
      notifyComplete(row && row.status === 'success' ? 'online' : 'offline');
    })
    .catch(function () {
      hideBanner();
      notifyComplete('offline');
    });
  }

  function exitSession() {
    hidePauseDialog();
    hideBanner();
    stopWatchdog();
    phase = 'IDLE';
    notifyComplete(null);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Exports
  // ─────────────────────────────────────────────────────────────────────
  window.initFtmsTracking = initFtmsTracking;
  window.ingestData       = ingestData;
  window.saveWorkout      = saveWorkout;
  window.exitSession      = exitSession;

})();
