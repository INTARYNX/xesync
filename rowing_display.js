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

    // ftms_integration passes speed = (500/paceSeconds) * 0.8
    // Fast rowing (90s/500m) ≈ 4.4, normal (120s) ≈ 3.3, slow (180s) ≈ 2.2
    var SPEED_NORMALIZE = 5.0;

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
        animPhase = (animPhase + dt * currentSpm / 60.0) % 1.0;

        var renderPhase = animPhase < 1.0 / 3.0
            ? animPhase * 1.5
            : 0.5 + (animPhase - 1.0 / 3.0) * 0.75;

        gl.uniform1f(uniforms.uTime,   now - t0);
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
