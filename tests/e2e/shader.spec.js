// =====================================================================
// shader.spec.js - the rowing scene's GLSL compiles, and knows about the
// chain.
//
// The scene is a ~900-line fragment shader. When the game layer was added
// to it (the u_chain uniform), the only way to be sure the GLSL still
// compiles and links is to compile it - a shader that does not compile
// gives a black screen and nothing else.
//
// Compiling is fast; drawing is not. This test compiles and links the
// shaders exactly as rowing_display.js does, then checks that u_chain is
// an active uniform (an unused uniform gets optimised away, and the scene
// would silently ignore the chain).
//
//   npx playwright test --project=client tests/e2e/shader.spec.js
// =====================================================================

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// The shaders live in rowing_display.html, in <script id="vs"> and
// <script id="fs"> blocks - the same source initRowing() compiles.
function readShaders() {
  const html = fs.readFileSync(path.join(ROOT, 'rowing_display.html'), 'utf8');
  const vs = html.match(/<script id="vs"[^>]*>([\s\S]*?)<\/script>/);
  const fs_ = html.match(/<script id="fs"[^>]*>([\s\S]*?)<\/script>/);
  if (!vs || !fs_) throw new Error('could not find the vs/fs shader blocks');
  return { vs: vs[1], fs: fs_[1] };
}

// The dressing's uniforms. A WebGL uniform starts at zero, and the
// theme's grade multiplies the whole frame: a draw that leaves them
// alone produces a black picture, and nothing would ever differ in it.
// Every draw below dresses the boat the same way, so the only thing
// that differs between two frames is the thing under test.

test('the scene shader compiles, links and carries the chain uniform', async ({ page }) => {
  const shaders = readShaders();

  await page.goto('about:blank');
  const result = await page.evaluate(({ vs, fs }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const gl = canvas.getContext('webgl');
    if (!gl) return { error: 'no webgl context' };

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        return { error: gl.getShaderInfoLog(sh) };
      }
      return { shader: sh };
    }

    const v = compile(gl.VERTEX_SHADER, vs);
    if (v.error) return { error: 'vertex shader: ' + v.error };
    const f = compile(gl.FRAGMENT_SHADER, fs);
    if (f.error) return { error: 'fragment shader: ' + f.error };

    const prog = gl.createProgram();
    gl.attachShader(prog, v.shader);
    gl.attachShader(prog, f.shader);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      return { error: 'link: ' + gl.getProgramInfoLog(prog) };
    }
    gl.useProgram(prog);

    const uniforms = [];
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) uniforms.push(gl.getActiveUniform(prog, i).name);

    // The chain has to be settable: an optimised-away uniform would make
    // the scene ignore it without a word.
    const loc = gl.getUniformLocation(prog, 'u_chain');
    if (loc) gl.uniform1f(loc, 0.5);

    return { uniforms: uniforms, chainSettable: !!loc };
  }, shaders);

  expect(result.error).toBeUndefined();
  expect(result.uniforms).toContain('u_chain');
  expect(result.chainSettable).toBe(true);
  // The uniforms the scene has always used must still be there.
  for (const u of ['u_time', 'u_day', 'u_speed', 'u_flow', 'u_phase', 'u_spm', 'u_scale', 'u_aspect']) {
    expect(result.uniforms).toContain(u);
  }
  // The ghost's uniforms, same rule: an unused one would be optimised
  // away and the ghost would never be drawn.
  for (const u of ['u_ghostX', 'u_ghostPhase', 'u_ghostOn']) {
    expect(result.uniforms).toContain(u);
  }
  // The dressing: the livery's colours, the theme's grade, and the
  // sweep of light along the hull.
  for (const u of ['u_hullA', 'u_hullB', 'u_shirt', 'u_shorts', 'u_cap',
                   'u_tint', 'u_livery']) {
    expect(result.uniforms).toContain(u);
  }
});

