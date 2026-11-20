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
    // The koi lives on its own 2D canvas, drawn over the WebGL one with
    // plain paths - see drawKoi() below.
    var koiCanvasEl = null;
    var koiCtx = null;
    // So does the scenery along the ridge (villages, mills, churches) -
    // see drawScenery() below. Its own canvas, under the koi's, over the
    // WebGL one.
    var sceneryCanvasEl = null;
    var sceneryCtx = null;

    // -- the chain, the scene's half of the game layer ------------------
    //
    // The chain is the game layer's state (run_score.js): how well the
    // rower is holding above their own recent pace, as a 0..1 level.
    // controller.js feeds it in; the scene answers it.
    //
    // The answer is never a number and never a word. It is the world
    // moving: the scenery scrolls faster, the day turns sooner, the
    // weather changes more often, and the boat's trace grows fuller. A
    // good run LOOKS like a good run - that is the whole incentive, and
    // it costs the rower nothing.
    var chainLevel = 0;
    var chainPulse = 0;
    var sceneClock = 0;
    // The day's weather. The course of the day (daily_course.js) draws
    // this from the local date and hour, so everyone rowing at the same
    // moment starts under the same sky. The session's own day counter
    // then runs on top of it, faster while the chain is up.
    var dayBase = 0;

    // The ghost: your own best run, replayed on the same water. The
    // profile is the distance-time curve of that run; the ghost is
    // placed against the player at the same elapsed time.
    var ghostProfile = null;
    var ghostOn = 0;
    var ghostOffset = 0;
    var ghostPhase = 0;

    // The koi: the creature the chain calls. The game layer
    // (run_score.js) says whether it is there and how close it is to
    // being landed; the scene swims it, and says nothing.
    var fishOn = 0;
    var fishHold = 0;
    var fishFade = 0;
    var fishExit = 0;          // counts down while it swims away
    var fishLandedSeen = false;
    var fishX = FISH_X;
    // How far ahead of the boat it swims, in scene units.
    var FISH_X = 0.24;
    // How long it takes to swim away once it has been landed.
    var FISH_EXIT_S = 1.6;

    // Where the koi keeps its station. The scene is only as wide as
    // the screen is tall times its aspect, so on a narrow screen the
    // koi swims closer to the boat: it never leaves the frame.
    function fishStation() {
        var aspect = 1.5;
        if (gl && gl.canvas && gl.canvas.clientHeight > 0) {
            aspect = gl.canvas.clientWidth / gl.canvas.clientHeight;
        }
        return Math.min(FISH_X, Math.max(0.10, aspect * 0.33));
    }

    // -- the koi's own drawing: plain 2D canvas paths, not a shader -----
    //
    // The koi used to be signed-distance-field math inside the fragment
    // shader, unioned and smoothstepped pixel by pixel - hard to sketch,
    // hard to fix (the dorsal fin ended up pointing the wrong way twice).
    // It is now ordinary paths on their own <canvas id="koiCanvas">,
    // stacked over the WebGL one. The body outline below is in the same
    // local units the shader version used (nose at x=0.056, tail
    // peduncle at x=-0.040), so the proportions already worked out
    // carry over; only the mechanism changed.

    function smoothstep01(edge0, edge1, x) {
        var t = clamp01((x - edge0) / (edge1 - edge0));
        return t * t * (3 - 2 * t);
    }
    function lerp(a, b, t) { return a + (b - a) * t; }

    // A point on a flowing veil (tail/fin edge): t runs 0 at the root to
    // 1 at the tip, so the beat and a faster secondary flutter both
    // grow from nothing at the root to their full swing at the tip -
    // the fin pivots and ripples like silk instead of swinging as one
    // rigid flag or tearing away from the body.
    function veilPoint(rootX, tipX, x, y, beat, swim, phase, rippleAmp) {
        var t = clamp01((rootX - x) / (rootX - tipX));
        var flutter = rippleAmp * t * Math.sin(swim * 3.3 + t * 3.0 + phase);
        return [x, y + beat * t + flutter];
    }

    // The tail: a long forked veil, not a stubby fork - two ribbons that
    // taper to a point and flutter, sharing a root fixed at the body's
    // peduncle so no seam opens as they sway.
    function pathKoiTail(ctx, beat, swim) {
        var R = -0.040, T = -0.148;
        function vp(x, y, phase) { return veilPoint(R, T, x, y, beat, swim, phase, 0.007); }

        var a = vp(-0.040, 0.009, 0.0), c1 = vp(-0.078, 0.036, 0.0),
            c2 = vp(-0.112, 0.028, 0.0), tip = vp(-0.148, 0.013, 0.0),
            c2i = vp(-0.118, 0.006, 0.5), c1i = vp(-0.082, 0.010, 0.5),
            ri = vp(-0.040, 0.002, 0.5);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], tip[0], tip[1]);
        ctx.bezierCurveTo(c2i[0], c2i[1], c1i[0], c1i[1], ri[0], ri[1]);
        ctx.closePath();

        var a2 = vp(-0.040, -0.009, 0.0), c1b = vp(-0.078, -0.036, 0.0),
            c2b = vp(-0.112, -0.028, 0.0), tipb = vp(-0.148, -0.013, 0.0),
            c2ib = vp(-0.118, -0.006, 0.5), c1ib = vp(-0.082, -0.010, 0.5),
            rib = vp(-0.040, -0.002, 0.5);
        ctx.moveTo(a2[0], a2[1]);
        ctx.bezierCurveTo(c1b[0], c1b[1], c2b[0], c2b[1], tipb[0], tipb[1]);
        ctx.bezierCurveTo(c2ib[0], c2ib[1], c1ib[0], c1ib[1], rib[0], rib[1]);
        ctx.closePath();
    }

    function pathKoiPectoral(ctx, swim) {
        var beat = 0.012 * Math.sin(swim * 1.7 + 1.3);
        var tipX = 0.000 + beat, tipY = -0.036 - 0.004 * Math.sin(swim * 2.1);
        ctx.beginPath();
        ctx.moveTo(0.024, -0.004);
        ctx.quadraticCurveTo(0.024, -0.022, tipX, tipY);
        ctx.quadraticCurveTo(0.014, -0.016, 0.009, -0.003);
        ctx.closePath();
        return [[0.024, -0.004], [tipX, tipY]];
    }

    // A steep leading edge near the head, a long trailing slope down to
    // the tail side - a sail that leans back, not forward - swept into a
    // flowing tip rather than a stiff triangle.
    function pathKoiDorsal(ctx, swim) {
        var sway = 0.006 * Math.sin(swim * 2.6 + 0.8);
        var tipX = -0.006 + sway, tipY = 0.044 + 0.004 * Math.sin(swim * 1.6);
        ctx.beginPath();
        ctx.moveTo(0.015, 0.014);
        ctx.quadraticCurveTo(0.012, 0.030, tipX, tipY);
        ctx.quadraticCurveTo(-0.016, 0.026, -0.026, 0.008);
        ctx.quadraticCurveTo(-0.004, 0.015, 0.015, 0.014);
        ctx.closePath();
        return [[0.015, 0.014], [tipX, tipY]];
    }

    function pathKoiBody(ctx) {
        ctx.beginPath();
        ctx.moveTo(0.058, 0.000);
        ctx.bezierCurveTo(0.054, 0.014, 0.036, 0.018, 0.010, 0.017);
        ctx.bezierCurveTo(-0.012, 0.016, -0.030, 0.012, -0.041, 0.005);
        ctx.lineTo(-0.041, -0.004);
        ctx.bezierCurveTo(-0.028, -0.010, -0.006, -0.013, 0.014, -0.012);
        ctx.bezierCurveTo(0.034, -0.011, 0.050, -0.008, 0.058, 0.000);
        ctx.closePath();
    }

    function pathKoiBarbels(ctx, swim) {
        var sway = Math.sin(swim * 1.3) * 0.004;
        ctx.beginPath();
        ctx.moveTo(0.051, -0.003);
        ctx.quadraticCurveTo(0.060, -0.014 + sway, 0.053, -0.027 + sway * 1.4);
        ctx.moveTo(0.047, -0.006);
        ctx.quadraticCurveTo(0.052, -0.018 - sway, 0.041, -0.029 - sway * 1.4);
    }

    // A soft blotch with no hard edge: a radial gradient of one colour,
    // opaque at the centre and fading to nothing at the rim, scaled into
    // an ellipse. Kohaku markings are blotches, not stencilled ovals.
    function softPatch(ctx, cx, cy, rx, ry, rgb, alpha) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(rx, ry);
        var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        var a = typeof alpha === 'number' ? alpha : 0.95;
        g.addColorStop(0, rgbaStr(rgb, a));
        g.addColorStop(0.65, rgbaStr(rgb, a * 0.9));
        g.addColorStop(1, rgbaStr(rgb, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // The aura: a creature the chain calls should not look like it was
    // pasted onto the water. A soft warm glow, invisible until the hold
    // starts filling, then brightening as it nears being landed.
    function drawKoiAura(ctx, hold) {
        if (hold <= 0.02) return;
        var r = 0.052 + hold * 0.028;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        softPatch(ctx, 0.000, 0.000, r, r * 0.62, [255, 205, 120], 0.16 * hold);
        softPatch(ctx, 0.000, 0.000, r * 0.6, r * 0.4, [255, 225, 160], 0.14 * hold);
        ctx.restore();
    }

    function drawKoiSparkle(ctx, x, y, size, alpha) {
        if (alpha <= 0.01) return;
        ctx.save();
        ctx.translate(x, y);
        ctx.globalAlpha *= alpha;
        ctx.fillStyle = rgbaStr([255, 250, 230], 0.95);
        ctx.beginPath();
        ctx.moveTo(0, -size);
        ctx.lineTo(size * 0.22, -size * 0.22);
        ctx.lineTo(size, 0);
        ctx.lineTo(size * 0.22, size * 0.22);
        ctx.lineTo(0, size);
        ctx.lineTo(-size * 0.22, size * 0.22);
        ctx.lineTo(-size, 0);
        ctx.lineTo(-size * 0.22, -size * 0.22);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    // Motes of light, only once the hold is worth announcing - the koi
    // "takes the light" as it is nearly landed.
    function drawKoiSparkles(ctx, hold, swim) {
        if (hold <= 0.12) return;
        var pts = [[0.032, 0.021], [-0.012, 0.026], [0.048, -0.008], [-0.040, -0.012]];
        for (var k = 0; k < pts.length; k++) {
            var tw = 0.5 + 0.5 * Math.sin(swim * 2.3 + k * 2.1);
            drawKoiSparkle(ctx, pts[k][0], pts[k][1], 0.0032 * (0.6 + 0.4 * tw), hold * tw);
        }
    }

    var KOI_SCALE = 1.25;
    var KOI_FIN_BASE = [242, 173, 92];
    var KOI_FIN_TIP = [255, 228, 180];
    var KOI_OUTLINE_RGB = [59, 33, 20];
    var KOI_OUTLINE_ALPHA = 0.55;

    function finGradient(ctx, root, tip, tipAlpha) {
        var g = ctx.createLinearGradient(root[0], root[1], tip[0], tip[1]);
        g.addColorStop(0, rgbaStr(KOI_FIN_BASE, 0.95));
        g.addColorStop(1, rgbaStr(KOI_FIN_TIP, tipAlpha));
        return g;
    }

    function drawKoi(timeWrapped) {
        if (!koiCtx || !koiCanvasEl) return;
        var ctx = koiCtx;
        var W = koiCanvasEl.width, H = koiCanvasEl.height;
        ctx.clearRect(0, 0, W, H);

        var fade = clamp01(fishFade);
        if (fade <= 0.002 || W <= 0 || H <= 0) return;

        // The same boat-centre math the shader uses (scale, bob, origin),
        // so the koi keeps station against the boat exactly as before.
        var uScaleNow = spriteScale * (1.0 + chainPulse * PULSE_SCALE);
        var idle = 1 - smoothstep01(0, 8, currentSpm);
        var bob = Math.sin(2 * Math.PI * timeWrapped / 300 * 60) *
                  0.0035 * uScaleNow * lerp(0.5, 1.0, idle);
        var originY = 0.5 * 0.5 + bob;
        var boatCenterY = originY + 0.012 * uScaleNow;

        var swim = timeWrapped * 2.2;
        var koiBob = Math.sin(swim * 0.55) * 0.006;
        var koiYaw = Math.sin(swim * 0.42) * 0.08;
        var koiPosX = 0.5 + fishX;
        var koiPosY = boatCenterY + 0.030 + koiBob;

        // P-space -> pixels: x is aspect-corrected in the shader, so
        // undoing that and using the canvas height as the common unit
        // (for x and y alike) lines the koi up with the boat exactly.
        var aspect = koiCanvasEl.clientHeight > 0 ?
            koiCanvasEl.clientWidth / koiCanvasEl.clientHeight : 1.5;
        var u = (koiPosX - 0.5) / aspect + 0.5;
        var px = u * W;
        var py = (1 - koiPosY) * H;
        var s = H * KOI_SCALE;

        var beatTail = Math.sin(swim * 1.9) * 0.011;
        var hold = clamp01(fishHold);
        var holdWarm = hold * 0.8;
        var koiRedRGB = [
            Math.round(lerp(0.90, 1.00, holdWarm) * 255),
            Math.round(lerp(0.24, 0.70, holdWarm) * 255),
            Math.round(lerp(0.13, 0.26, holdWarm) * 255)
        ];

        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(px, py);
        ctx.rotate(-koiYaw);
        ctx.scale(s, -s);
        ctx.lineJoin = 'round';
        ctx.lineWidth = 1.3 / s;

        drawKoiAura(ctx, hold);

        // Fins first, so the body drawn over them hides each root and
        // leaves only the part that should stick out past the silhouette.
        pathKoiTail(ctx, beatTail, swim);
        ctx.fillStyle = finGradient(ctx, [-0.040, 0], [-0.148, 0], 0.30);
        ctx.fill();
        ctx.strokeStyle = rgbaStr(KOI_OUTLINE_RGB, KOI_OUTLINE_ALPHA); ctx.stroke();

        var pecPts = pathKoiPectoral(ctx, swim);
        ctx.fillStyle = finGradient(ctx, pecPts[0], pecPts[1], 0.35);
        ctx.fill();
        ctx.strokeStyle = rgbaStr(KOI_OUTLINE_RGB, KOI_OUTLINE_ALPHA); ctx.stroke();

        var dorPts = pathKoiDorsal(ctx, swim);
        ctx.fillStyle = finGradient(ctx, dorPts[0], dorPts[1], 0.35);
        ctx.fill();
        ctx.strokeStyle = rgbaStr(KOI_OUTLINE_RGB, KOI_OUTLINE_ALPHA); ctx.stroke();

        // The body: a soft vertical shade (not a flat fill), over the
        // fin roots, and its kohaku markings as soft blotches clipped to
        // its own silhouette so they never spill past the outline.
        pathKoiBody(ctx);
        var bodyGrad = ctx.createLinearGradient(0, 0.018, 0, -0.013);
        bodyGrad.addColorStop(0, rgbStr([224, 217, 203]));
        bodyGrad.addColorStop(0.45, rgbStr([250, 246, 238]));
        bodyGrad.addColorStop(1, rgbStr([255, 253, 249]));
        ctx.fillStyle = bodyGrad;
        ctx.fill();
        ctx.save();
        pathKoiBody(ctx);
        ctx.clip();
        softPatch(ctx, 0.028, -0.001, 0.019, 0.0078, koiRedRGB);
        softPatch(ctx, 0.000, 0.007, 0.010, 0.0048, koiRedRGB);
        softPatch(ctx, -0.021, 0.002, 0.012, 0.0058, koiRedRGB);
        // A sheen along the spine, the way light sits on wet scales.
        softPatch(ctx, 0.004, 0.012, 0.036, 0.0035, [255, 251, 244], 0.35);
        ctx.restore();
        pathKoiBody(ctx);
        ctx.strokeStyle = rgbaStr(KOI_OUTLINE_RGB, KOI_OUTLINE_ALPHA);
        ctx.stroke();

        pathKoiBarbels(ctx, swim);
        ctx.strokeStyle = rgbaStr([205, 150, 85], 0.55);
        ctx.lineWidth = 1.0 / s;
        ctx.lineCap = 'round';
        ctx.stroke();

        // The eye: a thin gold ring around the dark iris, with a glint -
        // the one detail that makes it read as a creature, not a sticker.
        ctx.beginPath();
        ctx.ellipse(0.046, 0.003, 0.0040, 0.0040, 0, 0, Math.PI * 2);
        ctx.strokeStyle = rgbaStr([255, 212, 128], 0.85);
        ctx.lineWidth = 0.9 / s;
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(0.046, 0.003, 0.0028, 0.0028, 0, 0, Math.PI * 2);
        ctx.fillStyle = rgbStr([10, 10, 12]);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(0.0475, 0.0045, 0.0009, 0.0009, 0, 0, Math.PI * 2);
        ctx.fillStyle = rgbaStr([255, 255, 255], 0.85);
        ctx.fill();

        drawKoiSparkles(ctx, hold, swim);

        ctx.restore();
    }

    // -- the scenery along the ridge: villages, mills, churches ---------
    //
    // Alto's Adventure is the reference: landmarks silhouetted on the
    // ridge, among the trees, scrolling past at the same pace as the
    // land they stand on. Like the koi, these are plain 2D canvas paths
    // on their own <canvas id="sceneryCanvas"> - the shader's forest is
    // noise thresholded into a jagged band (see the GLSL "Pines along
    // the nearest ridge" block), which gives a forest its texture but
    // cannot give a windmill its blades or a church its spire.
    //
    // Placement has to land exactly on that same noisy ridge line, or a
    // building floats above the hill or sinks into it - so the handful
    // of GLSL functions that shape it (hash, noise, peakProfile) are
    // ported here verbatim rather than approximated.

    function fractJS(x) { return x - Math.floor(x); }

    function hashJS(x, y) {
        var wx = ((x % 1024) + 1024) % 1024;
        var wy = ((y % 1024) + 1024) % 1024;
        var px = fractJS(wx * 123.34);
        var py = fractJS(wy * 456.21);
        var d = px * (px + 45.32) + py * (py + 45.32);
        px += d; py += d;
        return fractJS(px * py);
    }

    function noiseJS(x, y) {
        var wx = ((x % 1024) + 1024) % 1024;
        var wy = ((y % 1024) + 1024) % 1024;
        var ix = Math.floor(wx), iy = Math.floor(wy);
        var fx = wx - ix, fy = wy - iy;
        var ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
        var uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
        var h00 = hashJS(ix, iy), h10 = hashJS(ix + 1, iy);
        var h01 = hashJS(ix, iy + 1), h11 = hashJS(ix + 1, iy + 1);
        return lerp(lerp(h00, h10, ux), lerp(h01, h11, ux), uy);
    }

    var TAU_JS = Math.PI * 2;
    function peakProfileJS(x, sharp) {
        var rounded = Math.sin(x);
        var tri = Math.abs(fractJS((x + 1.5707963) / TAU_JS + 0.5) - 0.5) * 4.0 - 1.0;
        return lerp(rounded, tri, sharp);
    }

    // The same line the shader's nearest pine band stands on (horizon +
    // 0.01, warped by the peaks and a touch of noise). sc is the
    // scrolled x (screen-fraction u, minus the world's own scroll) -
    // see the GLSL "Pines along the nearest ridge" block.
    function ridgeLineY(sc, sharpVal, agitationVal) {
        var baseY = 0.51;
        var pp = peakProfileJS(sc * 44.0 + 2.0, sharpVal);
        var nz = noiseJS(sc * 8.0, baseY * 5.0) * 0.5 - 0.25;
        return baseY + (pp + nz) * 0.007 * agitationVal;
    }

    // The same night-darkening the shader applies to the land (see
    // darknessFactor in the GLSL background block), so a village does
    // not stay daylit through the night it stands in.
    function darkenRGB(rgb, darkness) {
        return [
            lerp(rgb[0], rgb[0] * 0.25, darkness),
            lerp(rgb[1], rgb[1] * 0.25, darkness),
            lerp(rgb[2], rgb[2] * 0.40, darkness)
        ];
    }
    // The theme's grade (costume.js) is the one thing the shader
    // multiplies the WHOLE frame by, right at the end (u_tint in the
    // GLSL). These two canvases composite on top of that already-graded
    // WebGL frame, so every colour built here needs the same multiply,
    // or a themed session (three sessions out of every four get one -
    // see THEMES in costume.js) leaves the koi and the scenery looking
    // visibly flat next to a tinted scene. All colour-string building in
    // both drawKoi() and drawScenery() goes through these two, so the
    // grade - and the rounding - only has to be right in one place.
    function themeTint() {
        return (costume && costume.theme && costume.theme.tint) || [1, 1, 1];
    }
    function tintChannel(v, t) {
        return Math.max(0, Math.min(255, Math.round(v * t)));
    }
    function rgbStr(rgb) {
        var t = themeTint();
        return 'rgb(' + tintChannel(rgb[0], t[0]) + ',' + tintChannel(rgb[1], t[1]) + ',' +
               tintChannel(rgb[2], t[2]) + ')';
    }
    function rgbaStr(rgb, alpha) {
        var t = themeTint();
        return 'rgba(' + tintChannel(rgb[0], t[0]) + ',' + tintChannel(rgb[1], t[1]) + ',' +
               tintChannel(rgb[2], t[2]) + ',' + alpha + ')';
    }

    function drawHouseShape(ctx, x0, y0, ww, hh) {
        var wallH = hh * 0.55;
        ctx.moveTo(x0 - ww / 2, y0);
        ctx.lineTo(x0 - ww / 2, y0 - wallH);
        ctx.lineTo(x0 - ww * 0.62, y0 - wallH);
        ctx.lineTo(x0, y0 - hh);
        ctx.lineTo(x0 + ww * 0.62, y0 - wallH);
        ctx.lineTo(x0 + ww / 2, y0 - wallH);
        ctx.lineTo(x0 + ww / 2, y0);
        ctx.closePath();
    }

    // A cluster of two or three cottages, not one - a village is a
    // gathering, and one roof alone reads as just another pine.
    function drawHouseCluster(ctx, bx, by, w, h, seed) {
        ctx.beginPath();
        var n = hashJS(seed, 91) > 0.45 ? 3 : 2;
        for (var i = 0; i < n; i++) {
            var jx = (hashJS(seed, i * 7 + 3) - 0.5) * w * 1.3;
            var jy = hashJS(seed, i * 7 + 9) * h * 0.08;
            var sc = 0.6 + 0.55 * hashJS(seed, i * 7 + 5);
            drawHouseShape(ctx, bx + jx, by + jy, w * 0.55 * sc, h * sc);
        }
        ctx.fill();
    }

    // The blades turn on the real clock, at a speed tuned to complete a
    // whole number of turns every TIME_WRAP seconds - u_time (and this,
    // its JS twin) wraps there, so the sweep never jumps.
    var WINDMILL_TURNS_PER_WRAP = 20;

    function drawWindmill(ctx, bx, by, w, h, seed, windT, silRGB) {
        var towerW = w, towerH = h * 0.72;
        var topW = towerW * 0.55;
        var hubY = by - towerH;
        ctx.beginPath();
        ctx.moveTo(bx - towerW / 2, by);
        ctx.lineTo(bx - topW / 2, hubY);
        ctx.lineTo(bx + topW / 2, hubY);
        ctx.lineTo(bx + towerW / 2, by);
        ctx.closePath();
        ctx.moveTo(bx - topW / 2, hubY);
        ctx.lineTo(bx, hubY - h * 0.14);
        ctx.lineTo(bx + topW / 2, hubY);
        ctx.closePath();
        ctx.fill();

        // A real sail, not a turbine blade: a long thin uniform arm (not
        // tapered to a point) with a lattice of crossbars along it - the
        // rungs every windmill sail frame has, and the one detail that
        // tells it apart from an aerodynamic blade at this silhouette size.
        var cx = bx, cy = hubY - h * 0.03;
        var bladeLen = h * 0.50, armW = h * 0.020;
        var slatTs = [0.30, 0.50, 0.70, 0.88], slatLen = bladeLen * 0.32;
        var baseAngle = hashJS(seed, 37) * TAU_JS + windT;
        // The 4 blades' axes, computed once and shared by the lattice
        // pass below and the sail pass after it, rather than each
        // re-deriving cos/sin/perpendicular from the angle on its own.
        var blades = [];
        for (var bI = 0; bI < 4; bI++) {
            var bA = baseAngle + bI * (Math.PI / 2);
            var bDx = Math.cos(bA), bDy = Math.sin(bA);
            blades.push({ dx: bDx, dy: bDy, px: -bDy, py: bDx });
        }

        ctx.beginPath();
        for (var k = 0; k < 4; k++) {
            var dx = blades[k].dx, dy = blades[k].dy, px = blades[k].px, py = blades[k].py;
            var rootX = cx + dx * bladeLen * 0.08, rootY = cy + dy * bladeLen * 0.08;
            var tipX = cx + dx * bladeLen, tipY = cy + dy * bladeLen;
            ctx.moveTo(rootX + px * armW * 0.5, rootY + py * armW * 0.5);
            ctx.lineTo(tipX + px * armW * 0.5, tipY + py * armW * 0.5);
            ctx.lineTo(tipX - px * armW * 0.5, tipY - py * armW * 0.5);
            ctx.lineTo(rootX - px * armW * 0.5, rootY - py * armW * 0.5);
            ctx.closePath();

            for (var r = 0; r < slatTs.length; r++) {
                var slatCx = cx + dx * bladeLen * slatTs[r], slatCy = cy + dy * bladeLen * slatTs[r];
                ctx.moveTo(slatCx + px * slatLen * 0.5 + dx * armW * 0.5, slatCy + py * slatLen * 0.5 + dy * armW * 0.5);
                ctx.lineTo(slatCx + px * slatLen * 0.5 - dx * armW * 0.5, slatCy + py * slatLen * 0.5 - dy * armW * 0.5);
                ctx.lineTo(slatCx - px * slatLen * 0.5 - dx * armW * 0.5, slatCy - py * slatLen * 0.5 - dy * armW * 0.5);
                ctx.lineTo(slatCx - px * slatLen * 0.5 + dx * armW * 0.5, slatCy - py * slatLen * 0.5 + dy * armW * 0.5);
                ctx.closePath();
            }
        }
        ctx.fill();

        // The cloth, over the lattice, loose enough that the frame still
        // shows through it - a sail is canvas stretched on the frame,
        // not a solid blade.
        var sailWidth = armW * 5.0;
        ctx.beginPath();
        for (var m = 0; m < 4; m++) {
            var dxm = blades[m].dx, dym = blades[m].dy, pxm = blades[m].px, pym = blades[m].py;
            var inRootX = cx + dxm * bladeLen * 0.22, inRootY = cy + dym * bladeLen * 0.22;
            var inTipX = cx + dxm * bladeLen * 0.92, inTipY = cy + dym * bladeLen * 0.92;
            ctx.moveTo(inRootX, inRootY);
            ctx.lineTo(inTipX, inTipY);
            ctx.lineTo(inTipX + pxm * sailWidth, inTipY + pym * sailWidth);
            ctx.lineTo(inRootX + pxm * sailWidth * 0.15, inRootY + pym * sailWidth * 0.15);
            ctx.closePath();
        }
        ctx.fillStyle = rgbaStr(silRGB, 0.5);
        ctx.fill();
        ctx.fillStyle = rgbStr(silRGB);
    }

    function drawChurch(ctx, bx, by, w, h, seed) {
        var naveW = w, naveH = h * 0.42;
        var towerSide = hashJS(seed, 201) > 0.5 ? 1 : -1;
        var towerX = bx + towerSide * naveW * 0.38;
        var towerW = naveW * 0.30;
        var towerH = h * 0.95;

        ctx.beginPath();
        ctx.moveTo(bx - naveW / 2, by);
        ctx.lineTo(bx - naveW / 2, by - naveH);
        ctx.lineTo(bx, by - naveH - naveH * 0.55);
        ctx.lineTo(bx + naveW / 2, by - naveH);
        ctx.lineTo(bx + naveW / 2, by);
        ctx.closePath();
        ctx.moveTo(towerX - towerW / 2, by);
        ctx.lineTo(towerX - towerW / 2, by - towerH * 0.8);
        ctx.lineTo(towerX, by - towerH);
        ctx.lineTo(towerX + towerW / 2, by - towerH * 0.8);
        ctx.lineTo(towerX + towerW / 2, by);
        ctx.closePath();
        ctx.fill();

        var cyTop = by - towerH - h * 0.10;
        ctx.beginPath();
        ctx.moveTo(towerX, by - towerH);
        ctx.lineTo(towerX, cyTop);
        ctx.moveTo(towerX - h * 0.035, cyTop + h * 0.035);
        ctx.lineTo(towerX + h * 0.035, cyTop + h * 0.035);
        ctx.lineWidth = Math.max(1, h * 0.018);
        ctx.strokeStyle = ctx.fillStyle;
        ctx.stroke();
    }

    // The one fantastical silhouette among the three real ones: a
    // slender tower under an onion dome, with a tiny flag at the top.
    function drawFantasyTower(ctx, bx, by, w, h) {
        var shaftH = h * 0.68, shaftTopW = w * 0.55;
        ctx.beginPath();
        ctx.moveTo(bx - w / 2, by);
        ctx.lineTo(bx - shaftTopW / 2, by - shaftH);
        ctx.lineTo(bx + shaftTopW / 2, by - shaftH);
        ctx.lineTo(bx + w / 2, by);
        ctx.closePath();
        var domeW = w * 1.15, domeH = h * 0.26;
        ctx.moveTo(bx - shaftTopW / 2, by - shaftH);
        ctx.quadraticCurveTo(bx - domeW / 2, by - shaftH - domeH * 0.5, bx, by - shaftH - domeH);
        ctx.quadraticCurveTo(bx + domeW / 2, by - shaftH - domeH * 0.5, bx + shaftTopW / 2, by - shaftH);
        ctx.closePath();
        ctx.fill();

        var flagY0 = by - shaftH - domeH;
        ctx.beginPath();
        ctx.moveTo(bx, flagY0);
        ctx.lineTo(bx, flagY0 - h * 0.12);
        ctx.lineWidth = Math.max(1, h * 0.015);
        ctx.strokeStyle = ctx.fillStyle;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(bx, flagY0 - h * 0.12);
        ctx.lineTo(bx + w * 0.22, flagY0 - h * 0.09);
        ctx.lineTo(bx, flagY0 - h * 0.06);
        ctx.closePath();
        ctx.fill();
    }

    // One candidate landmark slot every SCENERY_FREQ of the pine band's
    // own scroll space - wide enough that a village is a landmark among
    // the trees, not wallpaper repeating with them.
    var SCENERY_FREQ = 6.0;
    var SCENERY_DENSITY = 0.40;
    var SCENERY_TYPES = ['house', 'windmill', 'church', 'tower'];
    var SCENERY_SIZES = {
        house:    { wFrac: 0.050, hFrac: 0.050 },
        windmill: { wFrac: 0.024, hFrac: 0.095 },
        church:   { wFrac: 0.060, hFrac: 0.085 },
        tower:    { wFrac: 0.022, hFrac: 0.090 }
    };

    // Whether a landmark exists in slot k, and which one, is a pure
    // function of k alone - cached here instead of re-rolling the same
    // three hashes for the same slot on every one of ~60 frames a
    // second while it sits on screen (or off, waiting to scroll in).
    var sceneryCandidateCache = {};
    function sceneryCandidate(k) {
        var hit = sceneryCandidateCache[k];
        if (hit !== undefined) return hit;
        var result = null;
        if (hashJS(k, 501) < SCENERY_DENSITY) {
            var typeRoll = hashJS(k, 777);
            var type = SCENERY_TYPES[Math.min(SCENERY_TYPES.length - 1,
                Math.floor(typeRoll * SCENERY_TYPES.length))];
            result = {
                type: type,
                jitter: (hashJS(k, 314) - 0.5) * 0.7,
                sizeJit: 0.82 + 0.4 * hashJS(k, 913)
            };
        }
        sceneryCandidateCache[k] = result;
        return result;
    }

    function drawScenery(timeWrapped) {
        if (!sceneryCtx || !sceneryCanvasEl) return;
        var ctx = sceneryCtx;
        var W = sceneryCanvasEl.width, H = sceneryCanvasEl.height;
        ctx.clearRect(0, 0, W, H);
        if (W <= 0 || H <= 0) return;

        // costume.biome is set by every real path (Costume.outfit() and
        // defaultCostume() both always populate it - see dressScene()'s
        // identical `if (bm)` guard), but setCostume() itself only
        // validates outfit.livery/outfit.theme. A future caller that
        // skips it would otherwise throw inside the rAF callback and
        // freeze the whole scene, not just the ridge.
        if (!costume || !costume.biome) return;

        var sharpVal = sharpLevel * SHARP_MAX;
        var agitationVal = 1.0 + chainLevel * 0.7;
        var dayCycle = fractJS(timeWrapped / 300.0);
        var darkness = smoothstep01(0.55, 0.75, dayCycle) *
                        (1 - smoothstep01(0.95, 1.0, dayCycle));
        var treeRGB255 = [costume.biome.tree[0] * 255, costume.biome.tree[1] * 255,
                           costume.biome.tree[2] * 255];

        var scroll = flow * 0.40;
        var firstK = Math.floor(SCENERY_FREQ * (-0.12 - scroll)) - 1;
        var lastK = Math.ceil(SCENERY_FREQ * (1.12 - scroll)) + 1;
        var windT = (timeWrapped / TIME_WRAP) * (TAU_JS * WINDMILL_TURNS_PER_WRAP);
        // The same sweep of light the ridge/pines answer with on a
        // livery change (worldSweep in the GLSL) - evaluated at each
        // building's own position, so a village lit by the sweep isn't
        // left a flat silhouette while the hillside around it flashes.
        var sweepX = (liverySweep - 0.5) * 3.0;

        for (var k = firstK; k <= lastK; k++) {
            var candidate = sceneryCandidate(k);
            if (!candidate) continue;
            var type = candidate.type;
            var sc = (k + 0.5 + candidate.jitter) / SCENERY_FREQ;
            var u = sc + scroll;
            if (u < -0.1 || u > 1.1) continue;

            var px = u * W;
            var sizeDef = SCENERY_SIZES[type];
            var sizeJit = candidate.sizeJit;
            var w = sizeDef.wFrac * W * sizeJit;
            var h = sizeDef.hFrac * H * sizeJit;

            // The base has to clear the ridge across the whole footprint,
            // not just at its centre - a flat-bottomed building sampled
            // at one point can land with its centre on a peak and sky
            // showing under both corners. Sitting it at the lowest of
            // three samples (left edge, centre, right edge) sinks it
            // into the hill instead of balancing it on top of one.
            var halfWsc = (w / W) * 0.6;
            var ryC = ridgeLineY(sc, sharpVal, agitationVal);
            var ryL = ridgeLineY(sc - halfWsc, sharpVal, agitationVal);
            var ryR = ridgeLineY(sc + halfWsc, sharpVal, agitationVal);
            var ry = Math.min(ryC, ryL, ryR);
            var py = (1 - ry) * H;

            var worldSweep = liverySweep > 0.001 ?
                Math.exp(-Math.pow((u - sweepX) * 4.5, 2.0)) : 0;
            var pineRGB = [
                treeRGB255[0] + 255 * 1.00 * worldSweep * 0.28,
                treeRGB255[1] + 255 * 0.95 * worldSweep * 0.28,
                treeRGB255[2] + 255 * 0.85 * worldSweep * 0.28
            ];
            var silRGB = darkenRGB(pineRGB, darkness);
            ctx.fillStyle = rgbStr(silRGB);

            if (type === 'house') drawHouseCluster(ctx, px, py, w, h, k);
            else if (type === 'windmill') drawWindmill(ctx, px, py, w, h, k, windT, silRGB);
            else if (type === 'church') drawChurch(ctx, px, py, w, h, k);
            else drawFantasyTower(ctx, px, py, w, h);
        }
    }

    // How far, in metres, the ghost can be and still be drawn. Beyond
    // that it has left the screen, and there is nothing to look at.
    var GHOST_MAX_GAP_M = 400;
    // How many metres make one unit of the screen's width. Tuned so
    // that a hundred metres is a visible distance on a phone.
    var GHOST_UV_PER_M = 0.0005;
    // The dressing. The livery of the boat and the kit of the rower
    // come from costume.js, which reads them off the rower's history;
    // the theme is the grade of the hour. The scene only wears them.
    //
    // The scene is dressed as soon as it loads, not when the GL program
    // is linked: a WebGL uniform starts at zero, and a theme of zero
    // would multiply the whole frame by nothing - a black picture. The
    // 'phases' renderer never links a program at all, and still has to
    // know what the boat wears.
    var costume = defaultCostume();
    var costumeKey = costume.livery.key;
    // The sweep of light that runs along the hull when the livery
    // changes. It is the only thing the game says by itself, and it
    // says it with light rather than with words.
    var liverySweep = 0;
    var liverySweepT = 0;
    var LIVERY_SWEEP_S = 2.2;

    // The player's own distance and session clock, for the ghost to be
    // measured against.
    var currentDistance = 0;
    var sessionElapsed = 0;

    // How much faster the world runs at a full chain.
    var CHAIN_TIME_SCALE = 0.5;     // the day turns, the water moves
    var CHAIN_SCROLL_SCALE = 0.35;  // the scenery scrolls
    // A tier up gives the scene a short bump: a surge of the boat, not
    // an earthquake.
    var PULSE_S = 0.45;
    var PULSE_SCALE = 0.12;
    // How quickly the shape of the range follows the chain. The land is
    // not a reflex: the peaks take their angles over about a minute, and
    // they give them back just as slowly.
    var SHARP_SLEW = 1 / 30;
    // How far the peaks ever go. They take angles, they do not turn into
    // a saw blade: the range keeps some of its softness.
    var SHARP_MAX = 0.75;
    var sharpLevel = 0;

    function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

    // The outfit the scene starts in: the club livery and no grade over
    // the frame. The controller replaces it as soon as it knows the
    // rower's history and the hour's weather.
    function defaultCostume() {
        if (typeof Costume !== 'undefined') return Costume.outfit(0, null);
        return {
            livery: { key: 'club', hull: [[0.75, 0.92, 0.70], [0.30, 0.50, 0.30]],
                      shirt: [0.85, 0.20, 0.15], shorts: [0.15, 0.15, 0.18],
                      cap: [0.10, 0.25, 0.55] },
            biome: { key: 'conifers', ridgeFar: [0.78, 0.55, 0.65],
                     ridgeNear: [0.22, 0.18, 0.30], tree: [0.19, 0.16, 0.28],
                     density: 0.3 },
            theme: { key: 'clear', tint: [1, 1, 1] }
        };
    }

    // Put the outfit on the GPU: the colours of the livery, the colours
    // of the land, and the theme's grade. Called when the program is
    // linked - a WebGL uniform starts at zero, and a tint of zero would
    // make the whole frame black - and then every frame, which is cheap
    // and cannot go stale.
    function dressScene() {
        if (!gl || !uniforms || !costume) return;
        var lv = costume.livery;
        var bm = costume.biome;
        var th = costume.theme;
        gl.uniform3f(uniforms.uHullA,  lv.hull[0][0], lv.hull[0][1], lv.hull[0][2]);
        gl.uniform3f(uniforms.uHullB,  lv.hull[1][0], lv.hull[1][1], lv.hull[1][2]);
        gl.uniform3f(uniforms.uShirt,  lv.shirt[0], lv.shirt[1], lv.shirt[2]);
        gl.uniform3f(uniforms.uShorts, lv.shorts[0], lv.shorts[1], lv.shorts[2]);
        gl.uniform3f(uniforms.uCap,    lv.cap[0], lv.cap[1], lv.cap[2]);
        gl.uniform3f(uniforms.uTint,   th.tint[0], th.tint[1], th.tint[2]);
        if (bm) {
            gl.uniform3f(uniforms.uRidgeFar,  bm.ridgeFar[0], bm.ridgeFar[1], bm.ridgeFar[2]);
            gl.uniform3f(uniforms.uRidgeNear, bm.ridgeNear[0], bm.ridgeNear[1], bm.ridgeNear[2]);
            gl.uniform3f(uniforms.uTree,      bm.tree[0], bm.tree[1], bm.tree[2]);
            gl.uniform1f(uniforms.uTreeDensity, typeof bm.density === 'number' ? bm.density : 0.3);
        }
    }

    var SPEED_NORMALIZE = 5.0;
    var TIME_WRAP = 300.0;
    var FLOW_WRAP = 1000.0;

    // One stroke is a 0..1 cycle, linear in time, with the finish (end of
    // the drive) pinned at FINISH_PHASE. The drive is the driveFraction of
    // the cycle leading up to it and the recovery is the rest, so the catch
    // sits at FINISH_PHASE - driveFraction. DRIVE_FRACTION is the reference
    // drive:recovery of 1:2, at 24 spm.
    var DRIVE_FRACTION = 1.0 / 3.0;

    // The drive takes a larger share of the stroke as the rate goes up
    // (about 1:2.5 at 18 spm, 1:2 at 24, 1:1.5 at 32, towards 1:1 flat out).
    var DRIVE_REF_SPM      = 24.0;
    var DRIVE_PER_SPM      = 0.0085;
    var DRIVE_FRACTION_MIN = 0.25;
    var DRIVE_FRACTION_MAX = 0.5;
    var DRIVE_EASE_RATE    = 0.5;   // 1/s, so a rate change never jerks the pose
    var driveFraction = DRIVE_FRACTION;

    function driveFractionForSpm(spm) {
        if (!(spm > 0)) return DRIVE_FRACTION;
        return Math.min(DRIVE_FRACTION_MAX, Math.max(DRIVE_FRACTION_MIN,
            DRIVE_FRACTION + (spm - DRIVE_REF_SPM) * DRIVE_PER_SPM));
    }

    // Where those two landmarks sit on the shader's u_phase pose track (8
    // keyframes over 0..1, see rowing_display.html): keyframe 3 is the
    // finish (hands at the chest, full lay-back, hands move away from
    // keyframe 4 on); keyframe 7 repeats the catch of keyframe 0, so
    // 0.875..1.0 holds the catch.
    var FINISH_RENDER_PHASE = 0.375;

    // Boat surge: the hull speeds up through the drive, is fastest just
    // after the finish and slows down over the recovery. Averages 1 over a
    // stroke, so the scenery still covers the same distance.
    var SURGE_AMOUNT     = 0.2;
    var SURGE_PEAK_PHASE = DRIVE_FRACTION + 0.08;   // FINISH_PHASE + 0.08
    // The scenery speed follows a slew-limited copy of the surge, not the
    // raw value: animPhase itself can jump (a frame-gap snap, or the first
    // tick of a fresh lock chasing a still-unverified guess), and without
    // this the whole scene's scroll speed would jump with it. 12/s settles
    // in ~0.2s, fast next to a stroke period (>=1s) so the intended pulse
    // still comes through, slow next to one frame so a phase jump is felt
    // as a brief smooth ramp instead of a jerk.
    var SURGE_SLEW_RATE  = 12.0;   // 1/s
    var displaySurge = 1.0;

    function surgeFactor(a) {
        return 1.0 + SURGE_AMOUNT * Math.cos(2.0 * Math.PI * (a - SURGE_PEAK_PHASE));
    }

    function toRenderPhase(a, drive) {
        var d = drive === undefined ? DRIVE_FRACTION : drive;
        var recovery = 1.0 - d;
        var s = a - FINISH_PHASE;          // cycles since the finish
        s -= Math.floor(s);
        return s < recovery
            ? FINISH_RENDER_PHASE + s * ((1.0 - FINISH_RENDER_PHASE) / recovery)
            : (s - recovery) * (FINISH_RENDER_PHASE / d);
    }

    // ---------------------------------------------------------------------
    // Rowing phases
    //
    // The stroke cycle is made of four phases, in this order:
    //
    //   1. Prise d'eau (ou attaque) / Catch     / transition avant
    //   2. Propulsion (ou appui)    / Drive     / phase motrice
    //   3. Dégagement               / Finish    / transition arrière
    //   4. Replacement (ou retour)  / Recovery  / phase de glisse
    //
    // Catch and Finish are landmarks - the instant the blade enters the
    // water and the instant it leaves it. The table gives them a transition
    // character of their own, so each gets a short window on the pose
    // track. Drive is the effort between the two; Recovery is the glide
    // back to the next catch.
    //
    // The pose track (see toRenderPhase) runs 0..1 with the catch at 0 and
    // the finish at FINISH_RENDER_PHASE - which is exactly the order the
    // four phases appear in. So the phase of a frame is read straight off
    // the pose track, the same value the shader is fed: no second clock to
    // keep in sync with the first.
    // ---------------------------------------------------------------------
    var PHASES = [
        {
            order:    1,
            name:     'Prise d\'eau (ou attaque)',
            english:  'Catch',
            type:     'Transition avant',
            role:     'Immerger la palette',
            segments: 'Tibias verticaux, tronc penché, bras tendus',
            action:   'Relever les mains pour entrer la pelle à la verticale (au carré)'
        },
        {
            order:    2,
            name:     'Propulsion (ou appui)',
            english:  'Drive',
            type:     'Phase motrice',
            role:     'Faire avancer le bateau',
            segments: 'Jambes -> Tronc -> Bras',
            action:   'Pousser sur les cale-pieds, ouvrir le buste, tirer les poignées aux côtés'
        },
        {
            order:    3,
            name:     'Dégagement',
            english:  'Finish',
            type:     'Transition arrière',
            role:     'Sortir la palette',
            segments: 'Jambes tendues, tronc incliné en arrière',
            action:   'Abaisser les mains vers les cuisses et mettre la pelle à plat'
        },
        {
            order:    4,
            name:     'Replacement (ou retour)',
            english:  'Recovery',
            type:     'Phase de glisse',
            role:     'Revenir à l\'attaque et récupérer',
            segments: 'Bras -> Tronc -> Jambes',
            action:   'Tendre les bras, basculer le buste en avant, fléchir les genoux'
        }
    ];

    var PHASE_CATCH = 0, PHASE_DRIVE = 1, PHASE_FINISH = 2, PHASE_RECOVERY = 3;

    // Width of the two transition windows on the pose track, as a share of
    // it. Catch and finish are instants; the windows are what makes them
    // readable as phases of their own instead of single frames.
    var CATCH_WINDOW  = 0.06;
    var FINISH_WINDOW = 0.06;

    // Which phase a pose track position falls in.
    function phaseAt(pose) {
        var p = pose - Math.floor(pose);        // 0..1
        if (p < CATCH_WINDOW) return PHASE_CATCH;
        if (p < FINISH_RENDER_PHASE) return PHASE_DRIVE;
        if (p < FINISH_RENDER_PHASE + FINISH_WINDOW) return PHASE_FINISH;
        return PHASE_RECOVERY;
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

                // The very first tick of a fresh lock has only a guessed
                // period (from spm, or DEFAULT_PERIOD_S), not a measured
                // one, and the phase it's chasing from is wherever the
                // free-run happened to be (often frozen at the start, since
                // spm reads 0 until the machine has something to average).
                // Chasing that guess at full strength is a one-off, ~1 s
                // lurch every time a rowing bout starts. Keep free-running
                // until the second tick lands and lock.period is a real
                // measured interval; that correction is milder and already
                // covered by the settling window the tracker is tuned for.
                if (lock.ticks < 2) return (phase + dt * spm / 60.0) % 1.0;

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

    // Sizes a canvas's backing buffer to its CSS box at the current
    // device pixel ratio. glCanvas, koiCanvas and sceneryCanvas all share
    // the same box (see rowing_display.css) and must all be resized the
    // same way, or they silently drift out of sync with each other.
    function resizeCanvasToDisplaySize(canvas, dpr) {
        if (!canvas) return;
        var w = Math.floor(canvas.clientWidth * dpr);
        var h = Math.floor(canvas.clientHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
    }

    function resize() {
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        resizeCanvasToDisplaySize(gl.canvas, dpr);
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        resizeCanvasToDisplaySize(koiCanvasEl, dpr);
        resizeCanvasToDisplaySize(sceneryCanvasEl, dpr);
    }

    // Where the ghost is, right now. Its distance at this moment of the
    // session, against the player's distance at the same moment - the
    // only comparison that means anything.
    function updateGhost() {
      if (!ghostProfile) {
        ghostOn = 0;
        return;
      }
      var gap = Ghost.gapMetres(ghostProfile, sessionElapsed, currentDistance);
      if (Ghost.isVisible(ghostProfile, sessionElapsed, gap, GHOST_MAX_GAP_M)) {
        ghostOn = 1;
        ghostOffset = gap * GHOST_UV_PER_M;
        ghostPhase = Ghost.phaseAt(ghostProfile, sessionElapsed);
      } else {
        ghostOn = 0;
      }
    }

    function frame() {
        resize();
        var now = performance.now() / 1000;
        var dt = now - lastT;
        lastT = now;

        updateGhost();

        // The scene's own clock. It runs faster while the chain is up, so
        // the water moves, the day turns and the weather changes more
        // often. The stroke tracker below keeps using the real clock:
        // the animation's sync with the rower must not be a game effect.
        sceneClock += dt * (1.0 + chainLevel * CHAIN_TIME_SCALE);
        chainPulse = Math.max(0, chainPulse - dt / PULSE_S);
        // The sweep runs on the real clock: it is a moment of the game
        // showing off, not part of the world that speeds up with the
        // chain.
        if (liverySweepT > 0) {
            liverySweepT = Math.max(0, liverySweepT - dt / LIVERY_SWEEP_S);
            liverySweep = liverySweepT;
        } else if (liverySweep !== 0) {
            liverySweep = 0;
        }

        // The koi. It keeps its station ahead of the boat, with a slow
        // sway, and when the session has landed it, it swims away. A
        // koi that dived is simply gone: no animation, no farewell.
        if (fishExit > 0) {
            fishExit = Math.max(0, fishExit - dt);
            fishFade = fishExit / FISH_EXIT_S;
            fishX += dt * 0.30;
        } else if (fishOn) {
            fishFade = 1;
            var fishTarget = fishStation() + Math.sin(sceneClock * 0.31) * 0.025;
            fishX += (fishTarget - fishX) * Math.min(1.0, dt * 1.5);
        } else {
            fishFade = 0;
        }

        var targetSurge = currentSpm > 0 ? surgeFactor(animPhase) : 1.0;
        displaySurge += (targetSurge - displaySurge) * Math.min(1.0, dt * SURGE_SLEW_RATE);
        flow -= dt * currentSpeed * 0.26 * displaySurge *
                (1.0 + chainLevel * CHAIN_SCROLL_SCALE);
        if (flow < -FLOW_WRAP) flow += FLOW_WRAP;
        if (flow >  FLOW_WRAP) flow -= FLOW_WRAP;

        animPhase = tracker.advance(animPhase, dt, now, currentSpm);
        driveFraction += (driveFractionForSpm(currentSpm) - driveFraction) *
            Math.min(1.0, dt * DRIVE_EASE_RATE);
        var renderPhase = toRenderPhase(animPhase, driveFraction);

        var timeWrapped = sceneClock % TIME_WRAP;

        gl.uniform1f(uniforms.uTime,   timeWrapped);
        gl.uniform1f(uniforms.uDay,    dayBase + Math.floor(sceneClock / TIME_WRAP) % 1000);
        gl.uniform1f(uniforms.uSpeed,  currentSpeed);
        gl.uniform1f(uniforms.uChain,  chainLevel);
        // The peaks answer the chain too: the hills are round while the
        // rower is at their own pace, and they take angles when they
        // hold above it. The shape of the land is not a reflex, though -
        // it moves on a long leash, so the range evolves over a minute
        // rather than jumping from one shape to the next.
        sharpLevel += (chainLevel - sharpLevel) * Math.min(1, dt * SHARP_SLEW);
        gl.uniform1f(uniforms.uSharp,  sharpLevel * SHARP_MAX);
        gl.uniform1f(uniforms.uFlow,   flow);
        gl.uniform1f(uniforms.uPhase,  renderPhase);
        gl.uniform1f(uniforms.uSpm,    currentSpm);
        gl.uniform1f(uniforms.uScale,  spriteScale * (1.0 + chainPulse * PULSE_SCALE));
        gl.uniform1f(uniforms.uAspect, gl.canvas.clientWidth / gl.canvas.clientHeight);
        gl.uniform1f(uniforms.uGhostX,     ghostOffset);
        gl.uniform1f(uniforms.uGhostPhase, ghostPhase);
        gl.uniform1f(uniforms.uGhostOn,    ghostOn);
        dressScene();
        gl.uniform1f(uniforms.uLivery, liverySweep);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        drawScenery(timeWrapped);
        drawKoi(timeWrapped);

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

    // ---------------------------------------------------------------------
    // Phase strip - the shader-free renderer
    //
    // renderMode 'phases' replaces the WebGL scene with the stroke cycle
    // itself: the same tracker, the same pose track, the same surge and
    // drive-fraction easing, drawn as the four phases instead of pixels.
    // Everything the animation decides is still decided here; only the
    // rasterization is gone. That is what lets the end-to-end suite run on
    // a machine with no GPU (CI, a container, a software rasterizer) where
    // the fragment shader is expensive enough to starve the event loop.
    // ---------------------------------------------------------------------
    var stripEl = null;
    var stripCards = [];
    var stripDetail = null;
    var stripPhase = -1;

    function buildPhaseStrip() {
        stripEl = document.getElementById('phase-strip');
        if (!stripEl) return;

        // The strip is display:none in CSS: it only exists in 'phases'
        // mode, and the canvas is hidden in the same breath.
        stripEl.style.display = 'flex';

        var cards = '';
        for (var i = 0; i < PHASES.length; i++) {
            var p = PHASES[i];
            cards += '<div class="phase-card" data-phase-order="' + p.order + '"' +
                     ' data-phase="' + p.english.toLowerCase() + '">' +
                     '<div class="phase-order">' + p.order + '</div>' +
                     '<div class="phase-name">' + p.name + '</div>' +
                     '<div class="phase-english">' + p.english + '</div>' +
                     '<div class="phase-type">' + p.type + '</div>' +
                     '</div>';
        }
        stripEl.innerHTML = '<div class="phase-cards">' + cards + '</div>' +
            '<div class="phase-detail" id="phase-detail"></div>';

        stripCards = stripEl.querySelectorAll('.phase-card');
        stripDetail = document.getElementById('phase-detail');
    }

    function renderPhaseStrip(index) {
        if (!stripEl || index === stripPhase) return;
        stripPhase = index;

        for (var i = 0; i < stripCards.length; i++) {
            if (i === index) stripCards[i].classList.add('active');
            else stripCards[i].classList.remove('active');
        }

        var p = PHASES[index];
        stripEl.setAttribute('data-phase', p.english.toLowerCase());
        stripEl.setAttribute('data-phase-order', String(p.order));
        if (stripDetail) {
            stripDetail.innerHTML =
                '<span class="phase-detail-role">' + p.role + '</span>' +
                '<span class="phase-detail-segments">' + p.segments + '</span>' +
                '<span class="phase-detail-action">' + p.action + '</span>';
        }
    }

    // Which renderer the page should use. 'webgl' is the real scene;
    // 'phases' is the shader-free stand-in used by the test build.
    function renderMode() {
        if (typeof XESYNC_CONFIG !== 'undefined' && XESYNC_CONFIG.renderMode) {
            return XESYNC_CONFIG.renderMode;
        }
        return 'webgl';
    }

    function initPhases() {
        var canvas = document.getElementById('glCanvas');
        if (canvas) canvas.style.display = 'none';

        buildPhaseStrip();

        t0 = performance.now() / 1000;
        lastT = t0;
        flow = 0;
        animPhase = 0;
        driveFraction = DRIVE_FRACTION;
        displaySurge = 1.0;
        tracker.reset();
        currentSpeed = 0;
        currentSpm = 0;
        shaderReadySent = false;
        loadingEl = document.getElementById('gl-loading');

        framePhases();
    }

    function framePhases() {
        var now = performance.now() / 1000;
        var dt = now - lastT;
        lastT = now;

        var targetSurge = currentSpm > 0 ? surgeFactor(animPhase) : 1.0;
        displaySurge += (targetSurge - displaySurge) * Math.min(1.0, dt * SURGE_SLEW_RATE);
        flow -= dt * currentSpeed * 0.26 * displaySurge;
        if (flow < -FLOW_WRAP) flow += FLOW_WRAP;
        if (flow >  FLOW_WRAP) flow -= FLOW_WRAP;

        animPhase = tracker.advance(animPhase, dt, now, currentSpm);
        driveFraction += (driveFractionForSpm(currentSpm) - driveFraction) *
            Math.min(1.0, dt * DRIVE_EASE_RATE);

        renderPhaseStrip(phaseAt(toRenderPhase(animPhase, driveFraction)));

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

        rafId = requestAnimationFrame(framePhases);
    }

    function initRowing() {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }

        if (renderMode() === 'phases') {
            initPhases();
            return;
        }

        var canvas = document.getElementById('glCanvas');
        gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        koiCanvasEl = document.getElementById('koiCanvas');
        koiCtx = koiCanvasEl ? koiCanvasEl.getContext('2d') : null;
        sceneryCanvasEl = document.getElementById('sceneryCanvas');
        sceneryCtx = sceneryCanvasEl ? sceneryCanvasEl.getContext('2d') : null;
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
            uDay:    gl.getUniformLocation(prog, 'u_day'),
            uSpeed:  gl.getUniformLocation(prog, 'u_speed'),
            uChain:  gl.getUniformLocation(prog, 'u_chain'),
            uSharp:  gl.getUniformLocation(prog, 'u_sharp'),
            uFlow:   gl.getUniformLocation(prog, 'u_flow'),
            uPhase:  gl.getUniformLocation(prog, 'u_phase'),
            uSpm:    gl.getUniformLocation(prog, 'u_spm'),
            uScale:  gl.getUniformLocation(prog, 'u_scale'),
            uAspect: gl.getUniformLocation(prog, 'u_aspect'),
            uGhostX:     gl.getUniformLocation(prog, 'u_ghostX'),
            uGhostPhase: gl.getUniformLocation(prog, 'u_ghostPhase'),
            uGhostOn:    gl.getUniformLocation(prog, 'u_ghostOn'),
            uHullA:      gl.getUniformLocation(prog, 'u_hullA'),
            uHullB:      gl.getUniformLocation(prog, 'u_hullB'),
            uShirt:      gl.getUniformLocation(prog, 'u_shirt'),
            uShorts:     gl.getUniformLocation(prog, 'u_shorts'),
            uCap:        gl.getUniformLocation(prog, 'u_cap'),
            uTint:       gl.getUniformLocation(prog, 'u_tint'),
            uLivery:     gl.getUniformLocation(prog, 'u_livery'),
            uRidgeFar:   gl.getUniformLocation(prog, 'u_ridgeFar'),
            uRidgeNear:  gl.getUniformLocation(prog, 'u_ridgeNear'),
            uTree:       gl.getUniformLocation(prog, 'u_tree'),
            uTreeDensity: gl.getUniformLocation(prog, 'u_treeDensity')
        };

        // The scene never waits to be dressed: it shows the boat as it
        // always was, and changes when the history says so.
        dressScene();

        t0 = performance.now() / 1000;
        lastT = t0;
        sceneClock = 0;
        flow = 0;
        animPhase = 0;
        driveFraction = DRIVE_FRACTION;
        displaySurge = 1.0;
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
        setConsoleSpeedAndSpm: function(speed, spm, distance, elapsedSeconds) {
            if (typeof distance === 'number' && isFinite(distance)) currentDistance = distance;
            if (typeof elapsedSeconds === 'number' && isFinite(elapsedSeconds)) sessionElapsed = elapsedSeconds;
            currentSpeed = Math.min(speed / SPEED_NORMALIZE, 1.0);
            currentSpm = spm;
        },
        // `count` strokes were just counted by the rower; `gapS` is the time
        // since the packet before. Call after setConsoleSpeedAndSpm, so the
        // spm it is paired with is the one reported alongside the stroke.
        noteStroke: function(count, gapS) {
            tracker.stroke(performance.now() / 1000, count, gapS, currentSpm);
        },
        // The chain level, 0..1. Called by controller.js on every packet,
        // from the game layer's state (run_score.js).
        setChainLevel: function(level) {
            chainLevel = (typeof level === 'number' && isFinite(level))
                ? clamp01(level)
                : 0;
        },
        // A tier up: a short surge of the boat.
        pulseChain: function() {
            chainPulse = 1;
        },
        // The ghost of the best run. The profile comes from ghost.js,
        // built from the samples the server already has.
        setGhostProfile: function(profile) {
            ghostProfile = profile || null;
            ghostOn = 0;
            ghostOffset = 0;
        },
        // The koi. The game layer says whether it is there and how
        // close it is to being landed; the scene swims it, and says
        // nothing. A koi that was landed swims away; a koi that dived
        // is simply gone.
        setFish: function(st) {
            var present = !!(st && st.present);
            var landed = !!(st && st.landed);
            fishHold = (st && typeof st.hold === 'number' && isFinite(st.hold))
                ? clamp01(st.hold)
                : 0;
            if (present) {
                if (!fishOn) fishX = fishStation();
                fishOn = 1;
                fishExit = 0;
            } else if (fishOn) {
                fishOn = 0;
                if (landed && !fishLandedSeen) fishExit = FISH_EXIT_S;
            }
            fishLandedSeen = landed;
        },
        // The day's conditions: the index the shader uses to pick the
        // weather. The day's own index, so the sky is the same for
        // everyone rowing at this hour.
        setSceneDay: function(index) {
            dayBase = (typeof index === 'number' && isFinite(index))
                ? Math.floor(index)
                : 0;
        },
        // The dressing. The outfit comes from costume.js: the livery of
        // the boat, the kit of the rower, and the theme of the hour.
        // When the livery is a different one from the one the scene was
        // already wearing, a sweep of light runs along the hull - the
        // only announcement the game makes by itself.
        setCostume: function(outfit) {
            if (!outfit || !outfit.livery || !outfit.theme) return;
            var wasKey = costumeKey;
            costume = outfit;
            costumeKey = outfit.livery.key;
            if (wasKey !== null && wasKey !== costumeKey) {
                liverySweepT = 1;
                liverySweep = 1;
            }
        },
        // Exposed for tests: the scene's half of the game layer, so a
        // test can check that the chain really reaches the renderer.
        _internals: {
            chainLevel: function () { return chainLevel; },
            chainPulse: function () { return chainPulse; },
            sceneClock: function () { return sceneClock; },
            dayBase: function () { return dayBase; },
            ghostOn: function () { return ghostOn; },
            ghostOffset: function () { return ghostOffset; },
            ghostPhase: function () { return ghostPhase; },
            ghostProfile: function () { return ghostProfile; },
            fishOn: function () { return fishOn; },
            fishX: function () { return fishX; },
            fishHold: function () { return fishHold; },
            fishFade: function () { return fishFade; },
            fishExit: function () { return fishExit; },
            FISH_X: FISH_X,
            costume: function () { return costume; },
            costumeKey: function () { return costumeKey; },
            liverySweep: function () { return liverySweep; },
            updateGhost: updateGhost,
            sessionElapsed: function () { return sessionElapsed; },
            currentDistance: function () { return currentDistance; },
            CHAIN_TIME_SCALE: CHAIN_TIME_SCALE,
            CHAIN_SCROLL_SCALE: CHAIN_SCROLL_SCALE,
            PULSE_S: PULSE_S,
            PULSE_SCALE: PULSE_SCALE
        },
        // Exposed for tests/rowing_sync.test.js.
        createPhaseTracker: createPhaseTracker,
        toRenderPhase: toRenderPhase,
        surgeFactor: surgeFactor,
        driveFractionForSpm: driveFractionForSpm,
        FINISH_PHASE: FINISH_PHASE,
        // The four phases of the stroke, and which one a pose track
        // position falls in. Exposed for tests/rowing_phases.test.js.
        PHASES: PHASES,
        phaseAt: phaseAt,
        PHASE_CATCH: PHASE_CATCH,
        PHASE_DRIVE: PHASE_DRIVE,
        PHASE_FINISH: PHASE_FINISH,
        PHASE_RECOVERY: PHASE_RECOVERY,
        FINISH_RENDER_PHASE: FINISH_RENDER_PHASE,
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
var setChainLevel = RowingAnimation.setChainLevel;
var pulseChain = RowingAnimation.pulseChain;
var setSceneDay = RowingAnimation.setSceneDay;
var setGhostProfile = RowingAnimation.setGhostProfile;
var setCostume = RowingAnimation.setCostume;
var setFish = RowingAnimation.setFish;