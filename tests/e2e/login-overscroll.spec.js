// =====================================================================
// login-overscroll.spec.js - regression test for the "content slides
// vertically even though everything fits" bug on the login screen.
//
// Root cause (app.css) was two things at once:
//   1. no overscroll-behavior anywhere, so the elastic "rubber band" drag
//      still fires on a scroll container even when its content fits
//      entirely on screen;
//   2. `height: 100vh` on body, which is the viewport WITHOUT the soft
//      keyboard - once a login/password field is focused the real
//      viewport shrinks and 100vh no longer matches it.
//
// Elastic bounce itself is a mobile compositor effect Chromium headless
// doesn't reproduce, so this asserts the two structural preconditions
// instead: overscroll-behavior is actually set, and the screen has
// nothing to scroll in the first place at a normal viewport size.
// =====================================================================

const { test, expect } = require('@playwright/test');
const { bootLogin } = require('./helpers');
const boot = bootLogin;

test.describe('login screen does not slide', () => {
  test('overscroll-behavior is none on html, body, and the login screen', async ({ page }) => {
    await boot(page);

    const overscroll = async (selector) =>
      page.locator(selector).evaluate((el) => getComputedStyle(el).overscrollBehaviorY);

    expect(await overscroll('html')).toBe('none');
    expect(await overscroll('body')).toBe('none');
    expect(await overscroll('#screen-login')).toBe('none');
  });

  test('login screen content fits without needing to scroll', async ({ page }) => {
    await boot(page);
    const login = page.locator('#screen-login');

    const { scrollHeight, clientHeight } = await login.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    }));

    // A pixel or two of slack for subpixel layout rounding; anything more
    // means the screen has real overflow and a rubber-band drag would have
    // something to slide.
    expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 2);
  });

  test('register screen also fits without scrolling', async ({ page }) => {
    // Same overflow-y:auto pattern as login (app.html inline style), same
    // bug class - covered separately since it's a different screen element.
    await boot(page);
    await page.locator('button:has-text("CREATE ACCOUNT")').click();
    const register = page.locator('#screen-register');
    await expect(register).toHaveClass(/active/);

    const { scrollHeight, clientHeight } = await register.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    }));
    expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 2);
  });

  test('body height tracks the real viewport (dvh), not the pre-keyboard 100vh', async ({ page }) => {
    await boot(page);
    const diff = await page.evaluate(() => Math.abs(document.body.clientHeight - window.innerHeight));
    expect(diff).toBeLessThanOrEqual(1);
  });
});
