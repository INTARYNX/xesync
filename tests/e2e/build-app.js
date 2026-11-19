// =====================================================================
// build-app.js - test-only equivalent of deploy.ps1's inlining step.
//
// Playwright drives the real DOM/JS, but with #screen-rowing empty until
// build time: app.html has a `<!-- ROWING_DISPLAY -->` placeholder, and
// controller.js's enterRowing() calls initRowing() unconditionally - that
// function only exists once rowing_display.html/js are inlined. Testing
// the raw source directly would throw a ReferenceError on the very first
// screen transition and never reach the code these tests exist to cover.
//
// This reproduces exactly the inlining deploy.ps1 does (rowing_display's
// CSS/JS into <head>/the marker, then app.html's own <link>/<script src>
// tags) so tests run against the same DOM shape production ships - just
// without deploy.ps1's SCP/SSH/git-push side effects, which have no
// business running from a test suite.
//
// Output goes to tests/e2e/.build/, never dist/ - that directory is
// deploy.ps1's own, and this script must not touch it.
//
// It also patches three config.js values before inlining:
//
// - apiBaseUrl - overridden per project (see playwright.config.js), so tests
//   never depend on whatever happens to be in the committed config.js.
// - apexHomeUrl - always forced to about:blank. The real value points at
//   production, and showHome() sets it as an <iframe src> directly; without
//   this override, a successful login in a test would fetch the live site.
// - renderMode - forced to 'phases' unless the caller says otherwise. The
//   real rowing scene is a ~900-line GLSL fragment shader; without a GPU
//   (CI, a container, a software rasterizer) it is expensive enough to
//   starve the event loop, and the page then stops answering Playwright's
//   queries - the spec times out waiting for a screen that is, in fact,
//   already there. The 'phases' renderer keeps the whole stroke cycle
//   (tracker, pose track, surge, drive fraction) and drops only the
//   rasterization. APP_RENDER_MODE=webgl restores the real scene on a
//   machine that has a GPU.
//
// Usage:  node tests/e2e/build-app.js [--api-base-url=<url>] [--render-mode=<phases|webgl>]
// =====================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function resolveSrc(base, src) {
  if (/^https?:\/\//i.test(src)) throw new Error('remote <script src> not supported in test build: ' + src);
  return path.join(base, src);
}

function inlineLinks(html, base) {
  return html.replace(/<link[^>]*href=['"]([^'"]+\.css)['"][^>]*>/gi, (_, href) => {
    const css = readUtf8(resolveSrc(base, href));
    return `<style>\n${css}\n</style>`;
  });
}

function inlineScripts(html, base) {
  return html.replace(/<script([^>]*)\s+src=['"]([^'"]+)['"][^>]*>\s*<\/script>/gi, (_, attrs, src) => {
    const js = readUtf8(resolveSrc(base, src));
    return `<script${attrs}>\n${js}\n</script>`;
  });
}

// Each Playwright project builds with a different apiBaseUrl and must be
// served from its own directory - two webServer entries run concurrently
// (Playwright starts all of them in parallel), so a single shared output
// path would race two builds writing the same file with different config
// baked in, and whichever finished last would silently win for both ports.
function build(apiBaseUrl, outDir, homeUrl, renderMode) {
  // The default is 'phases' (see the header): a test build that needs a
  // GPU is a test build that times out on a machine without one.
  renderMode = renderMode || 'phases';
  // -- rowing_display.html: CSS -> <style> list, JS inlined, body extracted --
  let rd = readUtf8(path.join(ROOT, 'rowing_display.html'));
  const styles = [];
  rd = rd.replace(/<link[^>]*href=['"]([^'"]+)['"][^>]*>/gi, (_, href) => {
    styles.push(`<style>\n${readUtf8(resolveSrc(ROOT, href))}\n</style>`);
    return '';
  });
  rd = inlineScripts(rd, ROOT);

  const bodyMatch = rd.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) throw new Error('Could not find <body> in rowing_display.html');
  const rowingContent = bodyMatch[1].trim();

  // -- app.html: inject rowing display, then inline its own assets --
  let app = readUtf8(path.join(ROOT, 'app.html'));
  if (!app.includes('<!-- ROWING_DISPLAY -->')) {
    throw new Error('<!-- ROWING_DISPLAY --> marker not found in app.html');
  }
  app = app.replace('</head>', `${styles.join('\n')}\n</head>`);
  app = app.replace('<!-- ROWING_DISPLAY -->', rowingContent);
  app = inlineLinks(app, ROOT);
  app = inlineScripts(app, ROOT);

  if (apiBaseUrl) {
    const before = app;
    app = app.replace(
      /apiBaseUrl:\s*(['"]).*?\1/,
      `apiBaseUrl: '${apiBaseUrl}'`
    );
    if (app === before) throw new Error('apiBaseUrl override requested but the pattern was not found in config.js');
  }

  // Always overridden, unconditionally: apexHomeUrl points at production
  // (xesync.enlistia.com/home.html) in the real config.js, and showHome()
  // sets it as an <iframe src> directly - a real login flow in a test
  // would otherwise fetch the live production site. about:blank has
  // nothing to fetch.
  {
    const before = app;
    app = app.replace(
      /apexHomeUrl:\s*(['"]).*?\1/,
      `apexHomeUrl: '${homeUrl || 'about:blank'}'`
    );
    if (app === before) throw new Error('apexHomeUrl pattern was not found in config.js');
  }

  // Which renderer the rowing scene uses. Defaults to 'phases' (no GPU
  // needed); APP_RENDER_MODE=webgl puts the real GLSL scene back.
  if (renderMode) {
    const before = app;
    app = app.replace(
      /renderMode:\s*(['"]).*?\1/,
      `renderMode: '${renderMode}'`
    );
    if (app === before) throw new Error('renderMode override requested but the pattern was not found in config.js');
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'app.html'), app, 'utf8');

  for (const asset of ['SpaceGrotesk-Regular.ttf', 'home.html', 'home.css']) {
    const src = path.join(ROOT, asset);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, asset));
  }

  console.log('Built', path.join(outDir, 'app.html'), apiBaseUrl ? `(apiBaseUrl=${apiBaseUrl})` : '',
              renderMode ? `(renderMode=${renderMode})` : '');
}

function argValue(flag, fallback) {
  const hit = process.argv.find((a) => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : fallback;
}

if (require.main === module) {
  build(
    argValue('--api-base-url', process.env.APP_API_BASE_URL || null),
    argValue('--out-dir', path.join(__dirname, '.build')),
    argValue('--home-url', process.env.APP_HOME_URL || null),
    argValue('--render-mode', process.env.APP_RENDER_MODE || 'phases')
  );
}

module.exports = { build };
