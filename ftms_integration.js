/**
 * FTMS Integration — session tracking + display sync
 *
 * Public API (called from app.html):
 *   initFtmsTracking()  — call when entering rowing screen
 *   ingestData(csv)     — call for each FTMS packet (20 comma-separated bytes)
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────
  // Config
  // ─────────────────────────────────────────────────────────────────────
  var INACTIVITY_MS    = 5000;
  var INACTIVITY_TICK  = 500;
  var INITIAL_PACE     = 150;
  var PACE_WINDOW_MS   = 30000;
  var DEBUG            = false;

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
    function tile(id, label, val) {
      return '<div class="ftms-summary-tile">'
        + '<div class="ftms-summary-label">' + label + '</div>'
        + '<div id="' + id + '" class="ftms-summary-value">' + val + '</div>'
        + '</div>';
    }
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
  // Post-workout screen (shown after SAVE or EXIT, online or offline)
  // ─────────────────────────────────────────────────────────────────────
  function ensurePostWorkout() {
    if (document.getElementById('postWorkout')) return;
    var html = ''
      + '<div id="postWorkout" class="ftms-overlay">'
      +   '<div id="pwTitle" class="ftms-overlay-title">WORKOUT ENDED</div>'
      +   '<div id="pwSubtitle" class="ftms-overlay-subtitle"></div>'
      +   '<div class="ftms-actions">'
      +     '<button class="ftms-btn primary" onclick="postWorkoutWorkouts()">WORKOUTS</button>'
      +     '<button class="ftms-btn"         onclick="postWorkoutLogin()">LOGIN</button>'
      +   '</div>'
      + '</div>';
    document.body.insertAdjacentHTML('beforeend', html);
  }
  function showPostWorkout(savedState) {
    ensurePostWorkout();
    var title = document.getElementById('pwTitle');
    var sub   = document.getElementById('pwSubtitle');
    if (savedState === 'online') {
      title.textContent = 'WORKOUT SAVED';
      sub.textContent = 'synced to your account';
    } else if (savedState === 'offline') {
      title.textContent = 'WORKOUT SAVED';
      sub.textContent = 'stored offline, will sync on next login';
    } else {
      title.textContent = 'WORKOUT ENDED';
      sub.textContent = 'not saved';
    }
    document.getElementById('postWorkout').classList.add('visible');
  }
  function hidePostWorkout() {
    var el = document.getElementById('postWorkout');
    if (el) el.classList.remove('visible');
  }
  function postWorkoutWorkouts() {
    var token = typeof appToken !== 'undefined' ? appToken : null;
    if (token && typeof showHome === 'function') {
      hidePostWorkout();
      showHome();
    } else if (typeof showNotConnected === 'function') {
      showNotConnected();
    }
  }
  function postWorkoutLogin() {
    hidePostWorkout();
    if (typeof show === 'function') show('screen-login');
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
      return;
    }
    resetSession();
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
  }

  // ─────────────────────────────────────────────────────────────────────
  // Inactivity watchdog
  // ─────────────────────────────────────────────────────────────────────
  function tickInactivity() {
    if (phase !== 'ACTIVE') return;
    if (Date.now() - lastActiveAt > INACTIVITY_MS) goPaused();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────
  function ingestData(csv) {
    if (typeof csv === 'string' && csv.indexOf('#data=') === 0) {
      csv = decodeURIComponent(csv.slice(6));
    }
    var p = parsePacket(csv);
    if (!p) return;

    var prev = lastPacket;
    lastPacket = p;

    if (phase === 'IDLE') {
      if (p.spm > 0) goActive(); else return;
    } else if (phase === 'PAUSED') {
      if (p.spm > 0) goActive(); else return;
    }

    applyResetIfNeeded(p);
    updatePace(prev, p);
    if (p.spm > 0) {
      lastActiveAt = Date.now();
      recordSample(p);
    }
    render();
  }

  function initFtmsTracking() {
    ensurePauseDialog();
    if (inactivityTimerId) clearInterval(inactivityTimerId);
    inactivityTimerId = setInterval(tickInactivity, INACTIVITY_TICK);
    goIdle();
    showBanner('READY TO ROW !');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Save / exit
  // ─────────────────────────────────────────────────────────────────────
  function avg(arr, key) {
    if (!arr.length) return 0;
    var s = 0, n = 0;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i][key] == null) continue;
      s += arr[i][key];
      n++;
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

  function saveWorkout() {
    hidePauseDialog();
    var payload = buildPayload();
    var token = typeof appToken !== 'undefined' ? appToken : null;

    showBanner('SAVING...');

    if (!token) {
      var tag = workoutTag();
      var ai = getAppInventor();
      if (ai) {
        ai.setWebViewString(JSON.stringify({ action: 'saveData', workout: tag, data: payload }));
      }
      setTimeout(function () {
        hideBanner();
        phase = 'IDLE';
        leaveRowingScreen();
        showPostWorkout('offline');
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
      phase = 'IDLE';
      leaveRowingScreen();
      if (!resp.ok) { showPostWorkout('offline'); return; }
      var json;
      try { json = JSON.parse(resp.txt); } catch (e) { showPostWorkout('offline'); return; }
      var row = Array.isArray(json) ? json[0] : json;
      showPostWorkout(row && row.status === 'success' ? 'online' : 'offline');
    })
    .catch(function () {
      hideBanner();
      phase = 'IDLE';
      leaveRowingScreen();
      showPostWorkout('offline');
    });
  }

  function leaveRowingScreen() {
    if (typeof showPostWorkoutScreen === 'function') {
      showPostWorkoutScreen();
    } else {
      var rowing = document.getElementById('screen-rowing');
      if (rowing) rowing.classList.remove('active');
      document.body.classList.add('with-bar');
    }
  }

  function exitSession() {
    hidePauseDialog();
    hideBanner();
    phase = 'IDLE';
    leaveRowingScreen();
    showPostWorkout(null);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Exports
  // ─────────────────────────────────────────────────────────────────────
  window.initFtmsTracking    = initFtmsTracking;
  window.ingestData          = ingestData;
  window.saveWorkout         = saveWorkout;
  window.exitSession         = exitSession;
  window.postWorkoutWorkouts = postWorkoutWorkouts;
  window.postWorkoutLogin    = postWorkoutLogin;
})();