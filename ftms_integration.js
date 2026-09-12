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
  //
  // DEBUG must be assigned BEFORE anything reads it. `var` hoists the
  // declaration but not the assignment, so INACTIVITY_MS used to be
  // computed from `undefined` and was always 5000, never the 10000 the
  // debug build wants.
  // ─────────────────────────────────────────────────────────────────────
  var DEBUG = new URLSearchParams(window.location.search).get('debug') === 'true';

  var INACTIVITY_MS   = DEBUG ? 10000 : 5000;
  var INACTIVITY_TICK = 500;
  var INITIAL_PACE    = 150;
  var PACE_WINDOW_MS  = 30000;

  // Activity predicate — see isActive(). A packet counts as "rowing" when
  // any of these move, not just SPM, so a single zero-SPM frame mid-stroke
  // (or a brief BLE stall serving a stale frame) can't fake inactivity.
  var ACTIVE_WATTS_MIN = 10;

  // Sampling: at MOST one sample per second. Actual spacing follows packet
  // arrival, so intervals vary — samples are not a fixed 1 Hz series.
  var SAMPLE_MIN_INTERVAL_S = 1.0;

  // Upper bound on samples kept for one session. At ~1 Hz this is ~4h of
  // rowing; past that we stop growing the array rather than build a payload
  // the server will reject.
  var MAX_SAMPLES = 15000;

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
      // Two distinct quantities, deliberately not merged:
      //   machinePace — whatever the rower reported in the last frame.
      //                 Instantaneous and noisy.
      //   rollingPace — derived from distance covered over a 30s window.
      //                 Smoothed; this is what the UI shows and what gets
      //                 stored per sample.
      machinePace:   INITIAL_PACE,
      rollingPace:   INITIAL_PACE,
      paceHistory:   [],
      samples:       [],
      droppedSamples: 0
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Parsing — Xebex FTMS
  //
  // A frame is 20 comma-separated byte values. Multi-byte fields use the
  // machine's own odd encoding: value = byte[hi] * 255 + byte[lo] (255, not
  // 256 — that is what the hardware actually sends, not a typo).
  //
  // The layout lives here as data rather than as offsets inlined into the
  // object literal, so the wire format is stated once and readable next to
  // the fixtures in tests/ftms.test.js.
  // ─────────────────────────────────────────────────────────────────────
  var PACKET_BYTES = 20;

  var PACKET_LAYOUT = {
    spm:      { byte: 2,           scale: 0.5 },  // half-strokes per minute
    strokes:  { hi: 4,  lo: 3  },
    distance: { hi: 6,  lo: 5  },                 // metres
    pace:     { hi: 9,  lo: 8  },                 // sec / 500m, as reported
    watts:    { hi: 11, lo: 10 },
    cals:     { hi: 13, lo: 12 },
    hr:       { byte: 16 },                       // HR_ABSENT when no strap
    elapsed:  { hi: 19, lo: 18 }                  // seconds
  };

  var HR_ABSENT = 255;

  // Diagnostics — distinguishes "BLE went quiet" from "BLE is talking but
  // we reject every frame", which are very different hardware problems.
  var metrics = { packets: 0, badPackets: 0, lastBadSample: null };

  function parsePacket(csv) {
    if (!csv) { noteBadPacket(csv); return null; }
    var b = csv.split(',').map(function (s) { return parseInt(s, 10); });
    if (b.length < PACKET_BYTES || b.some(isNaN)) { noteBadPacket(csv); return null; }

    var p = { t: Date.now() };
    for (var field in PACKET_LAYOUT) {
      if (!Object.prototype.hasOwnProperty.call(PACKET_LAYOUT, field)) continue;
      var f = PACKET_LAYOUT[field];
      var raw = f.byte !== undefined ? b[f.byte] : (b[f.hi] * 255 + b[f.lo]);
      p[field] = f.scale ? raw * f.scale : raw;
    }
    metrics.packets++;
    return p;
  }

  function noteBadPacket(csv) {
    metrics.badPackets++;
    metrics.lastBadSample = typeof csv === 'string' ? csv.slice(0, 80) : String(csv);
    // Only every 25th, so a fully-misaligned stream doesn't flood the log.
    if (metrics.badPackets % 25 === 1) {
      dbg('BAD PACKET #' + metrics.badPackets + ' ' + metrics.lastBadSample);
    }
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

  // Two predicates, deliberately not the same one.
  //
  // isActive() keeps an ALREADY-RUNNING session alive and is liberal: any
  // forward progress counts, so a single zero-SPM frame mid-stroke — or a
  // stale frame served during a BLE hiccup — can't be mistaken for the user
  // stopping. That was the old `spm > 0` failure mode.
  //
  // isSessionStart() wakes a session from IDLE/PAUSED and is deliberately
  // stricter: it ignores distance, because a flywheel coasting down after
  // the user stops still creeps the distance counter for a few seconds. On
  // the liberal predicate that creep would auto-resume a session the user
  // just paused on purpose.
  function isActive(p, prev) {
    if (isSessionStart(p, prev)) return true;
    if (!prev) return false;
    return p.distance > prev.distance;
  }

  function isSessionStart(p, prev) {
    if (p.spm > 0) return true;
    if (p.watts >= ACTIVE_WATTS_MIN) return true;
    return !!prev && p.strokes > prev.strokes;
  }

  function updatePace(prev, curr) {
    // The machine's own reading, kept as-is for reference/diagnostics.
    if (isFinite(curr.pace) && curr.pace > 0) session.machinePace = curr.pace;

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
      // Below the movement threshold we keep the previous value rather than
      // spiking to infinity, so rollingPace is a held-last-good figure.
      if (isFinite(averagePace) && averagePace > 0) session.rollingPace = averagePace;
    }
  }

  function recordSample(p) {
    var now = sessionSeconds();
    var last = session.samples.length ? session.samples[session.samples.length - 1] : null;
    if (last && now - last.time < SAMPLE_MIN_INTERVAL_S) return;
    if (session.samples.length >= MAX_SAMPLES) { session.droppedSamples++; return; }
    session.samples.push({
      time:     now,
      distance: totalDistance(),
      strokes:  totalStrokes(),
      spm:      p.spm,
      watts:    p.watts,
      hr:       p.hr === HR_ABSENT ? null : p.hr,
      pace:     session.rollingPace
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
    setText('heartrate',   lastPacket.hr === HR_ABSENT ? '-' : lastPacket.hr);
    setText('distance',    totalDistance());
    setText('watts',       Math.round(lastPacket.watts));
    setText('pace',        fmtTime(session.rollingPace));
    setText('spm',         Math.round(lastPacket.spm));
    setText('cals',        totalCals());
    setText('strokes',     totalStrokes());
    setText('elapsedtime', fmtTime(sessionSeconds()));
    if (typeof setConsoleSpeedAndSpm === 'function') {
      setConsoleSpeedAndSpm(paceToAnimSpeed(session.rollingPace), lastPacket.spm);
    }
  }

  function renderIdle() {
    setText('heartrate',   '-');
    setText('distance',    '0');
    setText('watts',       '0');
    setText('pace',        '--:--');
    setText('spm',         '0');
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
      if (typeof window.onFtmsResume === 'function') window.onFtmsResume();
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
    if (typeof window.onFtmsSessionStart === 'function') window.onFtmsSessionStart();
  }

  function goPaused() {
    if (phase !== 'ACTIVE') return;
    session.pausedAt = Date.now();
    phase = 'PAUSED';
    dbg('PAUSED');
    if (typeof setConsoleSpeedAndSpm === 'function') setConsoleSpeedAndSpm(0, 0);
    showPauseDialog();
    if (typeof window.onFtmsPause === 'function') window.onFtmsPause();
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
    var silent = Date.now() - lastActiveAt;
    if (silent > INACTIVITY_MS) { goPaused(); return; }
    // Progressively decay SPM and pace display toward zero after 1s of silence
    if (silent > 1000 && lastPacket) {
      var decay = 1 - (silent - 1000) / (INACTIVITY_MS - 1000);
      decay = Math.max(0, decay);
      setText('spm', Math.round(lastPacket.spm * decay));
      setText('pace', decay > 0 ? fmtTime(session.rollingPace / decay) : '--:--');
      if (typeof setConsoleSpeedAndSpm === 'function') {
        setConsoleSpeedAndSpm(paceToAnimSpeed(session.rollingPace) * decay, lastPacket.spm * decay);
      }
    }
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
    // The AI2 hash transport calls this with no argument and leaves the
    // frame in location.hash (see controller.js's hashchange listener).
    if (csv == null && typeof window !== 'undefined' && window.location) {
      csv = window.location.hash;
    }
    if (typeof csv === 'string' && csv.indexOf('#data=') === 0) {
      csv = decodeURIComponent(csv.slice(6));
    }
    var p = parsePacket(csv);
    if (!p) return;

    var prev = lastPacket;

    dbg('pkt spm=' + p.spm + ' dist=' + p.distance + ' w=' + p.watts + ' phase=' + phase);

    if (phase === 'IDLE' || phase === 'PAUSED') {
      // Keep the frame either way, so the next one has something to compare
      // against — that comparison is what makes stroke/distance deltas
      // usable as activity signals at all. Only real effort wakes the
      // session, though.
      lastPacket = p;
      if (!isSessionStart(p, prev)) return;
      goActive();
    } else {
      lastPacket = p;
    }

    applyResetIfNeeded(p);
    updatePace(prev, p);
    if (isActive(p, prev)) {
      lastActiveAt = Date.now();
      recordSample(p);
    }
    render();
    // Coaching (coaching.js) is entirely optional: ftms_integration.js never
    // requires it to exist, it just calls out if controller.js wired it up.
    if (phase === 'ACTIVE' && typeof window.onFtmsTick === 'function') {
      window.onFtmsTick({
        activeSeconds: sessionSeconds(),
        distance:      totalDistance(),
        strokes:       totalStrokes(),
        spm:           p.spm,
        watts:         p.watts
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Save / exit — notify app.html via onWorkoutComplete(savedState)
  // ─────────────────────────────────────────────────────────────────────
  // Returns null rather than 0 when a metric has no readings at all, so a
  // session rowed without a heart-rate strap stores NULL instead of a
  // fictitious 0 bpm.
  function avg(arr, key) {
    var s = 0, n = 0;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i][key] == null) continue;
      s += arr[i][key]; n++;
    }
    return n ? s / n : null;
  }

  function roundOrNull(v, places) {
    if (v == null) return null;
    var f = Math.pow(10, places || 0);
    return Math.round(v * f) / f;
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
        avgSpm:   roundOrNull(avg(s, 'spm'), 1),
        avgPace:  roundOrNull(avg(s, 'pace')),
        avgWatts: roundOrNull(avg(s, 'watts')),
        avgHr:    roundOrNull(avg(s, 'hr'))
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

  // 48 bits of randomness, from the CSPRNG where one exists. The fallback
  // only matters on WebViews without crypto.getRandomValues, where a
  // collision is still far less likely than the old second-resolution id.
  function randomHex(bytes) {
    var out = '';
    var g = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? crypto.getRandomValues(new Uint8Array(bytes))
      : null;
    for (var i = 0; i < bytes; i++) {
      var v = g ? g[i] : Math.floor(Math.random() * 256);
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }

  // workout_<local timestamp>_<random>
  //
  // The timestamp half is not for uniqueness — the random half handles that.
  // It stays because it is the only record of when an OFFLINE workout was
  // actually rowed: the server stamps workout_date at INSERT time, which for
  // a queued upload can be days later.
  //
  // The `workout_` prefix is load-bearing: the Capacitor bridge scans
  // Preferences keys by that prefix to find pending offline uploads.
  function workoutTag() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return 'workout_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
      + '_' + randomHex(6);
  }

  function notifyLeave() {
    if (typeof window.onLeaveRowing === 'function') window.onLeaveRowing();
  }

  // `extra` (splitsTable/coachingSummary) is additive and optional - existing
  // callers of window.onWorkoutComplete(savedState) keep working untouched.
  function notifyComplete(savedState, extra) {
    if (typeof window.onWorkoutComplete === 'function') {
      window.onWorkoutComplete(savedState, extra);
    }
  }

  // ftms produces the payload and delegates persistence to the controller.
  // The controller decides online/offline and reports back the result.
  function saveWorkout() {
    hidePauseDialog();
    stopWatchdog();
    phase = 'IDLE';
    notifyLeave();
    var payload = buildPayload();
    // Lets controller.js attach payload.splitsTable / payload.coachingSummary
    // (computed from Coaching's session journal) while session.samples is
    // still intact - goIdle() below wipes it.
    if (typeof window.onBeforeSave === 'function') window.onBeforeSave(payload);
    var extra = { splitsTable: payload.splitsTable || null, coachingSummary: payload.coachingSummary || null };
    var tag = workoutTag();
    goIdle();

    showBanner('SAVING...');
    if (typeof window.onWorkoutSave === 'function') {
      window.onWorkoutSave(tag, payload, function (savedState) {
        hideBanner();
        notifyComplete(savedState, extra);
      });
    } else {
      hideBanner();
      notifyComplete('offline', extra);
    }
  }

  function exitSession() {
    hidePauseDialog();
    hideBanner();
    stopWatchdog();
    phase = 'IDLE';
    notifyLeave();
    notifyComplete(null);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Exports
  // ─────────────────────────────────────────────────────────────────────
  window.initFtmsTracking = initFtmsTracking;
  window.ingestData       = ingestData;
  window.saveWorkout      = saveWorkout;
  window.exitSession      = exitSession;

  // Internals, exposed for the unit tests in tests/ and for diagnosing a
  // misbehaving rower from the console. Read-only in spirit: nothing in the
  // app reads this back.
  window.FtmsInternals = {
    DEBUG:         DEBUG,
    INACTIVITY_MS: INACTIVITY_MS,
    MAX_SAMPLES:   MAX_SAMPLES,
    PACKET_LAYOUT: PACKET_LAYOUT,
    PACKET_BYTES:  PACKET_BYTES,
    HR_ABSENT:     HR_ABSENT,
    metrics:       metrics,
    parsePacket:   parsePacket,
    isActive:      isActive,
    isSessionStart: isSessionStart,
    buildPayload:  buildPayload,
    workoutTag:    workoutTag,
    getPhase:      function () { return phase; },
    getSession:    function () { return session; },
    _forceIdle:    goIdle
  };

})();
