import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Each spec starts its own disposable host (e2e/support/world.js): alpd with a fake Codex in a
// temporary home, alp-gateway, and the built app on free loopback ports. `npm run test:e2e` builds
// them first (pretest:e2e); a direct `npx playwright test` does not (see docs/alp/web.md).
export default defineConfig({
  testDir: 'e2e',
  // Traces and screenshots of failures; CI points this at a directory it uploads.
  outputDir: process.env.ALP_WEB_PLAYWRIGHT_OUTPUT ?? path.join(os.tmpdir(), 'alp-web-playwright'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: path.join(os.tmpdir(), 'alp-web-playwright-report') }]] : 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 15_000 },
  projects: [
    { name: 'desktop', testIgnore: /mobile\.spec\.js/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', testMatch: /mobile\.spec\.js/, use: { ...devices['Pixel 7'] } },
  ],
});
