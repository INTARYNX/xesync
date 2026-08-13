// =====================================================================
// rowing-session.spec.js - real browser DOM wiring, end to end, against
// the debug simulator (debug_sim.js + Debug.fakeScan/fakeConnect).
//
// Deliberately real-time, not a fake clock: initRowing() (WebGL) runs
// synchronously before initFtmsTracking() in controller.js's
// enterRowing(), so if it ever throws, the whole session never starts -
// that's worth catching with the real browser timer/rAF/WebGL stack, not
// a faked one. Every timing edge case (pause threshold, activity
// predicate, sample-rate cap, etc.) already has fast, deterministic
// coverage in tests/ftms.test.js; this file's job is narrower: prove the
// real page wires debug_sim's packets to visible DOM text, and that the
// pause -> save -> post-workout screen chain actually fires in a browser.
//
// debug_sim.js's DEBUG_MODE profile: 2s warmup, 6s effort, 2s cooldown
// (10s total), then 8s of spm=0 tail packets. INACTIVITY_MS is 10000ms in
// debug mode (the bug this whole session started from - see
// ftms_integration.js). That puts the natural pause around t=18-20s, so
// this test's timeout is set generously above that.
// =====================================================================

const { test, expect } = require('@playwright/test');
const { boot, connectToRower } = require('./helpers');

test.describe('rowing session (debug simulator)', () => {
  test('metrics update live once a device is connected', async ({ page }) => {
    test.setTimeout(30000);
    await boot(page);
    await connectToRower(page);

    // Generous, independent budgets for each metric - a WebGL-heavy page
    // under parallel workers can have setInterval ticks delayed well past
    // debug_sim's nominal 500ms cadence, and both readings come from the
    // same render() call so neither should legitimately lag the other by
    // much once either has moved.
    await expect(page.locator('#spm')).not.toHaveText('0', { timeout: 8000 });
    await expect(page.locator('#watts')).not.toHaveText('0', { timeout: 8000 });

    const distanceAt = () => page.locator('#distance').textContent().then(Number);
    const d1 = await distanceAt();
    await page.waitForTimeout(2500);
    const d2 = await distanceAt();
    expect(d2).toBeGreaterThan(d1);

    // elapsedtime is wall-clock session time, independent of packet content.
    await expect(page.locator('#elapsedtime')).not.toHaveText('00:00');
  });

  test('session pauses after inactivity, SAVE stores it offline and shows the post-workout screen', async ({ page }) => {
    test.setTimeout(45000);
    await boot(page);
    await connectToRower(page);

    // Confirm it actually went ACTIVE before waiting for it to go idle -
    // otherwise a session that never started would "pass" this test by
    // trivially reaching PAUSED-equivalent silence.
    await expect(page.locator('#spm')).not.toHaveText('0', { timeout: 8000 });

    await page.locator('#pauseDialog.visible').waitFor({ state: 'visible', timeout: 30000 });
    await expect(page.locator('#summaryDistance')).not.toHaveText('0m');

    await page.locator('#pauseDialog .ftms-btn.primary').click(); // SAVE

    // No token in offline debug mode -> onWorkoutSave takes the offline
    // branch (Bridge.send('saveData', ...) then done('offline') after
    // 1200ms) -> onWorkoutComplete('offline') -> post-workout overlay.
    await page.locator('#post-workout.visible').waitFor({ state: 'visible', timeout: 5000 });
    await expect(page.locator('#pw-title')).toHaveText('WORKOUT SAVED');
    await expect(page.locator('#pw-subtitle')).toHaveText('stored offline, will sync on next login');

    // No token -> the WORKOUTS shortcut has nothing to show.
    await expect(page.locator('#pw-workouts-btn')).toBeHidden();
  });

  test('EXIT SESSION discards the workout without saving', async ({ page }) => {
    test.setTimeout(45000);
    await boot(page);
    await connectToRower(page);
    await expect(page.locator('#spm')).not.toHaveText('0', { timeout: 8000 });
    await page.locator('#pauseDialog.visible').waitFor({ state: 'visible', timeout: 30000 });

    await page.locator('#pauseDialog .ftms-btn.secondary').click(); // EXIT SESSION

    await page.locator('#post-workout.visible').waitFor({ state: 'visible', timeout: 5000 });
    await expect(page.locator('#pw-title')).toHaveText('WORKOUT ENDED');
    await expect(page.locator('#pw-subtitle')).toHaveText('not saved');
  });
});
