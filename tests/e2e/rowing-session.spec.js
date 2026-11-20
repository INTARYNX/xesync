// =====================================================================
// rowing-session.spec.js - real browser DOM wiring, end to end, against
// the debug simulator (debug_sim.js + Debug.fakeScan/fakeConnect).
//
// Deliberately real-time, not a fake clock: initRowing() runs synchronously
// before initFtmsTracking() in controller.js's enterRowing(), so if it ever
// throws, the whole session never starts - that's worth catching with the
// real browser timer/rAF stack, not a faked one. Every timing edge case
// (pause threshold, activity predicate, sample-rate cap, etc.) already has
// fast, deterministic coverage in tests/ftms.test.js; this file's job is
// narrower: prove the real page wires debug_sim's packets to visible DOM
// text, that the animation walks the four phases of the stroke in order,
// and that the pause -> save -> post-workout screen chain actually fires in
// a browser.
//
// The scene itself is drawn by the shader-free 'phases' renderer (see
// tests/e2e/build-app.js and rowing_display.js): the real fragment shader
// is too expensive without a GPU and starves the event loop, which makes
// the page stop answering Playwright's queries. The stroke cycle - the
// tracker, the pose track, the surge, the drive fraction - is unchanged.
//
// debug_sim.js's DEBUG_MODE profile: 2s warmup, 6s effort, 2s cooldown
// (10s total), then 8s of spm=0 tail packets. INACTIVITY_MS is 10000ms in
// debug mode (the bug this whole session started from - see
// ftms_integration.js). That puts the natural pause around t=18-20s, so
// this test's timeout is set generously above that.
// =====================================================================

