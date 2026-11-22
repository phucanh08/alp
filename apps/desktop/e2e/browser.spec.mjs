/**
 * ALP.app's Browser tab (t-9116; docs/alp/desktop.md, Browser tab): the real Electron app opens a scratch
 * host's real `alp dashboard` (this checkout's CLI, a real alpd under a scratch ALP_HOME), and a Browser
 * tab from the workspace's + menu shows a page from a local http server the test runs. It checks what
 * apps/desktop/src/browser.ts promises: the guest lives in persist:alp-browser and cannot read the
 * dashboard's token, storage or cookies; it navigates (top level, frames, redirects) nowhere but http,
 * https and about:blank and never to the dashboard under any local spelling; none of its requests reach
 * the dashboard's port; every permission is denied, downloads are cancelled and devtools stay shut;
 * window.open and target=_blank open Browser tabs, never a window; a <webview> asking for another
 * partition, a file: src or a preload is refused or loses the preload.
 *
 * Nothing touches the user's ~/.alp, alpd or dashboard: HOME, ALP_HOME and TMPDIR are under the test's
 * scratch directory, launchd is never asked, and every Node process the host starts is admitted by
 * test/support/fixture-processes.js. With ALP_DESKTOP_SHOTS=<dir> it saves two screenshots there.
 *
 * Needs `node scripts/build-workspace.mjs cli` and the root npm install; `bun run e2e` runs it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { chmod, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { connect as hostConnect } from '@anhlp/alp-client';
import { fixtureProcesses } from '../../../test/support/fixture-processes.js';
import { APP, cleanEnv, connectedTo, freePort, launch, scratch, waitFor } from './support.mjs';

const ROOT = path.resolve(APP, '..', '..');
const CLI = path.join(ROOT, 'packages/cli/dist/cli.js');
const run = promisify(execFile);

/** A scratch host with alpd and one registered project, and the `alp` wrapper the app runs. */
async function browserHost(context) {
  const { dir, defer } = context;
  const home = path.join(dir, 'h', '.alp');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(path.join(dir, 'ht'), { recursive: true });
  const processes = await fixtureProcesses(home);
  defer(() => processes.stop());
  const bin = path.join(dir, 'hb');
  await mkdir(bin, { recursive: true });
  const project = path.join(dir, 'projects', 'site');
  await mkdir(project, { recursive: true });
  const directory = await realpath(project);
  const env = {
    ...cleanEnv(), ...processes.env,
    HOME: path.dirname(home), TMPDIR: path.join(dir, 'ht'), ALP_LAUNCHCTL: '/usr/bin/false',
    ALP_CODEX_BIN: path.join(dir, 'no-real-codex'), ALP_CLAUDE_BIN: path.join(dir, 'no-real-claude'), ALP_ANTIGRAVITY_BIN: path.join(dir, 'no-real-antigravity'),
  };
  for (const value of [env.ALP_HOME, env.HOME, env.TMPDIR, env.ALP_SERVICE_DIR]) assert.ok(value.startsWith(`${dir}${path.sep}`), `${value} is outside the scratch directory`);
  const port = await freePort();
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ dashboard: { port }, web: { relay: { enabled: false } } }));
  const alp = (...args) => run(process.execPath, [CLI, ...args], { env, timeout: 60_000 });
  await alp('init', directory);
  await alp('daemon', 'start');
  defer(() => alp('daemon', 'stop').catch(() => {}));
  const lock = JSON.parse(await readFile(path.join(home, 'alpd.lock'), 'utf8'));
  assert.ok(lock.ready && lock.socket.startsWith(`${dir}${path.sep}`));
  const client = await hostConnect(lock.socket);
  try {
    const { revision } = await client.request('project.list', {});
    await client.request('project.register', { directory, ifRevision: revision, requestId: 'desktop-browser-site' });
  } finally { client.close(); }
  const wrapper = path.join(bin, 'alp');
  const exports = Object.entries(env).filter(([name]) => /^(ALP_[A-Z0-9_]+|PATH|HOME|TMPDIR|NODE_OPTIONS|USER|LOGNAME|LANG)$/.test(name)).map(([name, value]) => `${name}='${String(value).replaceAll("'", "'\\''")}'`);
  await writeFile(wrapper, `#!/bin/sh\nexec env -i ${exports.join(' ')} '${process.execPath}' '${CLI}' "$@"\n`);
  await chmod(wrapper, 0o755);
  defer(() => alp('dashboard', '--stop').catch(() => {}));
  return { home, directory, wrapper, dir };
}

