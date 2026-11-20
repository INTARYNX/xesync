'use strict';
// =====================================================================
// koi-shot.js - render the koi for docs/GAMIFICATION.md.
//
// Unlike scene-shot.js, the koi is not in the fragment shader any more
// (see koi.spec.js's header comment): it is drawKoi(), plain 2D canvas
// paths on koiCanvas, stacked over the WebGL one. That means it cannot
// be exercised on a bare synthetic <canvas> the way scene-shot.js drives
// the raw GLSL - it needs the real page (rowing_display.html), with
// initRowing() actually run and setFish() actually called, so this
// loads the real file and screenshots the composited result instead of
// drawing to an offscreen canvas by hand.
//
//   node tests/e2e/koi-shot.js
//
// Writes: docs/images/scene-koi.png, scene-koi-held.png,
//         scene-koi-compare.png (the two, side by side)
// =====================================================================

const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'images');
const FILE = 'file://' + path.join(ROOT, 'rowing_display.html').replace(/\\/g, '/');
const VIEWPORT = { width: 520, height: 330 };
// Cropped and zoomed on the water the koi swims in, the same framing
// scene-shot.js used to use for its koi-compare sheet.
const CROP = { x: 295, y: 198, width: 120, height: 75 };
const ZOOM = 3;

async function shootKoi(page, hold) {
  await page.evaluate((h) => { setFish({ present: true, hold: h }); }, hold);
  // A few animation frames so the koi has faded fully in and settled
  // into its station before the shot.
  await page.waitForTimeout(650);
  return page.screenshot({ clip: CROP });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(FILE);
  // rowing_display.html alone (outside app.html's #main-container chain)
  // has no ancestor with a resolvable height, so #wrapper's height:100%
  // collapses to 0 and nothing renders - give it one explicitly.
  await page.addStyleTag({ content: 'html,body{height:100%;margin:0;}' });
  await page.evaluate(() => { initRowing(); });

  const calmBuf = await shootKoi(page, 0.0);
  const heldBuf = await shootKoi(page, 0.95);
  await browser.close();

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'scene-koi.png'), calmBuf);
  fs.writeFileSync(path.join(OUT, 'scene-koi-held.png'), heldBuf);
  console.log('écrit', path.relative(ROOT, path.join(OUT, 'scene-koi.png')));
  console.log('écrit', path.relative(ROOT, path.join(OUT, 'scene-koi-held.png')));

  // Compose the side-by-side sheet in a second, plain page (no WebGL
  // needed here - just drawing the two PNGs already captured).
  const browser2 = await chromium.launch();
  const page2 = await browser2.newPage();
  const sheetDataUrl = await page2.evaluate(async ({ calmB64, heldB64, crop, zoom }) => {
    function loadImg(b64) {
      return new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('image load failed'));
        im.src = 'data:image/png;base64,' + b64;
      });
    }
    const calm = await loadImg(calmB64);
    const held = await loadImg(heldB64);
    const PAD = 12, LABEL_H = 20;
    const w = Math.round(crop.width * zoom), h = Math.round(crop.height * zoom);
    const sheet = document.createElement('canvas');
    sheet.width = w * 2 + PAD * 3;
    sheet.height = h + PAD * 2 + LABEL_H;
    const ctx = sheet.getContext('2d');
    ctx.fillStyle = '#12101a';
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    ctx.fillStyle = '#e8e2f0';
    ctx.font = '14px sans-serif';
    ctx.fillText('la carpe', PAD, 16);
    ctx.drawImage(calm, 0, 0, calm.width, calm.height, PAD, LABEL_H, w, h);
    const x2 = PAD * 2 + w;
    ctx.fillText('la carpe, tenue pleine', x2, 16);
    ctx.drawImage(held, 0, 0, held.width, held.height, x2, LABEL_H, w, h);
    return sheet.toDataURL('image/png');
  }, { calmB64: calmBuf.toString('base64'), heldB64: heldBuf.toString('base64'), crop: CROP, zoom: ZOOM });
  await browser2.close();

  const comparePath = path.join(OUT, 'scene-koi-compare.png');
  fs.writeFileSync(comparePath, Buffer.from(sheetDataUrl.split(',')[1], 'base64'));
  console.log('écrit', path.relative(ROOT, comparePath));
})();
