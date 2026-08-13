// =====================================================================
// save-workout.db.spec.js - real login form -> real PostgREST -> real
// Postgres, using the dev/docker-compose.yml stack.
//
// Everything else in tests/e2e/ drives the debug simulator with zero
// backend. This file is the other half: it proves the login screen, the
// full debug rowing session, and save_workout() are wired together
// correctly end to end - not three things independently mocked.
//
// Requires: podman compose -f dev/docker-compose.yml up -d
// If PostgREST isn't reachable, every test in this file skips itself
// (via beforeAll) rather than failing the whole suite - `npm run test:e2e`
// should still be runnable without the DB stack for the client-only specs.
// =====================================================================

const { test, expect } = require('@playwright/test');

const TEST_USER = { username: 'e2e_test_user', password: 'E2eTestPass123!' };

test.describe('save_workout against real PostgREST', () => {
  let postgrestUrl;
  let dbUp = false;

  test.beforeAll(async ({ request }) => {
    // Same URL playwright.config.js baked into this project's config.js
    // (DEV_POSTGREST_URL, defaulting to the same localhost:3001) - kept as
    // one source of truth via the env var rather than re-deriving it from
    // the built page.
    postgrestUrl = process.env.DEV_POSTGREST_URL || 'http://localhost:3001';
    const health = await request.post(`${postgrestUrl}/rpc/login`, {
      data: { username: 'nonexistent_probe_user', password: 'x' },
      failOnStatusCode: false
    }).catch(() => null);
    dbUp = !!health && health.ok();
  });

  test.beforeEach(() => {
    test.skip(!dbUp, `Local PostgREST not reachable at ${postgrestUrl} - start dev/docker-compose.yml`);
  });

  test('logging in through the real form reaches the home screen with a real token', async ({ page }) => {
    await page.goto('/app.html');
    await page.locator('#boot-splash').waitFor({ state: 'hidden' });

    await page.locator('#username').fill(TEST_USER.username);
    await page.locator('#password').fill(TEST_USER.password);
    await page.locator('#screen-login .btn.primary').click();

    await page.locator('#screen-home.active').waitFor({ state: 'visible', timeout: 10000 });
    await expect(page.locator('#login-status')).toHaveText('');
  });

  test('wrong password is rejected with the real server error, not stuck spinning', async ({ page }) => {
    await page.goto('/app.html');
    await page.locator('#boot-splash').waitFor({ state: 'hidden' });

    await page.locator('#username').fill(TEST_USER.username);
    await page.locator('#password').fill('definitely-wrong');
    await page.locator('#screen-login .btn.primary').click();

    await expect(page.locator('#login-status')).not.toHaveText('', { timeout: 10000 });
    await expect(page.locator('#screen-login')).toHaveClass(/active/);
  });

  test('a full debug rowing session saves through the real API and is retrievable', async ({ page, request }) => {
    test.setTimeout(60000);

    // Login for real first, then switch into the debug BLE/rowing sim -
    // ui.token from the real login is what makes onWorkoutSave() below
    // take the online branch (Api.saveWorkout) instead of the offline one.
    await page.goto('/app.html?debug=true');
    await page.locator('#boot-splash').waitFor({ state: 'hidden' });
    await page.locator('#username').fill(TEST_USER.username);
    await page.locator('#password').fill(TEST_USER.password);
    await page.locator('#screen-login .btn.primary').click();
    await page.locator('#screen-home.active').waitFor({ state: 'visible', timeout: 10000 });

    const tokenBefore = await page.evaluate(() => window.ui && window.ui.token);
    expect(tokenBefore).toBeTruthy();

    await page.locator('#tbar-scan-btn').click();
    await page.locator('.device-item').first().click();
    await page.locator('#screen-rowing.active').waitFor({ state: 'visible' });
    await expect(page.locator('#spm')).not.toHaveText('0', { timeout: 4000 });

    await page.locator('#pauseDialog.visible').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('#pauseDialog .ftms-btn.primary').click(); // SAVE

    await page.locator('#post-workout.visible').waitFor({ state: 'visible', timeout: 10000 });
    await expect(page.locator('#pw-title')).toHaveText('WORKOUT SAVED');
    await expect(page.locator('#pw-subtitle')).toHaveText('synced to your account');
    // Logged-in save -> the WORKOUTS shortcut has somewhere to go.
    await expect(page.locator('#pw-workouts-btn')).toBeVisible();

    // Confirm it is not just a UI claim: list_workouts() against the same
    // token must show a real, newly created row with plausible values.
    const token = await page.evaluate(() => window.ui && window.ui.token);
    const listRes = await request.post(`${postgrestUrl}/rpc/list_workouts`, { data: { token } });
    const workouts = await listRes.json();
    expect(workouts.length).toBeGreaterThan(0);

    const latest = workouts[0];
    expect(latest.distance_m).toBeGreaterThan(0);
    expect(latest.total_strokes).toBeGreaterThan(0);
    expect(latest.workout_id).toMatch(/^workout_\d{14}_[0-9a-f]{12}$/);
  });
});
