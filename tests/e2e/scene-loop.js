'use strict';
// =====================================================================
// scene-loop.js - render the rowing scene in motion, and say nothing.
//
// The scene has been looked at as stills so far: a picture of the boat,
// a picture of the koi, a picture of the peaks. Nobody has ever watched
// it move, which is exactly what a scene is for.
//
// This script loads the real page (rowing_display.html), lets the real
// animation loop run - the same rAF, the same uniforms, the same
// shader - and grabs the composited frame after each draw: the WebGL
// canvas, then the scenery canvas over it, then the koi canvas over
// that. What comes out is not a mock-up: it is the app, in motion.
//
//   node tests/e2e/scene-loop.js
//
// Writes: docs/images/scene-loop.gif, docs/images/scene-loop.mp4
//
// The software renderer draws about one frame a second here, so the
// scene's own clock is slowed down to match: the frames are captured
// as fast as the machine can draw them and the clock is scaled to what
// the picture needs, which makes the loop play at roughly the speed a
// phone would show it at, one slow frame at a time.
// =====================================================================

const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'images');
const FRAMES = path.join(__dirname, '.frames');
const FILE = 'file://' + path.join(ROOT, 'rowing_display.html').replace(/\\/g, '/');
const VIEWPORT = { width: 520, height: 330 };
const FRAME_COUNT = 40;
// How much of a second of scene time each captured frame advances. The
// software renderer needs about four seconds a frame, so the clock is
// scaled down by this much to keep the motion at a watchable pace.
const SCENE_STEP_S = 0.13;
const WARMUP_MS = 1500;

// The frame grab: the app draws the WebGL canvas in its own rAF, then
// the scenery canvas and the koi canvas. The drawing buffer is gone
// once the frame is presented, so the grab has to happen inside the
// same animation frame, right after the app's draw - hence the
// requestAnimationFrame hook, which runs the app's callback first and
// the grab second.
const GRAB_HOOK = () => {
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return orig(function (t) {
      cb(t);
      const g = window.__grab;
      if (g) { window.__grab = null; g(); }
    });
  };
};

// The scene's clock, slowed down. performance.now() is what the
// animation reads for its dt, so scaling it slows the whole scene -
// the stroke cycle, the water, the day - and nothing else.
const SLOW_CLOCK = (step) => {
  const real = performance.now.bind(performance);
  const t0 = real();
  const scale = step / 1000;
  performance.now = function () { return t0 + (real() - t0) * scale; };
};

async function main() {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); });
  await page.addInitScript(GRAB_HOOK);
  await page.addInitScript(SLOW_CLOCK, SCENE_STEP_S);
  await page.goto(FILE);
  // rowing_display.html alone (outside app.html's #main-container chain)
  // has no ancestor with a resolvable height, so #wrapper's height:100%
  // collapses to 0 and nothing renders - give it one explicitly.
  await page.addStyleTag({ content: 'html,body{height:100%;margin:0;}' });
  await page.evaluate(() => { initRowing(); });

  // A session: rowing at a steady 26 spm, at a normal speed, so the
  // water moves, the peaks answer the chain, and the ghost has
  // somebody to chase.
  await page.evaluate(() => {
    setConsoleSpeedAndSpm(6.0, 26, 320, 100);
    setChainLevel(0.55);
  });
  await page.addScriptTag({ path: path.join(ROOT, 'ghost.js') });
  await page.evaluate(() => {
    var samples = [];
    for (var i = 0; i <= 120; i++) {
      var t = i * 2.5;
      samples.push({ time: t, distance: t * 2.6, spm: 24 });
    }
    setGhostProfile(Ghost.buildProfile(samples));
    setFish({ present: true, hold: 0.45 });
  });

  await page.waitForTimeout(WARMUP_MS);

  for (let i = 0; i < FRAME_COUNT; i++) {
    const dataUrl = await page.evaluate(() => new Promise((resolve) => {
      window.__grab = () => {
        const out = document.createElement('canvas');
        out.width = 520; out.height = 330;
        const ctx = out.getContext('2d');
        ['glCanvas', 'sceneryCanvas', 'koiCanvas'].forEach((id) => {
          const c = document.getElementById(id);
          if (c) ctx.drawImage(c, 0, 0, out.width, out.height);
        });
        resolve(out.toDataURL('image/png'));
      };
    }));
    fs.writeFileSync(path.join(FRAMES, 'f' + String(i).padStart(4, '0') + '.png'),
      Buffer.from(dataUrl.split(',')[1], 'base64'));
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  await browser.close();

  fs.mkdirSync(OUT, { recursive: true });
  const gif = path.join(OUT, 'scene-loop.gif');
  const mp4 = path.join(OUT, 'scene-loop.mp4');
  const fps = (1 / SCENE_STEP_S).toFixed(2);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', fps,
    '-i', path.join(FRAMES, 'f%04d.png'),
    '-vf', 'scale=520:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
    gif]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', fps,
    '-i', path.join(FRAMES, 'f%04d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
    mp4]);

  console.log('cadence ~' + fps + ' i/s');
  console.log('écrit', path.relative(ROOT, gif));
  console.log('écrit', path.relative(ROOT, mp4));
  fs.rmSync(FRAMES, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
