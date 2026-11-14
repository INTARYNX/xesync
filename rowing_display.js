var RowingAnimation = (function() {
    var gl = null;
    var uniforms = {};
    var t0 = 0;
    var lastT = 0;
    var flow = 0;
    var animPhase = 0;
    var currentSpeed = 0;
    var currentSpm = 0;
    var spriteScale = 0.6;
    var rafId = null;
    var loadingEl = null;
    var shaderReadySent = false;

    var SPEED_NORMALIZE = 5.0;
    var TIME_WRAP = 300.0;
    var FLOW_WRAP = 1000.0;

    // One stroke is a 0..1 cycle: 0 is the catch (start of the drive),
    // DRIVE_FRACTION is the finish (end of the drive), then the recovery
    // runs back round to the catch. 1/3 is the usual drive:recovery of 1:2.
    var DRIVE_FRACTION = 1.0 / 3.0;

    // Where those two landmarks sit on the shader's u_phase pose track (8
    // keyframes over 0..1, see rowing_display.html): keyframe 3 is the
    // finish (hands at the chest, full lay-back, hands move away from
    // keyframe 4 on); keyframe 7 repeats the catch of keyframe 0, so
    // 0.875..1.0 holds the catch.
    var FINISH_RENDER_PHASE = 0.375;

    function toRenderPhase(a) {
        return a < DRIVE_FRACTION
            ? a * (FINISH_RENDER_PHASE / DRIVE_FRACTION)
            : FINISH_RENDER_PHASE + (a - DRIVE_FRACTION) *
                ((1.0 - FINISH_RENDER_PHASE) / (1.0 - DRIVE_FRACTION));
    }

    // ---------------------------------------------------------------------
    // Stroke sync
    //
    // The rower only reports that a stroke happened (its counter ticks),
    // and only in the next packet, ~1 Hz, so each tick is known to within
    // about a second. Driving the animation from spm alone free-runs it
    // with no tie to the real stroke; snapping it to each packet would be
    // late and jittery. So the tracker locks the cycle onto the ticks: it
    // filters tick times into a finish time and a stroke period, and the
    // animation follows that clock. The finish pose then lands on the real
    // finish even though the packet reporting it arrives afterwards.
    //
    // A tick pins the FINISH, not the catch: the counter increments at the
    // flywheel peak, which is the end of the drive. Checked on the capture
    // in tools/ftms_data.js: the tick packet is the maximum of the decaying
    // flywheel field (bytes 14-15) in 16 of 16 strokes, and the following
    // packet is never higher. The catch is derived, one recovery later.
    // ---------------------------------------------------------------------
    var FINISH_PHASE      = DRIVE_FRACTION;
    var MAX_GAP_S         = 1.5;   // cap on the packet gap used to place a tick
    var PERIOD_MIN_S      = 1.0;   // 60 spm
    var PERIOD_MAX_S      = 8.0;
    var DEFAULT_PERIOD_S  = 2.5;   // first tick, no usable spm
    // Steady-state share of a tick's timing error taken into the finish time
    // (ALPHA) and the period (BETA); both start higher, see stroke(). Tuned
    // on simulated 1 Hz packets: mean finish-pose error ~0.10-0.14 s steady,
    // 0.23 s on an 18->30 spm ramp (peaks ~0.3 s and ~0.55 s). Lower BETA is
    // quieter when steady but lags a tempo change more; higher is the reverse.
    var ALPHA             = 0.3;
    var BETA              = 0.15;
    var OUTLIER_FRACTION  = 0.4;   // tick timing error clamp, as a share of the period
    var AGREE_FRACTION    = 0.3;   // measured period within this of the spm guess: blend
    var GUESS_WEIGHT      = 0.7;   // ... weighting the guess this much
    var STALE_PERIODS     = 2.5;   // no tick for this long: the lock is dropped
    var STALE_SLACK_S     = 1.0;
    var LOCK_SPM_RATIO    = 0.85;  // spm under this share of its tick value = winding down
    var PHASE_PULL        = 5.0;   // 1/s, how fast the drawn phase chases the clock
    var MIN_RATE_FACTOR   = 0.3;   // the drawn phase is never allowed to go backwards
    var MAX_RATE_FACTOR   = 2.5;
    var SNAP_DT_S         = 0.25;  // frame gap (tab was hidden): jump instead of chase

    function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
    function wrap01(x)        { return x - Math.floor(x); }
    function wrapHalf(x)      { return x - Math.round(x); }

    function createPhaseTracker() {
        var lock = null;

        function isStale(now) {
            return now - lock.finishT > STALE_PERIODS * lock.period + STALE_SLACK_S;
        }

        // Falling spm means ftms_integration.js's inactivity watchdog is
        // winding the rower down (it scales spm toward 0 after 1 s of
        // silence). The free-running path winds down with it; a lock would
        // keep rowing at the old period.
        function isLocked(now, spm) {
            return !!lock && !isStale(now) &&
                lock.spmRef > 0 && spm >= LOCK_SPM_RATIO * lock.spmRef;
        }

        return {
            // `count` strokes were counted by the packet arriving at `now`
            // (seconds); `gapS` is the time since the previous packet. The
            // stroke is somewhere in that gap, so its best single guess is
            // the middle of it. The filter averages the rest of the
            // quantisation noise away over the next few strokes.
            stroke: function (now, count, gapS, spm) {
                var z = now - Math.min(gapS, MAX_GAP_S) / 2;

                if (!lock || isStale(now)) {
                    lock = {
                        finishT: z,
                        period:  clamp(spm > 0 ? 60.0 / spm : DEFAULT_PERIOD_S,
                                       PERIOD_MIN_S, PERIOD_MAX_S),
                        ticks:   1,
                        spmRef:  spm
                    };
                    return;
                }

                if (lock.ticks === 1) {
                    // Second tick: the period so far is only a guess from
                    // spm, and spm is not always the real stroke interval
                    // (it is smoothed and can lag). Take the measured
                    // interval; where it roughly agrees with the guess the
                    // guess is the less noisy of the two, so lean on it.
                    var measured = (z - lock.finishT) / count;
                    var agrees = Math.abs(measured - lock.period) < AGREE_FRACTION * lock.period;
                    lock.period = clamp(agrees ? GUESS_WEIGHT * lock.period + (1.0 - GUESS_WEIGHT) * measured
                                               : measured,
                                        PERIOD_MIN_S, PERIOD_MAX_S);
                    lock.finishT = z;
                    lock.ticks += count;
                    lock.spmRef = spm;
                    return;
                }

                var predicted = lock.finishT + count * lock.period;
                var limit = OUTLIER_FRACTION * lock.period;
                var err = clamp(z - predicted, -limit, limit);
                // Corrections start big and settle to the steady ALPHA/BETA.
                var alpha = Math.max(ALPHA, 1.0 / (lock.ticks + 1));
                var beta  = Math.max(BETA, 0.5 / lock.ticks);
                lock.finishT = predicted + alpha * err;
                lock.period  = clamp(lock.period + beta * err / count,
                                     PERIOD_MIN_S, PERIOD_MAX_S);
                lock.ticks  += count;
                lock.spmRef  = spm;
            },

            // Next value of the cycle phase for a frame `dt` seconds long.
            advance: function (phase, dt, now, spm) {
                if (!isLocked(now, spm)) return (phase + dt * spm / 60.0) % 1.0;

                var f = 1.0 / lock.period;
                var target = wrap01(FINISH_PHASE + (now - lock.finishT) * f);
                if (dt > SNAP_DT_S) return target;

                // Chase the clock rather than jump to it: each tick nudges
                // the clock a little, and the drawn rower should absorb
                // that as a brief speed-up or slow-down, never a snap.
                var rate = clamp(f + PHASE_PULL * wrapHalf(target - phase),
                                 MIN_RATE_FACTOR * f, MAX_RATE_FACTOR * f);
                return (phase + dt * rate) % 1.0;
            },

            isLocked: isLocked,
            period:   function () { return lock ? lock.period : null; },
            reset:    function () { lock = null; }
        };
    }

    var tracker = createPhaseTracker();

    function compile(type, src) {
        var sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error('Shader compile error:', gl.getShaderInfoLog(sh));
        }
        return sh;
    }

    function resize() {
        var canvas = gl.canvas;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var w = Math.floor(canvas.clientWidth * dpr);
        var h = Math.floor(canvas.clientHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function frame() {
        resize();
        var now = performance.now() / 1000;
        var dt = now - lastT;
        lastT = now;

        flow -= dt * currentSpeed * 0.26;
        if (flow < -FLOW_WRAP) flow += FLOW_WRAP;
        if (flow >  FLOW_WRAP) flow -= FLOW_WRAP;

        animPhase = tracker.advance(animPhase, dt, now, currentSpm);
        var renderPhase = toRenderPhase(animPhase);

        var timeWrapped = (now - t0) % TIME_WRAP;

        gl.uniform1f(uniforms.uTime,   timeWrapped);
        gl.uniform1f(uniforms.uSpeed,  currentSpeed);
        gl.uniform1f(uniforms.uFlow,   flow);
        gl.uniform1f(uniforms.uPhase,  renderPhase);
        gl.uniform1f(uniforms.uSpm,    currentSpm);
        gl.uniform1f(uniforms.uScale,  spriteScale);
        gl.uniform1f(uniforms.uAspect, gl.canvas.clientWidth / gl.canvas.clientHeight);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        if (!shaderReadySent) {
            shaderReadySent = true;
            window.parent.postMessage({ type: 'shaderReady' }, '*');
        }

        if (loadingEl) {
            var el = loadingEl;
            loadingEl = null;
            el.classList.add('fade-out');
            el.addEventListener('transitionend', function() {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, { once: true });
        }

        rafId = requestAnimationFrame(frame);
    }

    function initRowing() {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }

        var canvas = document.getElementById('glCanvas');
        gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) {
            document.getElementById('wrapper').innerHTML =
                '<p style="color:#fff;padding:20px">WebGL not supported</p>';
            return;
        }

        var prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER,
            document.getElementById('vs').textContent));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER,
            document.getElementById('fs').textContent));
        gl.linkProgram(prog);
        gl.useProgram(prog);

        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1,-1,  1,-1,  -1, 1,
            -1, 1,  1,-1,   1, 1
        ]), gl.STATIC_DRAW);

        var aPos = gl.getAttribLocation(prog, 'a_pos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        uniforms = {
            uTime:   gl.getUniformLocation(prog, 'u_time'),
            uSpeed:  gl.getUniformLocation(prog, 'u_speed'),
            uFlow:   gl.getUniformLocation(prog, 'u_flow'),
            uPhase:  gl.getUniformLocation(prog, 'u_phase'),
            uSpm:    gl.getUniformLocation(prog, 'u_spm'),
            uScale:  gl.getUniformLocation(prog, 'u_scale'),
            uAspect: gl.getUniformLocation(prog, 'u_aspect')
        };

        t0 = performance.now() / 1000;
        lastT = t0;
        flow = 0;
        animPhase = 0;
        tracker.reset();
        currentSpeed = 0;
        currentSpm = 0;
        shaderReadySent = false;
        loadingEl = document.getElementById('gl-loading');

        window.addEventListener('resize', resize);
        resize();
        frame();
    }

    return {
        setConsoleValues: function(distance, watts, elapsedtime, pace, spm, heartrate, cals, _delay, strokes) {
            document.getElementById('distance').textContent = distance;
            document.getElementById('watts').textContent = watts;
            document.getElementById('elapsedtime').textContent = elapsedtime;
            document.getElementById('pace').textContent = pace;
            document.getElementById('spm').textContent = spm;
            document.getElementById('heartrate').textContent = heartrate;
            document.getElementById('cals').textContent = cals;
            document.getElementById('strokes').textContent = strokes;
        },
        setConsoleSpeedAndSpm: function(speed, spm) {
            currentSpeed = Math.min(speed / SPEED_NORMALIZE, 1.0);
            currentSpm = spm;
        },
        // `count` strokes were just counted by the rower; `gapS` is the time
        // since the packet before. Call after setConsoleSpeedAndSpm, so the
        // spm it is paired with is the one reported alongside the stroke.
        noteStroke: function(count, gapS) {
            tracker.stroke(performance.now() / 1000, count, gapS, currentSpm);
        },
        // Exposed for tests/rowing_sync.test.js.
        createPhaseTracker: createPhaseTracker,
        toRenderPhase: toRenderPhase,
        FINISH_PHASE: FINISH_PHASE,
        initRowing: initRowing,
        stopAllAnimations: function() {
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
        }
    };
})();

var initRowing = RowingAnimation.initRowing;
var setConsoleValues = RowingAnimation.setConsoleValues;
var setConsoleSpeedAndSpm = RowingAnimation.setConsoleSpeedAndSpm;
var noteStroke = RowingAnimation.noteStroke;