// The ghost is drawn on the water. Same method as the chain: the scene
// is drawn twice, identical except for the ghost, and the pixels are
// compared.
test('the ghost changes what the scene looks like', async ({ page }) => {
  const shaders = readShaders();

  await page.goto('about:blank');
  const diff = await page.evaluate(({ vs, fs }) => {
    const W = 480, H = 300;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return { error: 'no webgl context' };

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        return { error: gl.getShaderInfoLog(sh) };
      }
      return { shader: sh };
    }
    const v = compile(gl.VERTEX_SHADER, vs);
    if (v.error) return { error: v.error };
    const f = compile(gl.FRAGMENT_SHADER, fs);
    if (f.error) return { error: f.error };

    const prog = gl.createProgram();
    gl.attachShader(prog, v.shader);
    gl.attachShader(prog, f.shader);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      return { error: gl.getProgramInfoLog(prog) };
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const u = (n) => gl.getUniformLocation(prog, n);
    const pixels = new Uint8Array(W * H * 4);

    function draw(ghostOn, ghostX) {
      gl.viewport(0, 0, W, H);
      gl.uniform1f(u('u_time'), 96.0);
      gl.uniform1f(u('u_day'), 3.0);
      gl.uniform1f(u('u_speed'), 0.62);
      gl.uniform1f(u('u_flow'), 140.0);
      gl.uniform1f(u('u_phase'), 0.18);
      gl.uniform1f(u('u_spm'), 25.0);
      gl.uniform1f(u('u_scale'), 0.6);
      gl.uniform1f(u('u_aspect'), W / H);
      gl.uniform1f(u('u_chain'), 0.0);
      gl.uniform1f(u('u_ghostX'), ghostX);
      gl.uniform1f(u('u_ghostPhase'), 0.25);
      gl.uniform1f(u('u_ghostOn'), ghostOn);
      gl.uniform3f(u('u_hullA'), 0.75, 0.92, 0.70);
      gl.uniform3f(u('u_hullB'), 0.30, 0.50, 0.30);
      gl.uniform3f(u('u_shirt'), 0.85, 0.20, 0.15);
      gl.uniform3f(u('u_shorts'), 0.15, 0.15, 0.18);
      gl.uniform3f(u('u_cap'), 0.10, 0.25, 0.55);
      gl.uniform3f(u('u_tint'), 1, 1, 1);
      gl.uniform1f(u('u_livery'), 0);
      gl.uniform3f(u('u_ridgeFar'), 0.78, 0.55, 0.65);
      gl.uniform3f(u('u_ridgeNear'), 0.22, 0.18, 0.30);
      gl.uniform1f(u('u_treeDensity'), 0.30);
      gl.uniform3f(u('u_tree'), 0.19, 0.16, 0.28);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels.slice();
    }

    const without = draw(0.0, 0.0);
    const withGhost = draw(1.0, 0.12);

    let changed = 0, maxDelta = 0;
    for (let i = 0; i < without.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) {
        const dd = Math.abs(without[i + c] - withGhost[i + c]);
        if (dd > d) d = dd;
      }
      if (d > 2) changed++;
      if (d > maxDelta) maxDelta = d;
    }
    return { changed, total: without.length / 4, maxDelta };
  }, shaders);

  expect(diff.error).toBeUndefined();
  expect(diff.changed).toBeGreaterThan(diff.total * 0.002);
  expect(diff.maxDelta).toBeGreaterThan(4);
});

