// Browser checks execute main.tsx's real listeners and the rendered controls, not source patterns.
import { chromium, expect, test } from '@playwright/test';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { closeWorldAfter } from './support/cleanup.js';
import { freePort, startWorld } from './support/world.js';

let world, url, origin;
const tokenKey = 'alp-web:link-token';
const form = page => page.getByLabel('Access token');
const connected = page => page.getByRole('navigation', { name: 'Workspaces and sessions' });
const kept = page => page.evaluate(key => sessionStorage.getItem(key) !== null, tokenKey);

test.beforeAll(async () => {
  world = await startWorld({ gateway: false, serveWeb: false, settings: { web: { port: await freePort(), relay: { enabled: false } } } });
  world.env.ALP_SUPERVISE = '0';
  delete world.env.ALP_WEB_APP;
  url = (await world.alp('web', '--print')).trim();
  origin = new URL(url).origin;
});
test.afterAll(async () => {
  if (!world) return;
  await closeWorldAfter(world, async () => {
    const info = JSON.parse(await readFile(path.join(world.home, 'web.json'), 'utf8'));
    try { process.kill(info.pid, 'SIGTERM'); } catch {}
    await expect.poll(() => { try { process.kill(info.pid, 0); return true; } catch { return false; } }).toBe(false);
  });
});

test('valid old token then malformed new link and reload never reuses the old credential', async ({ page }) => {
  await page.goto(url);
  await expect(connected(page)).toBeVisible();
  expect(await kept(page)).toBe(true);
  await page.goto(`${origin}/?damaged=1#token=damaged`);
  await expect(page.getByRole('alert')).toHaveText(/incomplete or damaged/);
  expect(new URL(page.url()).hash).toBe('');
  expect.soft(await kept(page)).toBe(false);
  await page.reload();
  await expect(form(page)).toBeVisible();
  await expect(connected(page)).toHaveCount(0);
});

test('nonloopback link clears an old credential in that origin tab storage', async ({ page }) => {
  // Serve the exact built document/assets under a nonloopback browser URL without DNS or exposure.
  const old = new URL(url).hash.slice('#token='.length);
  await page.route('http://alp.invalid/**', async route => {
    const target = new URL(route.request().url());
    const response = await fetch(`${origin}${target.pathname}${target.search}`);
    await route.fulfill({ status: response.status, headers: { 'content-type': response.headers.get('content-type') }, body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.goto('http://alp.invalid/');
  await page.evaluate(({ key, token }) => sessionStorage.setItem(key, token), { key: tokenKey, token: old });
  await page.goto(`http://alp.invalid/?new=1#token=${old}`);
  await expect(page.getByRole('alert')).toHaveText(/not on this machine/);
  expect.soft(await kept(page)).toBe(false);
  await page.reload();
  await expect(form(page)).toBeVisible();
  expect(await kept(page)).toBe(false);
});

test('daemon restart leaves alp-web in charge of its listener and creates no standalone gateway', async ({ page }) => {
  const service = JSON.parse(await readFile(path.join(world.home, 'web.json'), 'utf8'));
  await page.goto(url);
  await expect(connected(page)).toBeVisible();
  await world.restartDaemon();
  await expect(connected(page)).toBeVisible();
  const after = JSON.parse(await readFile(path.join(world.home, 'web.json'), 'utf8'));
  expect(after.pid).toBe(service.pid);
  expect((await fetch(origin)).ok).toBe(true);
  expect(await fetch(world.gatewayUrl).then(() => true, () => false)).toBe(false);
  await page.reload();
  await expect(connected(page)).toBeVisible();
});

test('Use another access token cancels retries, forgets the link and stays on the form after reload', async ({ page }) => {
  await page.route('**/v1/tickets', route => route.abort());
  await page.goto(url);
  await page.getByRole('button', { name: 'Use another access token' }).click();
  await expect(form(page)).toBeVisible();
  expect(await kept(page)).toBe(false);
  await page.unroute('**/v1/tickets');
  await page.reload();
  await expect(form(page)).toBeVisible();
  await expect(connected(page)).toHaveCount(0);
});

test('synthetic persisted pageshow reconnects after pagehide; ordinary pageshow does not', async ({ page }) => {
  let tickets = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/v1/tickets') tickets++; });
  await page.goto(url);
  await expect(connected(page)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(form(page)).toBeVisible();
  expect(await kept(page)).toBe(true);
  const before = tickets;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })));
  await expect(form(page)).toBeVisible();
  expect(tickets).toBe(before);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(connected(page)).toBeVisible();
  expect(tickets).toBeGreaterThan(before);
});

test('genuine browser back-forward cache restores the document and reconnects', async () => {
  test.setTimeout(30_000);
  // Playwright disables bfcache by default; headless-shell also disables it at its delegate.
  // Full Chromium with the disable argument removed exercises a genuine browser restore.
  const browser = await chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  const away = http.createServer((_, response) => { response.end('<!doctype html><title>Away</title>away'); });
  let context;
  try {
    await new Promise((resolve, reject) => { away.once('error', reject); away.listen(0, '127.0.0.1', resolve); });
    context = await browser.newContext();
    const page = await context.newPage();
    let tickets = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/v1/tickets') tickets++; });
    await page.addInitScript(() => {
      window.__documentId = crypto.randomUUID();
      window.__shows = [];
      window.addEventListener('pageshow', event => window.__shows.push(event.persisted));
    });
    await page.goto(url);
    await expect(connected(page)).toBeVisible();
    const id = await page.evaluate(() => window.__documentId);
    const before = tickets;
    await page.goto(`http://127.0.0.1:${away.address().port}/`);
    // bfcache restoration emits pageshow rather than a fresh document load.
    await page.goBack({ waitUntil: 'commit', timeout: 10_000 });
    await expect(connected(page)).toBeVisible();
    const restored = await page.evaluate(() => ({ id: window.__documentId, shows: window.__shows }));
    // A reload that happens to reconnect is not evidence of a bfcache restore.
    expect(restored.id).toBe(id);
    expect(restored.shows).toEqual([false, true]);
    await expect.poll(() => tickets).toBeGreaterThan(before);
    expect(await kept(page)).toBe(true);
  } finally {
    try { await context?.close(); } finally {
      try { await browser.close(); } finally {
        await new Promise(resolve => { away.close(resolve); away.closeAllConnections(); });
      }
    }
  }
});
