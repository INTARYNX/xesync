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
const { boot, connectToReady, startSimulatedSession } = require('./helpers');

test.describe('the switches of the game layer', () => {
  test('the card of switches is on the screen that waits for the first stroke', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToReady(page);

    // The card is there, with the instruction not to row yet.
    await expect(page.locator('#screen-ready.active')).toBeVisible();
    await expect(page.locator('#game-panel')).toBeVisible();
    await expect(page.locator('.gi-sub')).toHaveText('don\'t row yet - the session starts cold');
    // Six switches: the coaching mode, then one per piece of the game.
    await expect(page.locator('#game-panel-rows .gi-switch')).toHaveCount(6);
    // And nothing else: the scene and the measures are not on this screen.
    await expect(page.locator('#screen-rowing.active')).toHaveCount(0);
  });

  test('the score switch takes the chip away and gives it back', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToReady(page);

    // SCORE is the second switch: coaching first, then the score.
    await page.locator('#game-panel-rows .gi-switch').nth(1).click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() =>
      GameModes.resolve(window.gameModes, false).score)).toBe(false);

    await page.locator('#game-panel-rows .gi-switch').nth(1).click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() =>
      GameModes.resolve(window.gameModes, false).score)).toBe(true);
  });

  test('the koi switch stops the push from calling anything', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToReady(page);

    // KOI is the last switch.
    await page.locator('#game-panel-rows .gi-switch').nth(5).click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.gameModes.koi)).toBe(false);

    // And the session that starts afterwards is a run without a koi.
    await startSimulatedSession(page);
    expect(await page.evaluate(() => window.runState.fishEnabled)).toBe(false);
  });

  test('a switch nobody touched follows the mode, an explicit one does not', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToReady(page);

    const states = () => page.locator('#game-panel-rows .gi-switch').evaluateAll(
      (els) => els.map((e) => (e.classList.contains('on') ? 'on' : 'off')));

    // The score is turned on by hand, and stays on.
    await page.locator('#game-panel-rows .gi-switch').nth(1).click();
    await page.waitForTimeout(150);
    await page.locator('#game-panel-rows .gi-switch').nth(1).click();
    await page.waitForTimeout(150);
    expect((await states())[1]).toBe('on');

    // The calm mode: the coaching switch is the first one.
    await page.locator('#game-panel-rows .gi-switch').nth(0).click();
    await page.waitForTimeout(250);
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
    await connectToReady(page);

    // The ghost is turned off by hand.
    await page.locator('#game-panel-rows .gi-switch').nth(3).click();
    await page.waitForTimeout(200);
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
    await page.locator('#screen-ready.active').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);

    const states = () => page.locator('#game-panel-rows .gi-switch').evaluateAll(
      (els) => els.map((e) => (e.classList.contains('on') ? 'on' : 'off')));
    expect((await states())[3]).toBe('off');
  });
});