// The land has to answer the chain too. The water already does; the
// ridge is what carries the ambiance, and a ridge that never moves is
// a wallpaper.
//
// Same method again: the same scene twice, identical in every respect
// but u_chain, and the pixels of the LAND (the top half of the frame)
// are compared. If the hills did not breathe, nothing up there would
// move.
// Draws the land twice, with the uniforms of each draw given, and
// reports how many pixels of the top half moved. The chain and the
// sharpness are the only things that can differ.
async function landDiff(page, shaders, a, b) {
  return page.evaluate(({ vs, fs, a, b }) => {
    const W = 480, H = 300;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return { error: 'no webgl context' };

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        return { error: gl.getShaderInfoLog(sh) };
      }
      return { shader: sh };
    }
    const v = compile(gl.VERTEX_SHADER, vs);
    if (v.error) return { error: v.error };
    const f = compile(gl.FRAGMENT_SHADER, fs);
    if (f.error) return { error: f.error };

    const prog = gl.createProgram();
    gl.attachShader(prog, v.shader);
    gl.attachShader(prog, f.shader);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      return { error: gl.getProgramInfoLog(prog) };
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const u = (n) => gl.getUniformLocation(prog, n);
    const pixels = new Uint8Array(W * H * 4);

    function draw(o) {
      gl.viewport(0, 0, W, H);
      gl.uniform1f(u('u_time'), 42.0);
      gl.uniform1f(u('u_day'), 3.0);
      gl.uniform1f(u('u_speed'), 0.6);
      gl.uniform1f(u('u_flow'), 120.0);
      gl.uniform1f(u('u_phase'), 0.2);
      gl.uniform1f(u('u_spm'), 24.0);
      gl.uniform1f(u('u_scale'), 0.6);
      gl.uniform1f(u('u_aspect'), W / H);
      gl.uniform1f(u('u_chain'), o.chain || 0);
      gl.uniform1f(u('u_sharp'), o.sharp || 0);
      gl.uniform3f(u('u_hullA'), 0.75, 0.92, 0.70);
      gl.uniform3f(u('u_hullB'), 0.30, 0.50, 0.30);
      gl.uniform3f(u('u_shirt'), 0.85, 0.20, 0.15);
      gl.uniform3f(u('u_shorts'), 0.15, 0.15, 0.18);
      gl.uniform3f(u('u_cap'), 0.10, 0.25, 0.55);
      gl.uniform3f(u('u_tint'), 1, 1, 1);
      gl.uniform1f(u('u_livery'), 0);
      gl.uniform3f(u('u_ridgeFar'), 0.78, 0.55, 0.65);
      gl.uniform3f(u('u_ridgeNear'), 0.22, 0.18, 0.30);
      gl.uniform1f(u('u_treeDensity'), 0.30);
      gl.uniform3f(u('u_tree'), 0.19, 0.16, 0.28);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels.slice();
    }

    const calm = draw(a);
    const chained = draw(b);

    // Only the top half: that is the sky and the land. The boat and
    // the water are the lower half, and they answer the chain already.
    let changed = 0, total = 0, maxDelta = 0;
    for (let y = Math.floor(H / 2); y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        let d = 0;
        for (let c = 0; c < 4; c++) {
          const dd = Math.abs(calm[i + c] - chained[i + c]);
          if (dd > d) d = dd;
        }
        total++;
        if (d > 2) changed++;
        if (d > maxDelta) maxDelta = d;
      }
    }
    return { changed, total, maxDelta };
  }, { vs: shaders.vs, fs: shaders.fs, a, b });
}

test('the land answers the chain', async ({ page }) => {
  const shaders = readShaders();

  await page.goto('about:blank');
  const diff = await landDiff(page, shaders, { chain: 0 }, { chain: 1 });

  expect(diff.error).toBeUndefined();
  // The ridge's edge moves: a band of pixels along the hills, not the
  // whole sky.
  expect(diff.changed).toBeGreaterThan(diff.total * 0.005);
  expect(diff.maxDelta).toBeGreaterThan(8);
});

// The shape of the range, not only its size. The two draws below are
// identical but for u_sharp: the chain is down in both, so the hills
// breathe exactly the same. If the pixels move, the peaks have taken
// angles - and nothing else could have moved them.
test('the peaks sharpen when the rower is pushing', async ({ page }) => {
  const shaders = readShaders();

  await page.goto('about:blank');
  const diff = await landDiff(page, shaders,
    { chain: 0, sharp: 0 },
    { chain: 0, sharp: 1 });

  expect(diff.error).toBeUndefined();
  // A ridge's edge moves along the hills: a band of pixels, not the
  // whole sky.
  expect(diff.changed).toBeGreaterThan(diff.total * 0.005);
  expect(diff.maxDelta).toBeGreaterThan(8);
});

