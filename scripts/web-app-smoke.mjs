#!/usr/bin/env node
// The built ALP web app in a real browser (ALPD §62 step 9): alpd in this process, with scripted agents,
// serves dist/web-app; headless Chrome opens it with the token, the app connects and shows its sidebar,
// ALP's plugin registers, and nothing breaks the page's CSP. Playwright comes from the Paseo checkout
// the app was built in ($ALP_PASEO_SRC or .cache/paseo-web). The app takes a minute to start headless.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(process.env.ALP_PASEO_SRC ?? path.join(root, '.cache/paseo-web'));
const { chromium } = await import(pathToFileURL(path.join(source, 'node_modules/playwright/index.mjs')).href);
const { createAlpRuntime } = await import(pathToFileURL(path.join(root, 'dist/runtime/index.js')).href);
const { createDaemonServer, createPaseoBridge, createWebServer, webAppDir } = await import(pathToFileURL(path.join(root, 'dist/daemon/index.js')).href);
const { initProject } = await import(pathToFileURL(path.join(root, 'packages/core/src/init.js')).href);
const { fakeTransport } = await import(pathToFileURL(path.join(root, 'test/support/fake-agent.js')).href);

const dir = webAppDir(path.join(root, 'dist/alpd.js'));
if (!dir) throw new Error('dist/web-app is not built: node scripts/build-paseo-web.mjs');
const directory = await mkdtemp(path.join(tmpdir(), 'alp-web-smoke-'));
const home = path.join(directory, 'home');
await initProject(path.join(directory, 'project'));
const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport([]), supervisor: false, libraryDir: home });
const daemon = createDaemonServer({ runtime, socketPath: '', version: 'smoke' });
let web;
const gateway = createPaseoBridge({ daemon, version: 'smoke', home, token: () => web.token, serverId: () => web.serverId });
web = createWebServer({ home, port: 0, app: { dir, gateway } });
const info = await web.listen();
const started = Date.now();
const log = message => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${message}`);
const browser = await chromium.launch({ headless: true, channel: process.env.ALP_SMOKE_BROWSER ?? 'chrome' });
const problems = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', message => {
    const text = message.text();
    if (/Content Security Policy|\[Plugins\] Failed|Refused to/.test(text)) problems.push(text);
  });
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  await page.goto(`${info.url}#token=${info.token}`, { timeout: 180_000 });
  log('page loaded');
  // A new home has no projects yet: the start page offers to add one.
  await page.getByText('Add a project').first().waitFor({ timeout: 300_000 }).catch(async error => {
    if (process.env.ALP_SMOKE_SHOT) await page.screenshot({ path: process.env.ALP_SMOKE_SHOT });
    throw error;
  });
  log('connected: the start page shows');
  if (await page.title() !== 'ALP') problems.push(`the title is "${await page.title()}", not ALP`);
  if (page.url().includes('token=')) problems.push('the token stayed in the address');
  const plugin = await page.evaluate(() => typeof window.__ALP_PLUGINS__?.['alp-provider']);
  if (plugin !== 'function') problems.push(`ALP's plugin did not register (${plugin})`);
  log('ALP plugin registered');
} finally {
  await browser.close();
  await web.close();
  await runtime.shutdown();
  await rm(directory, { recursive: true, force: true });
}
if (problems.length) {
  console.error(`The ALP web app failed its smoke test:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
log('ALP web app smoke test passed');
