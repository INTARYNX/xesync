// =====================================================================
// game-modes.spec.js - the switches of the game layer.
//
// The game layer is optional: the rower decides what they want to see,
// on the screen that waits for the first stroke. Two rules are worth
// pinning in a real browser:
//
//   - off means off: the score switch takes the chip away, and the koi
//     switch stops the push from calling anything;
//   - a switch nobody touched follows the mode, and an explicit choice
//     outlives it.
//
// The switches live in localStorage, so a reload has to find them again.
//
// The scene is drawn by the shader-free 'phases' renderer here (see
// tests/e2e/build-app.js): the real fragment shader needs a GPU.
// =====================================================================

const { test, expect } = require('@playwright/test');
const { boot, connectToRower } = require('./helpers');

test.describe('the switches of the game layer', () => {
  test('the score switch takes the chip away and gives it back', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToRower(page);
    await page.waitForTimeout(1200);

    // The card folds away when the session starts; the pill opens it.
    await page.locator('#game-init-toggle').click();
    await page.waitForTimeout(300);

    const chip = () => page.locator('#run-hud').evaluate(
      (e) => getComputedStyle(e).display);

    expect(await chip()).not.toBe('none');

    // SCORE is the second switch: coaching first, then the score.
    await page.locator('#game-init-rows .gi-switch').nth(1).click();
    await page.waitForTimeout(300);
    expect(await chip()).toBe('none');

    await page.locator('#game-init-rows .gi-switch').nth(1).click();
    await page.waitForTimeout(300);
    expect(await chip()).not.toBe('none');
  });

  test('the koi switch stops the push from calling anything', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToRower(page);
    await page.waitForTimeout(1200);
    await page.locator('#game-init-toggle').click();
    await page.waitForTimeout(300);

    expect(await page.evaluate(() => window.runState.fishEnabled)).toBe(true);

    // KOI is the last switch.
    await page.locator('#game-init-rows .gi-switch').nth(5).click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.runState.fishEnabled)).toBe(false);
  });

  test('a switch nobody touched follows the mode, an explicit one does not', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToRower(page);
    await page.waitForTimeout(1200);
    await page.locator('#game-init-toggle').click();
    await page.waitForTimeout(300);

    const states = () => page.locator('#game-init-rows .gi-switch').evaluateAll(
      (els) => els.map((e) => (e.classList.contains('on') ? 'on' : 'off')));

    // The score is turned on by hand, and stays on.
    await page.locator('#game-init-rows .gi-switch').nth(1).click();
    await page.waitForTimeout(200);
    await page.locator('#game-init-rows .gi-switch').nth(1).click();
    await page.waitForTimeout(200);
    expect((await states())[1]).toBe('on');

    // The calm mode: the coaching switch is the first one.
    await page.locator('#game-init-rows .gi-switch').nth(0).click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => Coaching.getMode())).toBe('justRow');

    const after = await states();
    expect(after[0]).toBe('off');            // the coaching is off
    expect(after[1]).toBe('on');             // the score was asked for
    expect(after[2]).toBe('off');            // untouched: it follows the mode
    expect(after[3]).toBe('off');
    expect(after[4]).toBe('off');
    expect(after[5]).toBe('off');
  });

  test('the switches are still there after a reload', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToRower(page);
    await page.waitForTimeout(1200);
    await page.locator('#game-init-toggle').click();
    await page.waitForTimeout(300);

    // The ghost is turned off by hand.
    await page.locator('#game-init-rows .gi-switch').nth(3).click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() =>
      GameModes.resolve(window.gameModes, false).ghost)).toBe(false);
    // And the choice is in the phone's own storage.
    expect(await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.indexOf('gameModes') >= 0);
      return key ? localStorage.getItem(key) : '';
    })).toContain('"ghost":false');

    await page.reload();
    await page.locator('#boot-splash').waitFor({ state: 'hidden' });
    // The device was remembered, so the scan connects again by itself.
    await page.locator('#tbar-scan-btn').click();
    await page.locator('#screen-rowing.active').waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    await page.locator('#game-init-toggle').click();
    await page.waitForTimeout(300);

    const states = () => page.locator('#game-init-rows .gi-switch').evaluateAll(
      (els) => els.map((e) => (e.classList.contains('on') ? 'on' : 'off')));
    expect((await states())[3]).toBe('off');
  });
});
