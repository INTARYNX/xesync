// =====================================================================
// koi.spec.js - the koi's own 2D canvas (koiCanvas), drawn by
// rowing_display.js's drawKoi() - not the fragment shader.
//
// The koi used to be SDF math inside the fragment shader (see
// shader.spec.js's history) and was tested the same way as the chain or
// the livery: compile the GLSL, set uniforms, read pixels. It now lives
// on a plain <canvas id="koiCanvas"> stacked over the WebGL one, so this
// file tests that canvas directly instead.
//
// Like shader.spec.js, this runs against a synthetic page rather than the
// built app.html: the shared client/db-integration builds both force
// renderMode='phases' (no GPU in CI - see build-app.js), and 'phases'
// never calls drawKoi() at all (only frame(), the WebGL path, does). A
// minimal fixture with just the elements initRowing() touches
// (#wrapper, #glCanvas, #koiCanvas, #gl-loading) sidesteps that build
// entirely, the same way shader.spec.js sidesteps it for the GLSL itself.
// =====================================================================

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const W = 520, H = 330;

function readRowingJs() {
  return fs.readFileSync(path.join(ROOT, 'rowing_display.js'), 'utf8');
}

// initRowing() compiles the real GLSL from <script id="vs">/"fs"> - same
// shader blocks shader.spec.js reads out of rowing_display.html.
function readShaders() {
  const html = fs.readFileSync(path.join(ROOT, 'rowing_display.html'), 'utf8');
  const vs = html.match(/<script id="vs"[^>]*>([\s\S]*?)<\/script>/);
  const fs_ = html.match(/<script id="fs"[^>]*>([\s\S]*?)<\/script>/);
  if (!vs || !fs_) throw new Error('could not find the vs/fs shader blocks');
  return { vs: vs[1], fs: fs_[1] };
}

async function loadFixture(page) {
  const shaders = readShaders();
  await page.goto('about:blank');
  await page.setContent(
    '<!DOCTYPE html><html><body>' +
    '<div id="wrapper" style="position:relative;width:' + W + 'px;height:' + H + 'px;">' +
    '<canvas id="glCanvas" style="position:absolute;left:0;top:0;width:100%;height:100%;"></canvas>' +
    '<canvas id="koiCanvas" style="position:absolute;left:0;top:0;width:100%;height:100%;"></canvas>' +
    '<div id="gl-loading"></div>' +
    '</div>' +
    '<script id="vs" type="x-shader/x-vertex">' + shaders.vs + '</script>' +
    '<script id="fs" type="x-shader/x-fragment">' + shaders.fs + '</script>' +
    '</body></html>'
  );
  await page.addScriptTag({ content: readRowingJs() });
}

// How many of the koi canvas's pixels are not fully transparent, and
// roughly what colour they average to - enough to tell "nothing was
// drawn" from "something was drawn" from "the hold colour shifted".
async function koiPixelStats(page) {
  return page.evaluate(() => {
    var c = document.getElementById('koiCanvas');
    var ctx = c.getContext('2d');
    var d = ctx.getImageData(0, 0, c.width, c.height).data;
    var opaque = 0, r = 0, g = 0, b = 0;
    for (var i = 0; i < d.length; i += 4) {
      var a = d[i + 3];
      if (a > 10) {
        opaque++;
        r += d[i]; g += d[i + 1]; b += d[i + 2];
      }
    }
    return {
      total: d.length / 4,
      opaque: opaque,
      avg: opaque > 0 ? [r / opaque, g / opaque, b / opaque] : [0, 0, 0]
    };
  });
}

test('the koi is drawn on its own canvas, not the shader\'s', async ({ page }) => {
  await loadFixture(page);
  const before = await koiPixelStats(page);
  expect(before.opaque).toBe(0);

  await page.evaluate(() => { initRowing(); setFish({ present: true, hold: 0.0 }); });
  await page.waitForTimeout(300);

  const after = await koiPixelStats(page);
  // A small creature in a 520x330 frame: real pixels, not the whole canvas.
  expect(after.opaque).toBeGreaterThan(50);
  expect(after.opaque).toBeLessThan(after.total * 0.2);
});

test('the koi clears from its canvas once it has swum away', async ({ page }) => {
  await loadFixture(page);
  await page.evaluate(() => { initRowing(); setFish({ present: true, hold: 0.0 }); });
  await page.waitForTimeout(300);
  expect((await koiPixelStats(page)).opaque).toBeGreaterThan(50);

  // present:false with no prior landing -> fishExit stays 0 -> fishFade
  // drops to 0 on the very next frame (no swim-away animation to wait out).
  await page.evaluate(() => { setFish({ present: false }); });
  await page.waitForTimeout(150);

  expect((await koiPixelStats(page)).opaque).toBe(0);
});

test('the koi warms towards gold as the hold fills', async ({ page }) => {
  await loadFixture(page);
  await page.evaluate(() => { initRowing(); setFish({ present: true, hold: 0.0 }); });
  await page.waitForTimeout(300);
  const low = await koiPixelStats(page);

  await page.evaluate(() => { setFish({ present: true, hold: 0.95 }); });
  await page.waitForTimeout(300);
  const high = await koiPixelStats(page);

  expect(low.opaque).toBeGreaterThan(50);
  expect(high.opaque).toBeGreaterThan(50);
  // Red warming towards gold: green rises relative to red (0.24 -> 0.70
  // of red in the patch colour - see KOI_FIN_BASE/drawKoi's koiRedRGB).
  const lowRatio = low.avg[1] / Math.max(1, low.avg[0]);
  const highRatio = high.avg[1] / Math.max(1, high.avg[0]);
  expect(highRatio).toBeGreaterThan(lowRatio);
});