const PAGE_STYLE = '<style>body{font:16px -apple-system,system-ui,sans-serif;background:#101418;color:#e8edf2;margin:0;padding:40px}h1{font-weight:600}code{color:#8ab4f8}</style>';

/** A local site the Browser tab visits; `hits` counts the requests per path. */
async function localSite(context) {
  const hits = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    hits.push(url.pathname);
    if (url.pathname === '/redirect') { response.writeHead(302, { location: url.searchParams.get('to') ?? '/' }); response.end(); return; }
    if (url.pathname === '/download') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="payload.bin"' }); response.end('payload'); return; }
    const title = url.pathname === '/page2' ? 'Second page' : 'Local page';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>${title}</title>${PAGE_STYLE}<h1 id="title">${title}</h1><p>Served by the test at <code>${url.pathname}</code>, in ALP.app's Browser tab.</p><a id="blank" href="/page2" target="_blank">Open in a new tab</a>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.defer(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}

/** The Browser tab guests: id and address. */
const guests = app => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(contents => contents.getType() === 'webview' && !contents.isDestroyed()).map(contents => ({ id: contents.id, url: contents.getURL() })));
/** Runs `code` in guest `id` (as a user gesture, so window.open and permission prompts are honest). */
const inGuest = (app, id, code) => app.evaluate(({ webContents }, [guest, script]) => webContents.fromId(guest).executeJavaScript(script, true), [id, code]);
const windowCount = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const capture = async (app, file) => {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  await writeFile(file, Buffer.from(png, 'base64'));
};

