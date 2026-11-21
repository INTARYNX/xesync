// =====================================================================
// helpers.js - shared driving code for app.html's debug/offline flow.
//
// ?debug=true&offline=true skips real BLE and real login entirely:
// Debug.fakeScan/fakeConnect stand in for the native bridge, and
// goOffline() drops straight to the scan screen with no server call.
// That is what makes these specs runnable with zero backend - see
// controller.js's init() and goOffline().
// =====================================================================

'use strict';

async function boot(page) {
  await page.goto('/app.html?debug=true&offline=true');
  await page.locator('#boot-splash').waitFor({ state: 'hidden' });
}

// For tests targeting the login/register screens themselves: offline=true
// jumps straight past login to the scan screen (controller.js's
// goOffline()), so it can't be used here. Plain ?debug=true has nothing
// that auto-navigates - app.html's own bridge.js (unlike the Capacitor
// bridge) never fires an autoLogin event on load, so nothing calls
// Api.validateToken() and the login screen just sits there, exactly as it
// does for a fresh, logged-out user.
async function bootLogin(page) {
  await page.goto('/app.html?debug=true');
  await page.locator('#boot-splash').waitFor({ state: 'hidden' });
}

// Drives scan -> pick the fake device -> connect -> rowing screen.
// Debug.fakeScan resolves after 1200ms, Debug.fakeConnect after 800ms
// (debug.js) - both real setTimeouts, sped up by the installed fake clock.
//
// The app now lands on the screen that waits for the first stroke, and
// only moves to the rowing screen when the session actually starts. So
// this waits for the rowing screen, which means waiting for the first
// strokes of the simulated session.
async function connectToRower(page) {
  await page.locator('#tbar-scan-btn').click();
  await page.locator('.device-item').waitFor({ state: 'visible' });
  await page.locator('.device-item').first().click();
  await page.locator('#screen-rowing.active').waitFor({ state: 'visible' });
}

// The same drive, but stopping on the screen that waits for the first
// stroke - the one that holds the game's switches.
//
// The simulator is silenced on the way in: it would otherwise start
// rowing within a couple of seconds and take the app to the rowing
// screen, and the session would start under the test's feet.
async function connectToReady(page) {
  await page.evaluate(() => { if (window.Debug) window.Debug.startSim = function () {}; });
  await page.locator('#tbar-scan-btn').click();
  await page.locator('.device-item').waitFor({ state: 'visible' });
  await page.locator('.device-item').first().click();
  await page.locator('#screen-ready.active').waitFor({ state: 'visible' });
}

// Lets the simulated session begin: from here the app moves to the
// rowing screen.
async function startSimulatedSession(page) {
  await page.evaluate(() => { window.DebugSim.reset(); window.DebugSim.start(); });
  await page.locator('#screen-rowing.active').waitFor({ state: 'visible' });
}

module.exports = { boot, bootLogin, connectToRower, connectToReady, startSimulatedSession };
