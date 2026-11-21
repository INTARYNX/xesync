// =====================================================================
// game-modes.spec.js - the three ways to row.
//
// The game layer is optional, and so is the coaching: the rower picks
// one of three ways to row on the screen that waits for the first
// stroke. What is worth pinning in a real browser:
//
//   - the choices are on that screen, and nowhere else;
//   - each one turns on exactly what it says, and nothing else;
//   - the day still turns in every mode: the weather belongs to the
//     scene, not to the game;
//   - the choice is the phone's own, and survives a reload.
//
// The scene is drawn by the shader-free 'phases' renderer here (see
// tests/e2e/build-app.js): the real fragment shader needs a GPU.
// =====================================================================

const { test, expect } = require('@playwright/test');
const { boot, connectToReady, startSimulatedSession } = require('./helpers');

// The label of the chosen row.
async function selected(page) {
  return page.locator('#game-panel-rows .gi-row.selected .gi-label').textContent();
}

test.describe('the three ways to row', () => {
  test('the choices are on the screen that waits for the first stroke', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToReady(page);

    // The card is there, with the instruction not to row yet.
    await expect(page.locator('#screen-ready.active')).toBeVisible();
    await expect(page.locator('#game-panel')).toBeVisible();
    await expect(page.locator('.gi-sub')).toHaveText('don\'t row yet - the session starts cold');

    // Three choices, and one of them is the one.
    await expect(page.locator('#game-panel-rows .gi-row')).toHaveCount(3);
    await expect(page.locator('#game-panel-rows .gi-row.selected')).toHaveCount(1);
    expect(await selected(page)).toBe('COACHED');

    // And nothing else: the scene and the measures are not on this screen.
    await expect(page.locator('#screen-rowing.active')).toHaveCount(0);
  });

  test('alone is the measures and nothing else', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToReady(page);

    await page.locator('#game-panel-rows .gi-row').first().click();   // ALONE
    await page.waitForTimeout(250);
    expect(await selected(page)).toBe('ALONE');

    // The coaching is off.
    expect(await page.evaluate(() => Coaching.getMode())).toBe('justRow');

    // And so is the game: no chip, no koi, no ghost.
    await startSimulatedSession(page);
    expect(await page.locator('#run-hud').evaluate((e) => getComputedStyle(e).display)).toBe('none');
    expect(await page.evaluate(() => window.runState.fishEnabled)).toBe(false);
    expect(await page.evaluate(() => window.runState.dailyPar)).toBe(null);
  });

  test('the run is the game, and says nothing', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToReady(page);

    await page.locator('#game-panel-rows .gi-row').nth(2).click();   // THE RUN
    await page.waitForTimeout(250);
    expect(await selected(page)).toBe('THE RUN');

    // The coaching is off...
    expect(await page.evaluate(() => Coaching.getMode())).toBe('justRow');

    // ...but the game is on: the chip is there, the koi can come, the
    // day's par is there.
    await startSimulatedSession(page);
    expect(await page.locator('#run-hud').evaluate((e) => getComputedStyle(e).display)).not.toBe('none');
    expect(await page.evaluate(() => window.runState.fishEnabled)).toBe(true);
    expect(await page.evaluate(() => !!window.runState.dailyPar)).toBe(true);
  });

  test('the day still turns in every mode', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToReady(page);

    // The day's index, the same one the scene is given.
    const day = await page.evaluate(() => DailyCourse.forDate(new Date()).dayIndex);

    await page.locator('#game-panel-rows .gi-row').first().click();   // ALONE
    await page.waitForTimeout(200);
    await startSimulatedSession(page);

    // The weather belongs to the scene, not to the game: the sky still
    // follows the day, even with the game off.
    expect(await page.evaluate(() => RowingAnimation._internals.dayBase())).toBe(day);
  });

  test('the choice is still there after a reload', async ({ page }) => {
    test.setTimeout(40000);
    await boot(page);
    await connectToReady(page);

    await page.locator('#game-panel-rows .gi-row').nth(2).click();   // THE RUN
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.gameMode)).toBe('run');

    await page.reload();
    await page.locator('#boot-splash').waitFor({ state: 'hidden' });
    // The device was remembered, so the scan connects again by itself.
    await page.locator('#tbar-scan-btn').click();
    await page.locator('#screen-ready.active').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);

    expect(await selected(page)).toBe('THE RUN');
  });
});