test('browser: a Browser tab shows a local page and is held to its guards', { timeout: 300_000 }, async t => {
  const context = await scratch(t);
  const host = await browserHost(context);
  const site = await localSite(context);
  const app = await launch(t, context, host.wrapper);
  const info = await waitFor(async () => {
    const value = JSON.parse(await readFile(path.join(host.home, 'dashboard.json'), 'utf8'));
    return value?.port ? value : undefined;
  }, 'alp dashboard to write dashboard.json', 90_000);
  const dashboard = `http://127.0.0.1:${info.port}`;
  await connectedTo(app, dashboard, 90_000);
  const page = app.windows()[0];
  await page.emulateMedia({ colorScheme: 'dark' });
  const shots = process.env.ALP_DESKTOP_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });

  // The marker is in the dashboard window's user agent; the page holds its token.
  assert.match(await page.evaluate(() => navigator.userAgent), /ALPDesktop\/1/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('alp-web:link-token') !== null), true);

  // The + menu offers Browser after Diff.
  await page.getByTestId('project-row').first().waitFor({ timeout: 60_000 });
  const newTab = page.getByRole('button', { name: 'New tab' });
  await newTab.waitFor({ timeout: 60_000 });
  await newTab.click();
  const items = await page.getByRole('menuitem').allInnerTexts();
  assert.deepEqual(items.map(item => item.trim()), ['Agent', 'Terminal', 'Diff', 'Browser', 'Tasks', 'Agents']);
  if (shots) await capture(app, path.join(shots, 'plus-menu-browser.png'));
  await page.getByRole('menuitem', { name: 'Browser' }).click();

  // (1) The tab loads a local http page typed without a scheme (127.x gets http://).
  const address = page.getByTestId('browser-address');
  await address.fill(`${site.origin.replace('http://', '')}/page`);
  await address.press('Enter');
  const pageUrl = `${site.origin}/page`;
  const [guest] = await waitFor(async () => { const list = await guests(app); return list.length === 1 && list[0].url === pageUrl ? list : undefined; }, 'the guest to show the local page');
  assert.equal(await inGuest(app, guest.id, 'document.getElementById("title").textContent'), 'Local page');
  await waitFor(async () => (await page.getByRole('tab', { name: new URL(site.origin).host }).count()) === 1, 'the tab to be labelled with the host');
  await sleep(300);
  if (shots) await capture(app, path.join(shots, 'browser-tab-local-page.png'));

  // (2) Its own partition, and nothing of the dashboard's: no token, storage, cookies, Node or parent.
  const where = await app.evaluate(({ webContents, session }, id) => {
    const contents = webContents.fromId(id);
    const prefs = contents.getLastWebPreferences?.() ?? {};
    return { own: contents.session === session.fromPartition('persist:alp-browser'), shared: contents.session === session.defaultSession, preload: prefs.preload ?? null, sandbox: prefs.sandbox, isolation: prefs.contextIsolation, node: prefs.nodeIntegration };
  }, guest.id);
  assert.deepEqual(where, { own: true, shared: false, preload: null, sandbox: true, isolation: true, node: false });
  const seen = await inGuest(app, guest.id, `JSON.stringify({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie, top: window.top === window, parent: window.parent === window, require: typeof require, process: typeof process, token: document.documentElement.outerHTML.includes('alpgw1') || location.href.includes('token') })`);
  assert.deepEqual(JSON.parse(seen), { local: 0, session: 0, cookie: '', top: true, parent: true, require: 'undefined', process: 'undefined', token: false });

  // (3) Navigation, top level and redirects: only http/https/about:blank, never the dashboard in any spelling.
  const hostname = os.hostname().toLowerCase();
  const bare = hostname.replace(/\.local$/, '');
  const dashboardSpellings = [
    `http://127.0.0.1:${info.port}/`, `http://localhost:${info.port}/`, `http://[::1]:${info.port}/`, `http://0.0.0.0:${info.port}/`,
    `http://127.0.0.2:${info.port}/`, `http://2130706433:${info.port}/`, `http://[::ffff:127.0.0.1]:${info.port}/`,
    `http://${bare}:${info.port}/`, `http://${bare}.local:${info.port}/`,
  ];
  // Each failed load and each redirect the guest follows, as the main process sees them. The request
  // guard fails a load with -20 (ERR_BLOCKED_BY_CLIENT); a navigation the navigation guard prevents
  // never gets that far, so this tells the two guards apart (either would leave the page in place).
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    globalThis.browserProbe = { failed: [], redirects: [] };
    contents.on('did-fail-load', (_event, code, _description, url) => globalThis.browserProbe.failed.push({ code, url }));
    contents.on('did-redirect-navigation', details => globalThis.browserProbe.redirects.push(details.url));
  }, guest.id);
  const probeLog = () => app.evaluate(() => globalThis.browserProbe);
  const blocked = ['file:///etc/hosts', 'data:text/html,<p>x</p>', 'chrome://version', 'devtools://devtools/bundled/inspector.html', ...dashboardSpellings, `${site.origin}/redirect?to=${encodeURIComponent(`http://localhost:${info.port}/`)}`];
  for (const target of blocked) {
    await inGuest(app, guest.id, `location.href = ${JSON.stringify(target)}; 'ok'`).catch(() => undefined);
    await sleep(400);
    const now = (await guests(app)).find(entry => entry.id === guest.id)?.url;
    assert.equal(now, pageUrl, `navigation to ${target} was not blocked (guest at ${now})`);
  }
  const log = await probeLog();
  assert.deepEqual(log.failed.filter(entry => entry.code === -20), [], 'a navigation reached the request guard: the navigation guard did not stop it');
  assert.ok(log.redirects.every(url => !url.includes(`:${info.port}`)), `a redirect to the dashboard was followed: ${log.redirects}`);
  // blob: top level too.
  await inGuest(app, guest.id, `location.href = URL.createObjectURL(new Blob(['<p>x</p>'], { type: 'text/html' })); 'ok'`).catch(() => undefined);
  await sleep(400);
  assert.equal((await guests(app))[0].url, pageUrl, 'a blob: page was not blocked');
  // Frames: an iframe pointed at the dashboard never shows it.
  await inGuest(app, guest.id, `const f = document.createElement('iframe'); f.id = 'probe'; f.src = ${JSON.stringify(`http://localhost:${info.port}/`)}; document.body.append(f); 'ok'`);
  await sleep(800);
  const frames = await app.evaluate(({ webContents }, id) => webContents.fromId(id).mainFrame.frames.map(frame => ({ url: frame.url, origin: frame.origin })), guest.id);
  assert.ok(!frames.some(frame => frame.origin === `http://localhost:${info.port}`), JSON.stringify(frames));
  // Loads the dashboard page starts itself (webview.loadURL, as an XSS there could) emit no
  // will-navigate: they are stopped when they start, and file: is refused by the partition.
  for (const target of ['file:///etc/hosts', 'chrome://version', 'devtools://devtools/bundled/inspector.html', `http://localhost:${info.port}/`, `http://[::1]:${info.port}/`, 'data:text/html,<p>x</p>']) {
    await page.evaluate(url => document.querySelector('[data-testid="browser-webview"]').loadURL(url).catch(() => undefined), target);
    await sleep(600);
    const now = (await guests(app)).find(entry => entry.id === guest.id)?.url;
    assert.equal(now, pageUrl, `a load of ${target} from the dashboard page was not stopped (guest at ${now})`);
  }
  assert.equal(await inGuest(app, guest.id, 'document.getElementById("title")?.textContent ?? null'), 'Local page');
  // The address bar refuses file: and says why; the dashboard's address is refused by the main process.
  await address.fill('file:///etc/hosts');
  await address.press('Enter');
  assert.match(await page.getByTestId('browser-error').innerText(), /only http and https/);
  await address.fill(`localhost:${info.port}`);
  await address.press('Enter');
  await waitFor(async () => /blocked/.test(await page.getByTestId('browser-error').innerText().catch(() => '')), 'the address bar to say the dashboard is blocked');
  assert.equal((await guests(app))[0].url, pageUrl);

  // (4) Requests: fetch, XHR and WebSocket to the dashboard's port are cancelled by onBeforeRequest
  // (no-cors fetch resolves whenever a request went out; the control request to the site does).
  const probe = target => inGuest(app, guest.id, `fetch(${JSON.stringify(target)}, { mode: 'no-cors' }).then(() => 'sent', () => 'blocked')`);
  assert.equal(await probe(`${site.origin}/control`), 'sent');
  for (const target of dashboardSpellings.slice(0, 7)) assert.equal(await probe(`${target}v1/tickets`), 'blocked', target);
  const xhr = await inGuest(app, guest.id, `new Promise(resolve => { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(`http://127.0.0.1:${info.port}/`)}); x.onload = () => resolve('loaded'); x.onerror = () => resolve('blocked'); x.send(); })`);
  assert.equal(xhr, 'blocked');
  const socket = await inGuest(app, guest.id, `new Promise(resolve => { const s = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${info.port}/`)}); s.onopen = () => resolve('open'); s.onerror = () => resolve('blocked'); })`);
  assert.equal(socket, 'blocked');

  // (5) Permissions are denied; devtools stay shut; downloads are cancelled.
  assert.equal(await inGuest(app, guest.id, 'Notification.requestPermission()'), 'denied');
  // The dashboard page may show notifications (t-0166); its Browser tabs still may not.
  assert.equal(await inGuest(app, guest.id, 'Notification.permission'), 'denied');
  assert.equal(await inGuest(app, guest.id, "navigator.permissions.query({ name: 'notifications' }).then(s => s.state)"), 'denied');
  assert.equal(await inGuest(app, guest.id, `navigator.permissions.query({ name: 'geolocation' }).then(s => s.state)`), 'denied');
  assert.equal(await inGuest(app, guest.id, `navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', () => 'denied')`), 'denied');
  assert.equal(await inGuest(app, guest.id, `navigator.clipboard.readText().then(() => 'granted', () => 'denied')`), 'denied');
  const devtools = await app.evaluate(async ({ webContents }, id) => { const contents = webContents.fromId(id); contents.openDevTools(); await new Promise(resolve => setTimeout(resolve, 500)); return contents.isDevToolsOpened(); }, guest.id);
  assert.equal(devtools, false);
  await inGuest(app, guest.id, `location.href = '/download'; 'ok'`);
  await waitFor(() => site.hits.includes('/download'), 'the download request');
  await sleep(800);
  const downloads = path.join(context.dir, 'app-home', 'Downloads');
  assert.deepEqual(await readdir(downloads).catch(() => []), [], 'nothing was downloaded');
  assert.equal((await guests(app))[0].url, pageUrl);

  // (6) window.open and target=_blank: new Browser tabs in the workspace, never a window.
  await inGuest(app, guest.id, `window.open(${JSON.stringify(`${site.origin}/page2`)}); 'ok'`);
  await waitFor(async () => (await page.locator('[data-tab^="browser:"]').count()) === 2, 'a second Browser tab');
  await waitFor(async () => (await guests(app)).some(entry => entry.url === `${site.origin}/page2`), 'the new tab to show page2');
  assert.equal(await windowCount(app), 1);
  // A window.open to the dashboard is refused outright.
  const [second] = (await guests(app)).filter(entry => entry.url === `${site.origin}/page2`);
  await inGuest(app, second.id, `window.open(${JSON.stringify(`http://localhost:${info.port}/`)}); window.open('file:///etc/hosts'); 'ok'`);
  await inGuest(app, second.id, `document.getElementById('blank').click(); 'ok'`);
  await waitFor(async () => (await page.locator('[data-tab^="browser:"]').count()) === 3, 'a third Browser tab from target=_blank');
  await sleep(500);
  assert.equal(await page.locator('[data-tab^="browser:"]').count(), 3);
  assert.equal(await windowCount(app), 1);

  // (7) A <webview> the page makes itself: another partition, no partition or a file: src is refused;
  // a preload is dropped (the preload would mark the document).
  const preload = path.join(context.dir, 'preload.js');
  await writeFile(preload, "window.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.preloaded = 'yes'; });\n");
  const before = (await guests(app)).length;
  const attach = (attributes, testId) => page.evaluate(([attrs, id]) => {
    const view = document.createElement('webview');
    for (const [name, value] of Object.entries(attrs)) view.setAttribute(name, value);
    view.dataset.probe = id;
    view.style.cssText = 'position:fixed;width:10px;height:10px;bottom:0;right:0';
    document.body.append(view);
  }, [attributes, testId]);
  await attach({ src: `${site.origin}/page` }, 'default');
  await attach({ src: `${site.origin}/page`, partition: 'persist:other' }, 'other');
  await attach({ src: 'file:///etc/hosts', partition: 'persist:alp-browser' }, 'file');
  await sleep(1500);
  assert.equal((await guests(app)).length, before, 'a webview outside persist:alp-browser or with a file: src was attached');
  await attach({ src: `${site.origin}/page?preload`, partition: 'persist:alp-browser', preload: `file://${preload}` }, 'preload');
  const preloaded = await waitFor(async () => (await guests(app)).find(entry => entry.url === `${site.origin}/page?preload`), 'the webview with a preload attribute');
  await sleep(500);
  assert.equal(await inGuest(app, preloaded.id, 'document.documentElement.dataset.preloaded ?? null'), null, 'the preload ran');
  const forced = await app.evaluate(({ webContents, session }, id) => {
    const contents = webContents.fromId(id);
    return { own: contents.session === session.fromPartition('persist:alp-browser'), preload: contents.getLastWebPreferences?.()?.preload ?? null };
  }, preloaded.id);
  assert.deepEqual(forced, { own: true, preload: null });
  await page.evaluate(() => { for (const view of document.querySelectorAll('webview[data-probe]')) view.remove(); });
  assert.equal(await windowCount(app), 1);

  // (8) t-0166: ⌘W pressed in a Browser tab's page closes that tab (the dashboard's key), not the
  // window; ⌘C stays the page's.
  if (process.platform === 'darwin') {
    const tabsBefore = await page.locator('[data-tab^="browser:"]').count();
    const shown = await waitFor(async () => {
      const ids = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(contents => contents.getType() === 'webview' && !contents.isDestroyed()).map(contents => contents.id));
      return ids.at(-1);
    }, 'a Browser tab guest');
    await inGuest(app, shown, "window.__keys = []; window.addEventListener('keydown', e => window.__keys.push(e.code)); 'ok'");
    const pressIn = (code, keyCode) => app.evaluate(({ webContents }, [id, key]) => {
      const contents = webContents.fromId(id);
      contents.focus();
      contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['meta'] });
      contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['meta'] });
    }, [shown, keyCode]);
    await pressIn('KeyC', 'C');
    await waitFor(async () => (await inGuest(app, shown, 'window.__keys.join()')).includes('KeyC'), 'the page to get ⌘C');
    await pressIn('KeyW', 'W');
    await waitFor(async () => (await page.locator('[data-tab^="browser:"]').count()) === tabsBefore - 1, 'the Browser tab to close');
    assert.equal(await windowCount(app), 1);
  }
});
