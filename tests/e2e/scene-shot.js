'use strict';
// =====================================================================
// scene-shot.js - render the rowing scene without a GPU.
//
// The scene's fragment shader is the only part of the app that cannot be
// exercised on a machine without a GPU: drawn full-screen in software, it
// starves the event loop and the page stops answering Playwright. That is
// why the end-to-end build runs the shader-free 'phases' renderer.
//
// This script is the compromise: it compiles the REAL GLSL from
// rowing_display.html in a headless browser, draws the scene a few times at
// a fixed size with hand-set uniforms, and saves the pictures. It is how
// the "without chain / with chain / with the tier-up swell" comparison in
// docs/GAMIFICATION.md was made - the uniforms are set by hand, so these
// are stills of the shader, not screenshots of the running app.
//
//   node tests/e2e/scene-shot.js
//
// Writes: docs/images/scene-calm.png, scene-chain.png, scene-surge.png,
//         scene-compare.png (the three side by side, zoomed on the boat)
// =====================================================================

const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'images');

function readShaders() {
  const html = fs.readFileSync(path.join(ROOT, 'rowing_display.html'), 'utf8');
  return {
    vs: html.match(/<script id="vs"[^>]*>([\s\S]*?)<\/script>/)[1],
    fs: html.match(/<script id="fs"[^>]*>([\s\S]*?)<\/script>/)[1]
  };
}

// The same uniforms the renderer sends, with the chain at 0, at 1, and at
// 1 with the tier-up swell applied.
// The club livery, the colours the boat had before the dressing.
const CLUB = {
  hullA: [0.75, 0.92, 0.70], hullB: [0.30, 0.50, 0.30],
  shirt: [0.85, 0.20, 0.15], shorts: [0.15, 0.15, 0.18], cap: [0.10, 0.25, 0.55]
};
// The racing stripe, the livery five sessions earn.
const STRIPE = {
  hullA: [0.95, 0.95, 0.93], hullB: [0.16, 0.32, 0.62],
  shirt: [0.16, 0.32, 0.62], shorts: [0.93, 0.93, 0.90], cap: [0.93, 0.93, 0.90]
};
// The land, the way the scene has always drawn it.
const CONIFERS = {
  ridgeFar: [0.78, 0.55, 0.65], ridgeNear: [0.22, 0.18, 0.30], tree: [0.19, 0.16, 0.28]
};
// The autumn, the biome fifteen sessions earn.
const AUTUMN = {
  ridgeFar: [0.88, 0.64, 0.40], ridgeNear: [0.30, 0.18, 0.20], tree: [0.34, 0.19, 0.13],
  density: 0.28
};
// The snow, the biome forty sessions earn: a thinner forest.
const SNOW = {
  ridgeFar: [0.84, 0.88, 0.96], ridgeNear: [0.24, 0.29, 0.38], tree: [0.11, 0.16, 0.24],
  density: 0.58
};

const SHOTS = [
  { name: 'calm', chain: 0.0, pulse: 0, ghost: 0.0, ghostX: 0.0 },
  { name: 'chain', chain: 1.0, pulse: 0, ghost: 0.0, ghostX: 0.0 },
  { name: 'surge', chain: 1.0, pulse: 1, ghost: 0.0, ghostX: 0.0 },
  // The ghost of your best run, a little ahead on the same water.
  { name: 'ghost', chain: 0.4, pulse: 0, ghost: 1.0, ghostX: 0.12 },
  // The boat in the racing stripe, under the warm theme of an afternoon.
  { name: 'livery', chain: 0.4, pulse: 0, ghost: 0.0, ghostX: 0.0,
    livery: STRIPE, tint: [1.07, 0.99, 0.90] },
  // The land in the autumn, with the chain up: the ridge breathes.
  { name: 'biome', chain: 1.0, pulse: 0, ghost: 0.0, ghostX: 0.0, biome: AUTUMN },
  // And in the snow, where the forest is thinner.
  { name: 'snow', chain: 0.2, pulse: 0, ghost: 0.0, ghostX: 0.0, biome: SNOW }
];

