/**
 * Realistic FTMS session generator for DEBUG mode.
 *
 * Produces a 30-second workout with a smooth effort curve:
 *   0–5s   warm-up   (SPM 14 → 24, watts 40 → 130)
 *   5–25s  steady    (SPM 24–28, watts 130–180, slight variation)
 *   25–30s cool-down (SPM 24 → 0, watts 130 → 0)
 *   30s+   idle      (spm=0) so the inactivity watchdog ends the session
 *
 * Cumulative counters (distance, strokes, cals, elapsed time) grow monotonically
 * and reset to 0 when the simulator is reset.
 *
 * Packets are emitted every 500 ms through handleAppResponse(),
 * exactly like real BLE traffic from App Inventor.
 */
var DebugSim = (function () {
  'use strict';

  var DEBUG_MODE      = new URLSearchParams(window.location.search).get('debug') === 'true';
  var SESSION_SECONDS = DEBUG_MODE ? 10 : 30;
  var WARMUP_END      = DEBUG_MODE ?  2 :  5;
  var EFFORT_END      = DEBUG_MODE ?  8 : 25;
  var TICK_MS         = 500;
  var TAIL_IDLE_MS    = 8000;   // emit spm=0 for this long after session end

  var timerId = null;
  var startMs = 0;
  var lastEmit = null;

  // Cumulative state — grows over the session
  var distance = 0;     // meters
  var strokes = 0;
  var cals = 0;
  var lastStrokeT = -1;

  // Smooth interpolation helpers
  function smoothstep(t) { return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /**
   * Returns the rower's state at time t (seconds since session start).
   *   spm   : strokes per minute (0 when idle / cooled down)
   *   watts : instantaneous power
   *   paceS : pace in seconds per 500m (0 when idle)
   *   speed : meters per second (for distance integration)
   */
  function profile(t) {
    if (t < 0) return { spm: 0, watts: 0, paceS: 0, speed: 0 };

    if (t < WARMUP_END) {
      var w = smoothstep(t / WARMUP_END);
      var spm = lerp(14, 24, w);
      var watts = lerp(40, 130, w);
      var speed = lerp(1.2, 3.0, w);
      return { spm: spm, watts: watts, paceS: 500 / speed, speed: speed };
    }

    if (t < EFFORT_END) {
      // Steady effort with mild sinusoidal variation
      var phase = (t - WARMUP_END) / (EFFORT_END - WARMUP_END);
      var wobble = Math.sin(phase * Math.PI * 4) * 0.5 + Math.sin(phase * Math.PI * 7) * 0.3;
      var spm = 26 + wobble;
      var watts = 160 + wobble * 20;
      var speed = 3.3 + wobble * 0.15;
      return { spm: spm, watts: watts, paceS: 500 / speed, speed: speed };
    }

    if (t < SESSION_SECONDS) {
      var c = smoothstep((t - EFFORT_END) / (SESSION_SECONDS - EFFORT_END));
      var spm = lerp(24, 0, c);
      var watts = lerp(130, 0, c);
      var speed = lerp(3.0, 0.3, c);
      return { spm: spm, watts: watts, paceS: speed > 0 ? 500 / speed : 0, speed: speed };
    }

    return { spm: 0, watts: 0, paceS: 0, speed: 0 };
  }

  /**
   * Encode a 20-byte FTMS packet using Xebex's high*255 + low convention.
   * Field layout (1-indexed bytes, matches ftms_integration.js parsePacket):
   *   byte 3              : SPM * 2          (so half-integer SPM works)
   *   bytes 4–5  (lo,hi)  : strokes
   *   bytes 6–7  (lo,hi)  : distance (m)
   *   bytes 9–10 (lo,hi)  : pace (s/500m)
   *   bytes 11–12 (lo,hi) : watts
   *   bytes 13–14 (lo,hi) : calories
   *   byte 17             : heart rate (255 = no sensor)
   *   bytes 19–20 (lo,hi) : elapsed time (s)
   */
  function encode(p, elapsedS) {
    var b = new Array(20);
    for (var i = 0; i < 20; i++) b[i] = 0;

    var u16 = function (val, hiIdx, loIdx) {
      val = Math.max(0, Math.round(val));
      b[hiIdx - 1] = Math.floor(val / 255);
      b[loIdx - 1] = val % 255;
    };

    b[0] = 44;
    b[1] = 11;
    b[2] = Math.max(0, Math.round(p.spm * 2));   // SPM * 2 (matches parser's *0.5)
    u16(strokes,            5, 4);
    u16(distance,           7, 6);
    u16(Math.round(p.paceS), 10, 9);
    u16(Math.round(p.watts), 12, 11);
    u16(cals,              14, 13);
    b[16] = 255;                                 // HR: no sensor
    u16(Math.round(elapsedS), 20, 19);

    return b.join(', ');
  }

  function tick() {
    var now = Date.now();
    var t = (now - startMs) / 1000;
    var p = profile(t);

    // Integrate distance over time using actual elapsed (handles tick jitter)
    if (lastEmit !== null) {
      var dt = (now - lastEmit) / 1000;
      var prev = profile((lastEmit - startMs) / 1000);
      distance += ((prev.speed + p.speed) / 2) * dt;
    }
    lastEmit = now;

    // Strokes: count one each time t crosses an integer multiple of (60/spm)
    if (p.spm > 0) {
      var strokeInterval = 60 / p.spm;
      while (lastStrokeT + strokeInterval <= t) {
        lastStrokeT += strokeInterval;
        strokes++;
      }
    }

    // Calories: rough estimate — 1 cal per 10 watt-seconds
    cals += (p.watts * (TICK_MS / 1000)) / 1000;

    var packet = encode(p, t);
    if (typeof handleAppResponse === 'function') {
      handleAppResponse(JSON.stringify({ action: 'ftmsData', data: packet }));
    }

    // Auto-stop after the tail idle period (so the watchdog has time to fire)
    if (t > SESSION_SECONDS + (TAIL_IDLE_MS / 1000)) {
      stop();
    }
  }

  function start() {
    if (timerId) return;
    startMs = Date.now();
    lastEmit = null;
    lastStrokeT = 0;
    timerId = setInterval(tick, TICK_MS);
  }

  function stop() {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  function reset() {
    stop();
    distance = 0;
    strokes = 0;
    cals = 0;
    lastStrokeT = -1;
    lastEmit = null;
  }

  function isActive() { return timerId !== null; }

  return {
    start:    start,
    stop:     stop,
    reset:    reset,
    isActive: isActive
  };
})();