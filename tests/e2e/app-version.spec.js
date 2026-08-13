// =====================================================================
// app-version.spec.js - the login screen shows XESYNC_CONFIG.appVersion.
//
// Regression target: config.js's appVersion and
// capacitor/android/app/build.gradle's versionName are two separate
// strings with no build-time link between them - this only proves the
// config value renders, not that it matches the APK. See the
// versionName comment in build.gradle for the "bump both" rule this
// can't enforce.
// =====================================================================

const { test, expect } = require('@playwright/test');
const { bootLogin } = require('./helpers');

test('login screen shows the configured app version', async ({ page }) => {
  await bootLogin(page);
  await expect(page.locator('#app-version')).toHaveText(/^v\d+\.\d+/);
  const [displayed, configured] = await Promise.all([
    page.locator('#app-version').textContent(),
    page.evaluate(() => window.XESYNC_CONFIG.appVersion)
  ]);
  expect(displayed).toBe('v' + configured);
});