(async () => {
  const shaders = readShaders();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 520, height: 330 } });
  await page.goto('about:blank');

  const pngs = await page.evaluate(async ({ vs, fs, shots }) => {
    const W = 520, H = 330;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('no webgl context');

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh));
      }
      return sh;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const u = (n) => gl.getUniformLocation(prog, n);

    function shot(chain, pulse, ghost, ghostX, livery, tint, biome) {
      gl.viewport(0, 0, W, H);
      gl.uniform1f(u('u_time'), 96.0);
      gl.uniform1f(u('u_day'), 3.0);
      gl.uniform1f(u('u_speed'), 0.62);
      gl.uniform1f(u('u_flow'), 140.0);
      gl.uniform1f(u('u_phase'), 0.18);
      gl.uniform1f(u('u_spm'), 25.0);
      gl.uniform1f(u('u_scale'), 0.6 * (1 + 0.12 * pulse));
      gl.uniform1f(u('u_aspect'), W / H);
      gl.uniform1f(u('u_chain'), chain);
      // The peaks follow the chain, exactly as the renderer sends them.
      gl.uniform1f(u('u_sharp'), chain * 0.75);
      gl.uniform1f(u('u_ghostX'), ghostX);
      gl.uniform1f(u('u_ghostPhase'), 0.08);
      gl.uniform1f(u('u_ghostOn'), ghost);
      // The dressing: the livery and the theme, the same values the
      // scene sends.
      const lv = livery || shots[0].livery || {
        hullA: [0.75, 0.92, 0.70], hullB: [0.30, 0.50, 0.30],
        shirt: [0.85, 0.20, 0.15], shorts: [0.15, 0.15, 0.18], cap: [0.10, 0.25, 0.55]
      };
      const th = tint || [1, 1, 1];
      const bm = biome || { ridgeFar: [0.78, 0.55, 0.65], ridgeNear: [0.22, 0.18, 0.30],
                             tree: [0.19, 0.16, 0.28], density: 0.30 };
      gl.uniform3f(u('u_hullA'), lv.hullA[0], lv.hullA[1], lv.hullA[2]);
      gl.uniform3f(u('u_hullB'), lv.hullB[0], lv.hullB[1], lv.hullB[2]);
      gl.uniform3f(u('u_shirt'), lv.shirt[0], lv.shirt[1], lv.shirt[2]);
      gl.uniform3f(u('u_shorts'), lv.shorts[0], lv.shorts[1], lv.shorts[2]);
      gl.uniform3f(u('u_cap'), lv.cap[0], lv.cap[1], lv.cap[2]);
      gl.uniform3f(u('u_tint'), th[0], th[1], th[2]);
      gl.uniform1f(u('u_livery'), 0);
      gl.uniform3f(u('u_ridgeFar'), bm.ridgeFar[0], bm.ridgeFar[1], bm.ridgeFar[2]);
      gl.uniform3f(u('u_ridgeNear'), bm.ridgeNear[0], bm.ridgeNear[1], bm.ridgeNear[2]);
      gl.uniform1f(u('u_treeDensity'), 0.30);
      gl.uniform3f(u('u_tree'), bm.tree[0], bm.tree[1], bm.tree[2]);
      gl.uniform1f(u('u_treeDensity'), typeof bm.density === 'number' ? bm.density : 0.30);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return canvas.toDataURL('image/png');
    }

    const out = {};
    for (const s of shots) {
      out[s.name] = shot(s.chain, s.pulse, s.ghost, s.ghostX, s.livery, s.tint, s.biome);
    }

    // The three side by side, zoomed on the boat and its wake - that is
    // where the chain shows.
    const CROP = { x: 215, y: 195, w: 140, h: 80 }, ZOOM = 2, PAD = 10;
    const sheet = document.createElement('canvas');
    sheet.width = (CROP.w * ZOOM) * shots.length + PAD * (shots.length + 1);
    sheet.height = CROP.h * ZOOM + PAD * 2;
    const ctx = sheet.getContext('2d');
    ctx.fillStyle = '#0e1016';
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    const labels = ['sans chaine', 'chaine', 'chaine + pulsation', 'fantome', 'livree',
                    ' biome', 'neiges'];
    ctx.fillStyle = '#d2d7e6';
    ctx.font = '13px sans-serif';
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('image load failed'));
        im.src = out[s.name];
      });
      const x = PAD + i * (CROP.w * ZOOM + PAD);
      ctx.drawImage(img, CROP.x, CROP.y, CROP.w, CROP.h, x, PAD, CROP.w * ZOOM, CROP.h * ZOOM);
      ctx.fillText(labels[i], x, 12);
    }
    out.compare = sheet.toDataURL('image/png');

    // And the same for the shape of the range: the hills alone, rounded
    // and angular, side by side. That is the part of the scene the
    // chain changes the shape of.
    const PEAKS = { x: 30, y: 55, w: 230, h: 105 }, PZOOM = 1.6;
    const peakNames = ['calm', 'chain'];
    const peakLabels = ['collines rondes', 'pics anguleux'];
    const psheet = document.createElement('canvas');
    psheet.width = (PEAKS.w * PZOOM) * peakNames.length + PAD * (peakNames.length + 1);
    psheet.height = PEAKS.h * PZOOM + PAD * 2;
    const pctx = psheet.getContext('2d');
    pctx.fillStyle = '#0e1016';
    pctx.fillRect(0, 0, psheet.width, psheet.height);
    pctx.fillStyle = '#d2d7e6';
    pctx.font = '13px sans-serif';
    for (let i = 0; i < peakNames.length; i++) {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('image load failed'));
        im.src = out[peakNames[i]];
      });
      const x = PAD + i * (PEAKS.w * PZOOM + PAD);
      pctx.drawImage(img, PEAKS.x, PEAKS.y, PEAKS.w, PEAKS.h,
        x, PAD, PEAKS.w * PZOOM, PEAKS.h * PZOOM);
      pctx.fillText(peakLabels[i], x, 12);
    }
    out.peaks = psheet.toDataURL('image/png');
    return out;
  }, { vs: shaders.vs, fs: shaders.fs, shots: SHOTS });

  fs.mkdirSync(OUT, { recursive: true });
  for (const s of SHOTS) {
    const file = path.join(OUT, `scene-${s.name}.png`);
    fs.writeFileSync(file, Buffer.from(pngs[s.name].split(',')[1], 'base64'));
    console.log('écrit', path.relative(ROOT, file));
  }
  const compare = path.join(OUT, 'scene-compare.png');
  fs.writeFileSync(compare, Buffer.from(pngs.compare.split(',')[1], 'base64'));
  console.log('écrit', path.relative(ROOT, compare));
  const peaks = path.join(OUT, 'scene-peaks.png');
  fs.writeFileSync(peaks, Buffer.from(pngs.peaks.split(',')[1], 'base64'));
  console.log('écrit', path.relative(ROOT, peaks));
  await browser.close();
})();
