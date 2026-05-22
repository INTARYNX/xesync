/**
 * FTMS Integration — session tracking + display sync
 *
 * Public API (called from app.html):
 *   initFtmsTracking()  — call when entering rowing screen
 *   ingestData(csv)     — call for each FTMS packet (20 comma-separated bytes)
 *
 * Phases:
 *   IDLE   — no rowing yet, waiting for first stroke
 *   ACTIVE — rowing in progress
 *   DONE   — rower stopped for >5s with a real session → save dialog shown
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────
  // Config
  // ─────────────────────────────────────────────────────────────────────
  var INACTIVITY_MS    = 5000;   // ms of spm=0 before workout is "DONE"
  var MIN_SAVE_SECONDS = 5;      // minimum session length to show save dialog
  var INACTIVITY_TICK  = 500;    // how often to check for inactivity (ms)
  var INITIAL_PACE     = 150;    // s/500m when we have no real pace yet
  var PACE_EMA_ALPHA   = 0.3;    // new-sample weight in exponential smoothing
  var DEBUG            = false;

  // ─────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────
  var phase = 'IDLE';

  var session = null;            // see resetSession()
  var lastPacket = null;         // most recent parsed FTMS packet
  var lastActiveAt = 0;          // ms timestamp of last spm>0 packet
  var inactivityTimerId = null;

  function resetSession() {
    session = {
      startedAt:     null,
      frozenSeconds: null,    // set in goDone() to lock the clock
      // Session-level accumulators (added to current rower reading)
      distOffset:    0,
      strokeOffset:  0,
      calOffset:     0,
      // Last raw values from the rower (used to detect resets)
      rawDist:       0,
      rawStrokes:    0,
      rawCals:       0,
      // Smoothed pace
      paceSeconds:   INITIAL_PACE,
      // Sampled-per-packet log used to build the save payload
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
      t:         Date.now(),
      spm:       b[2] * 0.5,
      strokes:   u16(4, 3),
      distance:  u16(6, 5),
      pace:      u16(9, 8),   // raw pace from rower, s/500m
      watts:     u16(11, 10),
      cals:      u16(13, 12),
      hr:        b[16],
      elapsed:   u16(19, 18)
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Session math
  // ─────────────────────────────────────────────────────────────────────
  // Detect a rower reset (any monotonic counter dropped) and roll its
  // previous peak into the session offset, so totals keep climbing.
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
    if (!session) return 0;
    if (session.frozenSeconds != null) return session.frozenSeconds;
    return session.startedAt ? (Date.now() - session.startedAt) / 1000 : 0;
  }

  // Update smoothed pace based on real distance/time deltas between packets.
  function updatePace(prev, curr) {
    if (!prev) return; // need two points
    var dDist = (totalDistance()) - (session.distOffset + prev.distance);
    var dTime = (curr.t - prev.t) / 1000;
    if (dDist <= 0 || dTime < 0.1) return; // no movement
    var instant = (dTime / dDist) * 500;
    if (!isFinite(instant) || instant <= 0) return;
    session.paceSeconds = session.paceSeconds * (1 - PACE_EMA_ALPHA) + instant * PACE_EMA_ALPHA;
  }

  // Sample one entry per second of session time (the rower may emit packets
  // faster than that; we downsample to keep the save payload bounded — a 1h
  // session caps at ~3600 samples instead of growing unbounded).
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
      hr:       p.hr,
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
    return (500 / paceSec) * 0.8; // ~4.4 fast, ~2.2 slow
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
    setText('heartrate', '-');
    setText('distance',  '0');
    setText('watts',     '0');
    setText('pace',      '--:--');
    setText('spm',       '0.0');
    setText('cals',      '0');
    setText('strokes',   '0');
    setText('elapsedtime', '00:00');
    if (typeof setConsoleSpeedAndSpm === 'function') setConsoleSpeedAndSpm(0, 0);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Status banner (replaces full-screen popup)
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
  // Save dialog
  // ─────────────────────────────────────────────────────────────────────
  function ensureSaveDialog() {
    if (document.getElementById('saveDialog')) return;
    var html = ''
      + '<div id="saveDialog" class="ftms-overlay">'
      +   '<div class="ftms-overlay-title">WORKOUT COMPLETE</div>'
      +   '<div class="ftms-summary-grid">'
      +     tile('summaryTime',     'TIME',     '00:00')
      +     tile('summaryDistance', 'DISTANCE', '0m')
      +     tile('summaryStrokes',  'STROKES',  '0')
      +     tile('summaryCalories', 'CALORIES', '0')
      +   '</div>'
      +   '<div class="ftms-actions">'
      +     '<button class="ftms-btn primary"   onclick="saveWorkout()">SAVE DATA</button>'
      +     '<button class="ftms-btn secondary" onclick="restartWorkout()">START OVER</button>'
      +   '</div>'
      + '</div>';
    function tile(id, label, val) {
      return '<div class="ftms-summary-tile">'
        + '<div class="ftms-summary-label">' + label + '</div>'
        + '<div id="' + id + '" class="ftms-summary-value">' + val + '</div>'
        + '</div>';
    }
    document.body.insertAdjacentHTML('beforeend', html);
  }
  function showSaveDialog() {
    ensureSaveDialog();
    setText('summaryTime',     fmtTime(sessionSeconds()));
    setText('summaryDistance', totalDistance() + 'm');
    setText('summaryStrokes',  totalStrokes());
    setText('summaryCalories', totalCals());
    document.getElementById('saveDialog').classList.add('visible');
  }
  function hideSaveDialog() {
    var el = document.getElementById('saveDialog');
    if (el) el.classList.remove('visible');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Offline choice screen (shown after an offline save)
  // ─────────────────────────────────────────────────────────────────────
  function ensureOfflineChoice() {
    if (document.getElementById('offlineChoice')) return;
    var html = ''
      + '<div id="offlineChoice" class="ftms-overlay">'
      +   '<div class="ftms-overlay-title">WORKOUT SAVED</div>'
      +   '<div class="ftms-overlay-subtitle">stored offline</div>'
      +   '<div class="ftms-actions">'
      +     '<button class="ftms-btn primary" onclick="offlineChoiceRow()">ROW AGAIN</button>'
      +     '<button class="ftms-btn"         onclick="offlineChoiceLogin()">GO TO LOGIN</button>'
      +   '</div>'
      + '</div>';
    document.body.insertAdjacentHTML('beforeend', html);
  }
  function showOfflineChoice() {
    ensureOfflineChoice();
    document.getElementById('offlineChoice').classList.add('visible');
  }
  function hideOfflineChoice() {
    var el = document.getElementById('offlineChoice');
    if (el) el.classList.remove('visible');
  }
  function offlineChoiceRow() {
    hideOfflineChoice();
    goIdle();
  }
  function offlineChoiceLogin() {
    hideOfflineChoice();
    if (typeof doExit === 'function') doExit();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase transitions
  // ─────────────────────────────────────────────────────────────────────
  function goActive() {
    if (phase === 'ACTIVE') return;
    resetSession();
    session.startedAt = Date.now();
    lastActiveAt = Date.now();
    phase = 'ACTIVE';
    hideBanner();
    hideSaveDialog();
    if (DEBUG) console.log('[FTMS] phase → ACTIVE');
  }

  function goDone() {
    if (phase !== 'ACTIVE') return;
    session.frozenSeconds = (Date.now() - session.startedAt) / 1000 - INACTIVITY_MS / 1000;
    if (session.frozenSeconds < 0) session.frozenSeconds = 0;
    phase = 'DONE';
    hideBanner();
    if (typeof setConsoleSpeedAndSpm === 'function') setConsoleSpeedAndSpm(0, 0);
    if (session.frozenSeconds >= MIN_SAVE_SECONDS) {
      showSaveDialog();
    } else {
      goIdle();
    }
  }

  function goIdle() {
    phase = 'IDLE';
    resetSession();
    lastPacket = null;
    renderIdle();
    hideSaveDialog();
    // Only show "READY TO ROW" if we are actually on the rowing screen.
    // After a successful save, app.html shows the home iframe — no banner
    // should sit on top of it.
    var rowingScreen = document.getElementById('screen-rowing');
    if (rowingScreen && rowingScreen.classList.contains('active')) {
      showBanner('READY TO ROW !');
    } else {
      hideBanner();
    }
    if (DEBUG) console.log('[FTMS] phase → IDLE');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Inactivity watchdog — runs while ACTIVE
  // ─────────────────────────────────────────────────────────────────────
  function tickInactivity() {
    if (phase !== 'ACTIVE') return;
    if (Date.now() - lastActiveAt > INACTIVITY_MS) goDone();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────
  function ingestData(csv) {
    // App.html passes us either the raw CSV or a "#data=..." hash. Strip prefix.
    if (typeof csv === 'string' && csv.indexOf('#data=') === 0) {
      csv = decodeURIComponent(csv.slice(6));
    }
    var p = parsePacket(csv);
    if (!p) return;

    // While the save dialog is open the user owns the decision (SAVE or
    // START OVER). Ignore packets so a stray stroke can't wipe an unsaved
    // session by transitioning DONE → ACTIVE behind their back.
    if (phase === 'DONE') return;

    var prev = lastPacket;
    lastPacket = p;

    if (phase === 'IDLE') {
      if (p.spm > 0) goActive(); else return;
    }

    // ACTIVE: apply reset detection, update pace, sample, render.
    applyResetIfNeeded(p);
    updatePace(prev, p);
    if (p.spm > 0) {
      lastActiveAt = Date.now();
      recordSample(p);          // only sample while actually rowing
    }
    render();
  }

  function initFtmsTracking() {
    ensureSaveDialog();
    if (inactivityTimerId) clearInterval(inactivityTimerId);
    inactivityTimerId = setInterval(tickInactivity, INACTIVITY_TICK);
    goIdle();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Save / restart
  // ─────────────────────────────────────────────────────────────────────
  function avg(arr, key) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i][key];
    return s / arr.length;
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
          Math.round(x.hr),
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

  function saveWorkout() {
    hideSaveDialog();
    var payload = buildPayload();
    var token = typeof appToken !== 'undefined' ? appToken : null;

    var goHome = function () {
      if (typeof showHome === 'function') showHome();
      goIdle();
    };

    showBanner('SAVING...');

    if (!token) {
      var tag = workoutTag();
      var msg = JSON.stringify({
        action:  'saveData',
        workout: tag,
        data:    JSON.stringify(payload)
      });
      var ai = (typeof AppInventor !== 'undefined' && AppInventor.setWebViewString)
        ? AppInventor
        : (typeof window.AppInventor !== 'undefined' && window.AppInventor.setWebViewString)
          ? window.AppInventor
          : null;
      if (ai) {
        showBanner('SENT TO APP');
        ai.setWebViewString(msg);
        setTimeout(function () {
          hideBanner();
          phase = 'IDLE';
          showOfflineChoice();
        }, 1500);
      } else {
        showBanner('NO APP BRIDGE (browser mode)');
        setTimeout(function () {
          hideBanner();
          phase = 'IDLE';
          showOfflineChoice();
        }, 2000);
      }
      return;
    }

    var tag = workoutTag();
    var body = JSON.stringify({ token: token, workout: tag, data: payload });

    var timeout = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('timeout')); }, 10000);
    });

    Promise.race([
      fetch(XESYNC_CONFIG.apiBaseUrl + '/rpc/save_workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      }).then(function (r) {
        return r.text().then(function (txt) {
          return { ok: r.ok, status: r.status, txt: txt };
        });
      }),
      timeout
    ])
    .then(function (resp) {
      if (!resp.ok) {
        showBanner('HTTP ' + resp.status + ': ' + (resp.txt || '').slice(0, 80));
        setTimeout(function () { hideBanner(); goHome(); }, 4000);
        return;
      }
      var json;
      try { json = JSON.parse(resp.txt); }
      catch (e) {
        showBanner('BAD JSON: ' + (resp.txt || '').slice(0, 80));
        setTimeout(function () { hideBanner(); goHome(); }, 4000);
        return;
      }
      // PostgREST returns an array; unwrap.
      var row = Array.isArray(json) ? json[0] : json;
      if (row && row.status === 'success') {
        showBanner('SAVED ✓');
        setTimeout(function () { hideBanner(); goHome(); }, 1000);
      } else {
        showBanner('SAVE FAIL: ' + ((row && (row.error || row.status)) || resp.txt).toString().slice(0, 80));
        setTimeout(function () { hideBanner(); goHome(); }, 4000);
      }
    })
    .catch(function (err) {
      showBanner('NET ERROR: ' + err.message);
      setTimeout(function () { hideBanner(); goHome(); }, 4000);
    });
  }

  function restartWorkout() {
    goIdle();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Exports
  // ─────────────────────────────────────────────────────────────────────
  window.initFtmsTracking   = initFtmsTracking;
  window.ingestData         = ingestData;
  window.saveWorkout        = saveWorkout;
  window.restartWorkout     = restartWorkout;
  window.offlineChoiceRow   = offlineChoiceRow;
  window.offlineChoiceLogin = offlineChoiceLogin;
})();