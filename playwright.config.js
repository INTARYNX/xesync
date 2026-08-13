// =====================================================================
// playwright.config.js
//
// Two independent builds of app.html are served, each with a different
// config.js apiBaseUrl baked in (see tests/e2e/build-app.js):
//
//   client         - apiBaseUrl points at an address nothing listens on.
//                     Every spec here runs with ?debug=true&offline=true,
//                     which never calls Api.* at all - the unreachable
//                     URL is a tripwire, not a dependency: if a future
//                     test regresses into a real network call, it fails
//                     loudly instead of quietly hitting production.
//   db-integration - apiBaseUrl points at the local PostgREST from
//                     dev/docker-compose.yml. Requires that stack running
//                     (`podman compose -f dev/docker-compose.yml up -d`);
//                     specs skip themselves if it's unreachable rather
//                     than failing the whole run.
//
// See tests/e2e/README.md for the full local workflow.
// =====================================================================

const { defineConfig, devices } = require('@playwright/test');

const CLIENT_PORT = 4173;
const DB_PORT = 4174;
const DB_API_BASE_URL = process.env.DEV_POSTGREST_URL || 'http://localhost:3001';

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  // Each rowing-session test runs a real WebGL context (rowing_display.js).
  // Confirmed by hand: run alone, debug_sim's first packet lands with
  // nonzero spm/watts immediately; run under 2+ parallel workers, Chromium
  // logs "GPU stall due to ReadPixels" and setInterval-driven debug_sim
  // ticks fall far enough behind to blow through 8s budgets. Serial
  // execution costs wall-clock time, not correctness - worth it over a
  // suite that fails depending on how many workers happened to be busy.
  workers: 1,

  projects: [
    {
      name: 'client',
      testMatch: /(?<!\.db)\.spec\.js$/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${CLIENT_PORT}` }
    },
    {
      name: 'db-integration',
      testMatch: /\.db\.spec\.js$/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${DB_PORT}` }
    }
  ],

  webServer: [
    {
      // Separate --out-dir per project: both webServer entries start
      // concurrently, and a shared build directory would race two builds
      // with different apiBaseUrl values against the same file.
      command: `node tests/e2e/build-app.js --api-base-url=http://127.0.0.1:1 --out-dir=tests/e2e/.build/client && node tests/e2e/static-server.js`,
      env: { PORT: String(CLIENT_PORT), BUILD_DIR: 'tests/e2e/.build/client' },
      port: CLIENT_PORT,
      reuseExistingServer: false,
      timeout: 30000
    },
    {
      command: `node tests/e2e/build-app.js --api-base-url=${DB_API_BASE_URL} --out-dir=tests/e2e/.build/db && node tests/e2e/static-server.js`,
      env: { PORT: String(DB_PORT), BUILD_DIR: 'tests/e2e/.build/db' },
      port: DB_PORT,
      reuseExistingServer: false,
      timeout: 30000
    }
  ]
});
