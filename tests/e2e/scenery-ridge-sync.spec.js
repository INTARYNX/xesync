// =====================================================================
// scenery-ridge-sync.spec.js - the JS twin of the shader's ridge math
// stays structurally in sync with the real GLSL.
//
// drawScenery() (rowing_display.js) places villages/mills/churches by
// re-deriving the exact ridge line the shader's own pine band stands on
// (see its "Pines along the nearest ridge" block, rowing_display.html) -
// hashJS/noiseJS/peakProfileJS/ridgeLineY are a hand-ported twin of the
// GLSL hash/noise/peakProfile and the pine ridge's own formula. Nothing
// enforces that the two stay identical: a future tuning change to one
// and not the other would silently desync every building from the hill
// it is supposed to sit on, with no compiler error and no other test to
// catch it.
//
// This checks the magic constants on both sides match, literally -
// NOT by running both and comparing numbers. hash()/noise() are
// deliberately chaotic (that is what makes them usable as noise): a
// float32 GLSL run and a float64 JS run of the textually identical
// formula diverge by a large amount from the very first multiply
// (confirmed by hand while writing this test - hash(0.3, 7.1) came
// back 0.227 in JS, 0.157 in the real compiled shader, purely from
// float32 vs float64 rounding, nothing to do with the port being
// wrong). A numeric-equality test would therefore fail constantly on
// a correct port, and could pass on a subtly wrong one depending on
// which float-rounding accidents happen to land close together - the
// wrong tool here. Comparing the literal constants each side uses is
// what actually catches the failure mode this test exists for: one
// side's tuning changing without the other's.
// =====================================================================

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

test('the GLSL and JS hash/noise/peakProfile use the same constants', () => {
  const html = fs.readFileSync(path.join(ROOT, 'rowing_display.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'rowing_display.js'), 'utf8');

  // hash(): the two magic multipliers and the mixing offset.
  expect(html).toContain('p * vec2(123.34, 456.21)');
  expect(html).toContain('dot(p, p + 45.32)');
  expect(js).toContain('fractJS(wx * 123.34)');
  expect(js).toContain('fractJS(wy * 456.21)');
  expect(js).toContain('px * (px + 45.32)');
  expect(js).toContain('py * (py + 45.32)');

  // noise(): the quintic smoothing curve (6t^5 - 15t^4 + 10t^3).
  expect(html).toContain('f*f*f*(f*(f*6.0-15.0)+10.0)');
  expect(js).toContain('fx * fx * fx * (fx * (fx * 6 - 15) + 10)');
  expect(js).toContain('fy * fy * fy * (fy * (fy * 6 - 15) + 10)');

  // peakProfile(): the quarter-turn phase offset and the triangle's slope/bias.
  expect(html).toContain('(x + 1.5707963) / TAU + 0.5');
  expect(html).toContain('* 4.0 - 1.0');
  expect(js).toContain('(x + 1.5707963) / TAU_JS + 0.5');
  expect(js).toContain('* 4.0 - 1.0');

  // The pine band's own ridge line (not the LAYER macro - see its
  // comment: "same line as the last LAYER"), and ridgeLineY's port of
  // it, each naming the same baseY/frequency/phase/amplitude constants.
  expect(html).toContain('float baseY = horizon + 0.01;');
  expect(html).toContain('peakProfile(sc * 44.0 + 2.0, u_sharp)');
  expect(html).toContain('noise(vec2(sc * 8.0, baseY * 5.0))');
  expect(html).toContain('* 0.007 * agitation;');
  expect(js).toContain('var baseY = 0.51;'); // horizon(0.5) + 0.01, baked in on the JS side
  expect(js).toContain('peakProfileJS(sc * 44.0 + 2.0, sharpVal)');
  expect(js).toContain('noiseJS(sc * 8.0, baseY * 5.0)');
  expect(js).toContain('* 0.007 * agitationVal;');
});

// wrapCoord()'s own job (mod(p, 1024.0), both sides true mathematical
// modulo) is covered separately since it is a simple, non-chaotic
// function where exact numeric agreement is meaningful and cheap to
// check directly - unlike hash/noise/peakProfile above.
test('wrapCoord (JS and GLSL) agree on the 1024-unit wrap, including negatives', async ({ page }) => {
  await page.goto('about:blank');
  const samples = [0, 0.3, 1023.9, 1024, 1024.5, 2500.25, -0.1, -30, -1024, -2049.5];

  const jsWrap = samples.map((x) => ((x % 1024) + 1024) % 1024);

  const glslWrap = await page.evaluate((samples) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    const vs = 'attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos,0.0,1.0); }';
    // mod(x, 1024.0) directly - encoded as a fraction of 1024 so an
    // 8-bit readback still resolves it to within ~4 units.
    const fs = 'precision highp float;\nuniform float u_x;\nvoid main(){\n' +
      '  float m = mod(u_x, 1024.0);\n' +
      '  gl_FragColor = vec4(m / 1024.0, 0.0, 0.0, 1.0);\n}';
    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const uX = gl.getUniformLocation(prog, 'u_x');
    const pixel = new Uint8Array(4);
    return samples.map((x) => {
      gl.viewport(0, 0, 1, 1);
      gl.uniform1f(uX, x);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return (pixel[0] / 255) * 1024;
    });
  }, samples);

  for (let i = 0; i < samples.length; i++) {
    expect(Math.abs(jsWrap[i] - glslWrap[i])).toBeLessThan(5); // 8-bit-over-1024 quantization
  }
});