const { test, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
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

  test('EXIT SESSION asks for confirmation, and cancelling keeps the session', async ({ page }) => {
    test.setTimeout(45000);
    await boot(page);
    await connectToRower(page);
    await expect(page.locator('#spm')).not.toHaveText('0', { timeout: 8000 });
    await page.locator('#pauseDialog.visible').waitFor({ state: 'visible', timeout: 30000 });

    await page.locator('#pauseDialog .ftms-btn.secondary').click(); // EXIT SESSION

    // A stray tap on EXIT SESSION must not discard the workout outright -
    // it only opens a confirmation, and the pause dialog underneath is gone
    // so a second accidental tap in the same spot can't land on anything.
    await page.locator('#exitConfirmDialog.visible').waitFor({ state: 'visible', timeout: 5000 });
    await expect(page.locator('#pauseDialog')).not.toHaveClass(/visible/);

    await page.locator('#exitCancelBtn').click(); // KEEP ROWING
    await page.locator('#pauseDialog.visible').waitFor({ state: 'visible', timeout: 5000 });
    await expect(page.locator('#exitConfirmDialog')).not.toHaveClass(/visible/);
  });

  test('confirming EXIT SESSION discards the workout without saving', async ({ page }) => {
    test.setTimeout(45000);
    await boot(page);
    await connectToRower(page);
    await expect(page.locator('#spm')).not.toHaveText('0', { timeout: 8000 });
    await page.locator('#pauseDialog.visible').waitFor({ state: 'visible', timeout: 30000 });

    await page.locator('#pauseDialog .ftms-btn.secondary').click(); // EXIT SESSION
    await page.locator('#exitConfirmDialog.visible').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#exitConfirmBtn').click(); // DISCARD

    await page.locator('#post-workout.visible').waitFor({ state: 'visible', timeout: 5000 });
    await expect(page.locator('#pw-title')).toHaveText('WORKOUT ENDED');
    await expect(page.locator('#pw-subtitle')).toHaveText('not saved');
  });

  test('the run score shows in the HUD and grows with the session', async ({ page }) => {
    test.setTimeout(45000);
    await boot(page);
    await connectToRower(page);

    // The game layer's chip: a number, a ring that fills with the chain,
    // and the lift bar. Quiet by design - no text, no banner.
    const hud = page.locator('#run-hud');
    await hud.waitFor({ state: 'visible', timeout: 10000 });
    await expect(page.locator('#run-chain-mult')).toHaveText(/^\u00d7[1-6]$/);
    await expect(page.locator('#run-score-value')).toHaveText(/^\d+$/);

    const before = Number(await page.locator('#run-score-value').textContent());
    await page.waitForTimeout(4000);
    const after = Number(await page.locator('#run-score-value').textContent());
    expect(after).toBeGreaterThan(before);
  });

  test('the animation walks the four phases of the stroke in order', async ({ page }) => {
    test.setTimeout(45000);
    await boot(page);
    await connectToRower(page);

    // The phase strip is the shader-free renderer (renderMode 'phases'):
    // the same stroke cycle the WebGL scene draws, with the phase it is in
    // exposed as data-phase instead of pixels.
    const strip = page.locator('#phase-strip');
    await strip.waitFor({ state: 'visible', timeout: 10000 });

    // The four cards, in the table's order, with their english names.
    await expect(strip.locator('.phase-card')).toHaveCount(4);
    await expect(strip.locator('.phase-card').nth(0)).toHaveAttribute('data-phase', 'catch');
    await expect(strip.locator('.phase-card').nth(1)).toHaveAttribute('data-phase', 'drive');
    await expect(strip.locator('.phase-card').nth(2)).toHaveAttribute('data-phase', 'finish');
    await expect(strip.locator('.phase-card').nth(3)).toHaveAttribute('data-phase', 'recovery');

    // The active card is the one the animation is in, and it is never two
    // at once.
    const active = strip.locator('.phase-card.active');
    await expect(active).toHaveCount(1);
    await expect(strip).toHaveAttribute('data-phase', /catch|drive|finish|recovery/);

    // Sample the phase over a few seconds of rowing. The cycle must move
    // forward through the phases in the table's order - catch, drive,
    // finish, recovery - and never run backwards. A sample can be missed
    // (the two transition windows are short), so the check is on the
    // direction of travel, not on hitting every phase exactly.
    const ORDER = ['catch', 'drive', 'finish', 'recovery'];
    const seen = [];
    for (let i = 0; i < 160; i++) {
      const phase = await strip.getAttribute('data-phase');
      if (phase && seen[seen.length - 1] !== phase) seen.push(phase);
      await page.waitForTimeout(50);
    }

    assert.ok(seen.length >= 2, `the phase never changed (${seen.join(' -> ')})`);
    for (let i = 1; i < seen.length; i++) {
      const from = ORDER.indexOf(seen[i - 1]);
      const to = ORDER.indexOf(seen[i]);
      assert.ok(from >= 0 && to >= 0, `unexpected phase in ${seen.join(' -> ')}`);
      const step = (to - from + ORDER.length) % ORDER.length;
      assert.ok(step >= 1, `the stroke ran backwards: ${seen.join(' -> ')}`);
    }
    // The animation really moved through the cycle, not just one phase.
    assert.ok(new Set(seen).size >= 3, `only ${new Set(seen).size} phase(s) seen: ${seen.join(' -> ')}`);
  });

  test('the course of the day shows in the HUD, and the sky follows it', async ({ page }) => {
    test.setTimeout(45000);
    await boot(page);
    await connectToRower(page);

    // The par of the day is a notch on the ring. No label, no text -
    // just a mark at the angle where today's chain par sits.
    const par = page.locator('#run-chain-par');
    await expect(par).toBeVisible({ timeout: 10000 });
    const transform = await par.getAttribute('transform');
    assert.ok(/rotate\(-?\d/.test(transform || ''),
      `the notch should be placed on the ring (${transform})`);

    // One dot per push the day asks for.
    const dots = page.locator('#run-push-dots .run-push-dot');
    await expect(dots.first()).toBeVisible({ timeout: 10000 });
    const count = await dots.count();
    assert.ok(count >= 1 && count <= 3, `the day should ask for 1 to 3 pushes (${count})`);

    // The scene is under the day's sky: the same index for everyone
    // rowing today.
    const scene = await page.evaluate(() => ({
      dayBase: window.RowingAnimation._internals.dayBase(),
      today: window.DailyCourse.forDate(new Date()).dayIndex
    }));
    assert.equal(scene.dayBase, scene.today,
      'the scene should be showing the day\'s conditions');

    // A picture, because "does it look right" is not a unit test.
    await page.locator('#run-hud').screenshot({
      path: 'tests/e2e/.build/run-hud-daily.png'
    });
  });

  test('the boat wears the livery the history earned', async ({ page }) => {
    test.setTimeout(45000);
    await boot(page);
    await connectToRower(page);
    // The session has to have started: the dressing is put on when the
    // run starts, not before.
    await expect(page.locator('#run-chain-par')).toBeVisible({ timeout: 10000 });

    // Nobody behind the account yet: the club livery, the colours the
    // boat always had.
    const before = await page.evaluate(() => {
      const c = window.RowingAnimation._internals.costume();
      return c ? { livery: c.livery.key, biome: c.biome.key, theme: c.theme.key } : null;
    });
    assert.ok(before, 'the scene should be dressed');
    assert.equal(before.livery, 'club');
    assert.equal(before.biome, 'conifers');

    // The theme is the hour's, the same for everyone rowing now.
    const theme = await page.evaluate(() => {
      const c = window.RowingAnimation._internals.costume();
      const today = window.DailyCourse.forDate(new Date());
      return { worn: c.theme.key, expected: window.Costume.theme(today).key };
    });
    assert.equal(theme.worn, theme.expected);

    // Five sessions later, the boat wears the racing stripe - and says
    // so with light, not with words.
    const after = await page.evaluate(() => {
      window.setSessionCount(5);
      const c = window.RowingAnimation._internals.costume();
      return {
        livery: c.livery.key,
        biome: c.biome.key,
        sweep: window.RowingAnimation._internals.liverySweep()
      };
    });
    assert.equal(after.livery, 'stripe',
      'the livery follows the number of sessions done');
    // The land moves with the boat: a new boat is also a new place.
    assert.equal(after.biome, 'clearing',
      'the land follows the same progression as the livery');
    assert.ok(after.sweep > 0,
      'a new livery runs a sweep of light along the hull');
  });

  test('the ghost of the best run is placed in the scene', async ({ page }) => {
    test.setTimeout(45000);
    await boot(page);
    await connectToRower(page);

    // A past run, fed through the real module: the ghost rows at 30 spm
    // while the debug rower is slower, so it pulls ahead.
    const built = await page.evaluate(() => {
      const samples = [];
      for (let t = 0; t <= 600; t += 1) {
        samples.push([t, Math.round(t * 8.6), Math.round(t * 0.5), 30, 220, null, 65]);
      }
      const profile = window.Ghost.buildProfile(samples);
      window.setGhostProfile(profile);
      return {
        ok: !!profile,
        points: profile ? profile.points.length : 0,
        distance: profile ? profile.distance : 0
      };
    });
    assert.ok(built.ok, 'the profile should be built');
    assert.ok(built.points > 10, `the profile should have points (${built.points})`);
    assert.ok(built.distance > 5000, `the ghost should have covered the distance (${built.distance})`);

    // The debug simulator warms up for two seconds before the rower
    // moves. Wait for the session to be under way, so the comparison is
    // a real one.
    await page.waitForFunction(
      () => window.RowingAnimation._internals.sessionElapsed() > 3,
      null, { timeout: 15000 }
    );

    // The scene places it: drawn, and ahead of the player. The test
    // build runs the shader-free renderer, which does not run the WebGL
    // frame loop, so the placement is driven by hand here - the same
    // function the scene calls on every frame.
    const placed = await page.evaluate(() => {
      window.RowingAnimation._internals.updateGhost();
      return {
        on: window.RowingAnimation._internals.ghostOn(),
        offset: window.RowingAnimation._internals.ghostOffset(),
        phase: window.RowingAnimation._internals.ghostPhase()
      };
    });
    assert.equal(placed.on, 1, 'the ghost should be drawn');
    assert.ok(placed.offset > 0,
      `the ghost should be ahead of the player (${placed.offset})`);
    assert.ok(placed.phase >= 0 && placed.phase < 1,
      `the ghost's stroke phase should be a fraction (${placed.phase})`);
  });

  test('the chain reaches the scene, packet after packet', async ({ page }) => {
    test.setTimeout(45000);
    await boot(page);

    // The scene is inlined into app.html by the build (see build-app.js), so
    // the renderer and the controller share one global scope. The spy
    // proves the controller really calls the scene's entry point - and not
    // just that the function happens to exist.
    await page.evaluate(() => {
      window.__chainCalls = 0;
      window.__lastChainLevel = null;
      const original = window.setChainLevel;
      window.setChainLevel = function (level) {
        window.__chainCalls++;
        window.__lastChainLevel = level;
        return original(level);
      };
    });

    await connectToRower(page);

    // The packets arrive, and each one carries the chain level to the scene.
    await page.waitForFunction(() => window.__chainCalls > 0, null, { timeout: 15000 });
    const calls = await page.evaluate(() => window.__chainCalls);
    assert.ok(calls > 0, 'the controller never told the scene about the chain');

    // The level that landed is a number between 0 and 1, and the scene is
    // holding exactly that value.
    const result = await page.evaluate(() => ({
      last: window.__lastChainLevel,
      inScene: window.RowingAnimation._internals.chainLevel(),
      sceneIsDefined: typeof window.setChainLevel === 'function'
    }));
    assert.ok(typeof result.last === 'number', `the chain level was ${result.last}`);
    assert.ok(result.last >= 0 && result.last <= 1, `the chain level was ${result.last}`);
    assert.ok(result.sceneIsDefined, 'the scene does not expose setChainLevel');
    assert.equal(result.inScene, result.last, 'the scene did not take the level it was given');

    // And it keeps coming, not once.
    await page.waitForTimeout(3000);
    const later = await page.evaluate(() => window.__chainCalls);
    assert.ok(later > calls, `the chain level was sent ${later} time(s) in total`);
  });

  test('the koi reaches the scene', async ({ page }) => {
    test.setTimeout(45000);
    await boot(page);
    await connectToRower(page);

    // The debug simulator rows for ten seconds: the norm never
    // establishes, so the game never pushes and no koi is called. The
    // koi's own rules are checked in tests/run_score.test.js; what this
    // checks is the way the koi travels - from the rules, through the
    // controller, to the scene, packet after packet.
    const before = await page.evaluate(() => ({
      sceneIsDefined: typeof window.setFish === 'function',
      on: window.RowingAnimation._internals.fishOn()
    }));
    assert.ok(before.sceneIsDefined, 'the scene does not expose setFish');
    assert.equal(before.on, 0, 'no koi to start with');

    // The rules say there is one, and how close it is to being landed.
    // The run is reset when the session starts, so the wait comes
    // first: the state has to be set on a run that is already going.
    await page.waitForFunction(() => window.runState.totalSeconds > 0, null, { timeout: 15000 });
    await page.evaluate(() => {
      runState.fish.present = true;
      runState.fish.holdSeconds = 7;
    });

    // The next packet carries it to the scene.
    await page.waitForFunction(
      () => window.RowingAnimation._internals.fishOn() === 1, null, { timeout: 15000 });

    const after = await page.evaluate(() => ({
      on: window.RowingAnimation._internals.fishOn(),
      hold: window.RowingAnimation._internals.fishHold(),
      x: window.RowingAnimation._internals.fishX()
    }));
    assert.equal(after.on, 1, 'the koi should be in the scene');
    assert.ok(Math.abs(after.hold - 7 / 15) < 0.02,
      `the hold should be carried over (${after.hold})`);
    assert.ok(after.x !== 0, 'the koi should have a place on the water');
  });
});