// The chain has to be VISIBLE, not just present. The same scene is drawn
// twice - identical in every respect but u_chain - and the pixels are
// compared. If they are the same, the chain is in the shader but does
// nothing, and the whole point of the game layer is lost.
test('the chain changes what the scene looks like', async ({ page }) => {
  const shaders = readShaders();

  await page.goto('about:blank');
  const diff = await page.evaluate(({ vs, fs }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 160;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return { error: 'no webgl context' };

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        return { error: gl.getShaderInfoLog(sh) };
      }
      return { shader: sh };
    }
    const v = compile(gl.VERTEX_SHADER, vs);
    if (v.error) return { error: v.error };
    const f = compile(gl.FRAGMENT_SHADER, fs);
    if (f.error) return { error: f.error };

    const prog = gl.createProgram();
    gl.attachShader(prog, v.shader);
    gl.attachShader(prog, f.shader);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      return { error: gl.getProgramInfoLog(prog) };
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const u = (n) => gl.getUniformLocation(prog, n);
    const W = canvas.width, H = canvas.height;
    const pixels = new Uint8Array(W * H * 4);

    // Everything identical in both passes except the chain.
    function draw(chain) {
      gl.viewport(0, 0, W, H);
      gl.uniform1f(u('u_time'), 42.0);
      gl.uniform1f(u('u_day'), 3.0);
      gl.uniform1f(u('u_speed'), 0.6);
      gl.uniform1f(u('u_flow'), 120.0);
      gl.uniform1f(u('u_phase'), 0.2);
      gl.uniform1f(u('u_spm'), 24.0);
      gl.uniform1f(u('u_scale'), 0.6);
      gl.uniform1f(u('u_aspect'), W / H);
      gl.uniform1f(u('u_chain'), chain);
      gl.uniform3f(u('u_hullA'), 0.75, 0.92, 0.70);
      gl.uniform3f(u('u_hullB'), 0.30, 0.50, 0.30);
      gl.uniform3f(u('u_shirt'), 0.85, 0.20, 0.15);
      gl.uniform3f(u('u_shorts'), 0.15, 0.15, 0.18);
      gl.uniform3f(u('u_cap'), 0.10, 0.25, 0.55);
      gl.uniform3f(u('u_tint'), 1, 1, 1);
      gl.uniform1f(u('u_livery'), 0);
      gl.uniform3f(u('u_ridgeFar'), 0.78, 0.55, 0.65);
      gl.uniform3f(u('u_ridgeNear'), 0.22, 0.18, 0.30);
      gl.uniform1f(u('u_treeDensity'), 0.30);
      gl.uniform3f(u('u_tree'), 0.19, 0.16, 0.28);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels.slice();
    }

    const withoutChain = draw(0.0);
    const withChain = draw(1.0);

    // Count pixels, not bytes: a pixel differs when any of its channels
    // moves by more than a rounding difference.
    let changedPixels = 0;
    let maxDelta = 0;
    for (let i = 0; i < withoutChain.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) {
        const dd = Math.abs(withoutChain[i + c] - withChain[i + c]);
        if (dd > d) d = dd;
      }
      if (d > 2) changedPixels++;
      if (d > maxDelta) maxDelta = d;
    }
    return { changed: changedPixels, total: withoutChain.length / 4, maxDelta: maxDelta };
  }, shaders);

  expect(diff.error).toBeUndefined();
  // The chain has to move real pixels, and move them by more than a
  // rounding difference. The trace is a thin band near the boat, so the
  // share of the frame it covers is small by nature - what matters is
  // that it is there and that it is not noise.
  expect(diff.changed).toBeGreaterThan(diff.total * 0.003);
  expect(diff.maxDelta).toBeGreaterThan(4);
});

// The dressing has to be VISIBLE. The same scene is drawn twice -
// identical in every respect but the livery - and the pixels are
// compared. A livery that changes nothing is not a livery.
test('the livery changes what the scene looks like', async ({ page }) => {
  // Four full frames are drawn and compared: on a machine without a
  // GPU the rasteriser is the slow part, not the test.
  test.setTimeout(90000);
  const shaders = readShaders();

  await page.goto('about:blank');
  const diff = await page.evaluate(({ vs, fs }) => {
    const W = 480, H = 300;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return { error: 'no webgl context' };

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        return { error: gl.getShaderInfoLog(sh) };
      }
      return { shader: sh };
    }
    const v = compile(gl.VERTEX_SHADER, vs);
    if (v.error) return { error: v.error };
    const f = compile(gl.FRAGMENT_SHADER, fs);
    if (f.error) return { error: f.error };

    const prog = gl.createProgram();
    gl.attachShader(prog, v.shader);
    gl.attachShader(prog, f.shader);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      return { error: gl.getProgramInfoLog(prog) };
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const u = (n) => gl.getUniformLocation(prog, n);
    const pixels = new Uint8Array(W * H * 4);

    const CLUB = {
      hullA: [0.75, 0.92, 0.70], hullB: [0.30, 0.50, 0.30],
      shirt: [0.85, 0.20, 0.15], shorts: [0.15, 0.15, 0.18], cap: [0.10, 0.25, 0.55]
    };
    const STRIPE = {
      hullA: [0.95, 0.95, 0.93], hullB: [0.16, 0.32, 0.62],
      shirt: [0.16, 0.32, 0.62], shorts: [0.93, 0.93, 0.90], cap: [0.93, 0.93, 0.90]
    };
    const CONIFERS = {
      ridgeFar: [0.78, 0.55, 0.65], ridgeNear: [0.22, 0.18, 0.30], tree: [0.19, 0.16, 0.28]
    };
    const AUTUMN = {
      ridgeFar: [0.88, 0.64, 0.40], ridgeNear: [0.30, 0.18, 0.20], tree: [0.34, 0.19, 0.13]
    };

    function draw(livery, tint, sweep, biome) {
      gl.viewport(0, 0, W, H);
      gl.uniform1f(u('u_time'), 96.0);
      gl.uniform1f(u('u_day'), 3.0);
      gl.uniform1f(u('u_speed'), 0.62);
      gl.uniform1f(u('u_flow'), 140.0);
      gl.uniform1f(u('u_phase'), 0.18);
      gl.uniform1f(u('u_spm'), 25.0);
      gl.uniform1f(u('u_scale'), 0.6);
      gl.uniform1f(u('u_aspect'), W / H);
      gl.uniform1f(u('u_chain'), 0.0);
      gl.uniform1f(u('u_ghostX'), 0.0);
      gl.uniform1f(u('u_ghostPhase'), 0.25);
      gl.uniform1f(u('u_ghostOn'), 0.0);
      gl.uniform3f(u('u_hullA'), livery.hullA[0], livery.hullA[1], livery.hullA[2]);
      gl.uniform3f(u('u_hullB'), livery.hullB[0], livery.hullB[1], livery.hullB[2]);
      gl.uniform3f(u('u_shirt'), livery.shirt[0], livery.shirt[1], livery.shirt[2]);
      gl.uniform3f(u('u_shorts'), livery.shorts[0], livery.shorts[1], livery.shorts[2]);
      gl.uniform3f(u('u_cap'), livery.cap[0], livery.cap[1], livery.cap[2]);
      gl.uniform3f(u('u_tint'), tint[0], tint[1], tint[2]);
      gl.uniform1f(u('u_livery'), sweep);
      const bm = biome || CONIFERS;
      gl.uniform3f(u('u_ridgeFar'), bm.ridgeFar[0], bm.ridgeFar[1], bm.ridgeFar[2]);
      gl.uniform3f(u('u_ridgeNear'), bm.ridgeNear[0], bm.ridgeNear[1], bm.ridgeNear[2]);
      gl.uniform1f(u('u_treeDensity'), 0.30);
      gl.uniform3f(u('u_tree'), bm.tree[0], bm.tree[1], bm.tree[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels.slice();
    }

    const club = draw(CLUB, [1, 1, 1], 0);
    const stripe = draw(STRIPE, [1, 1, 1], 0);
    const warm = draw(CLUB, [1.07, 0.99, 0.90], 0);
    const sweep = draw(CLUB, [1, 1, 1], 0.5);
    const autumn = draw(CLUB, [1, 1, 1], 0, AUTUMN);

    function countDiff(a, b) {
      let changed = 0, maxDelta = 0;
      for (let i = 0; i < a.length; i += 4) {
        let d = 0;
        for (let c = 0; c < 4; c++) {
          const dd = Math.abs(a[i + c] - b[i + c]);
          if (dd > d) d = dd;
        }
        if (d > 2) changed++;
        if (d > maxDelta) maxDelta = d;
      }
      return { changed, maxDelta };
    }

    return {
      total: club.length / 4,
      livery: countDiff(club, stripe),
      theme: countDiff(club, warm),
      sweep: countDiff(club, sweep),
      biome: countDiff(club, autumn)
    };
  }, shaders);

  expect(diff.error).toBeUndefined();
  // The livery repaints the boat and the rower: a real change, in a
  // small part of the frame - the boat is not the whole picture.
  expect(diff.livery.changed).toBeGreaterThan(20);
  expect(diff.livery.maxDelta).toBeGreaterThan(20);
  // The theme is a grade over the whole frame: gentle, but everywhere.
  expect(diff.theme.changed).toBeGreaterThan(diff.total * 0.5);
  expect(diff.theme.maxDelta).toBeGreaterThan(3);
  // The sweep of light runs along the hull when the livery changes.
  expect(diff.sweep.changed).toBeGreaterThan(5);
  expect(diff.sweep.maxDelta).toBeGreaterThan(10);
  // And the land: a biome repaints the ridge and the pines.
  expect(diff.biome.changed).toBeGreaterThan(diff.total * 0.05);
  expect(diff.biome.maxDelta).toBeGreaterThan(20);
});
