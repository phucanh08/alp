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
 * test/support/fixture-processes.ts. With ALP_DESKTOP_SHOTS=<dir> it saves two screenshots there.
 *
 * Needs `node scripts/build-workspace.ts cli` and the root npm install; `bun run e2e` runs it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ElectronApplication } from 'playwright-core';
import { connect as hostConnect } from '@anhlp/alp-client';
import { fixtureProcesses } from '../../../test/support/fixture-processes.ts';
import { APP, bounded, cleanEnv, connectedTo, freePort, launch, scratch, waitFor } from './support.ts';
import type { App, Context, WebContentsLike } from './support.ts';

const ROOT = path.resolve(APP, '..', '..');
const CLI = path.join(ROOT, 'packages/cli/dist/cli.js');
const run = promisify(execFile);
/** What the test keeps on the main process's globalThis while it watches a guest. */
type Probes = { keptProbe: { navigations: number }, browserProbe: { failed: { code: number, url: string }[], redirects: string[] } };
/** A guest's last web preferences, as the test reads them (webContents.getLastWebPreferences, where Electron has it). */
type WebPrefs = { preload?: string | null, sandbox?: boolean, contextIsolation?: boolean, nodeIntegration?: boolean };
type LastPrefs = { getLastWebPreferences?: () => WebPrefs | undefined };
/** A Browser tab guest as `guests` lists it. */
type Guest = { id: number, url: string };

/** A scratch host with alpd and one registered project, and the `alp` wrapper the app runs. */
async function browserHost(context: Context, step: (what: string) => void = () => {}) {
  const { dir, defer } = context;
  const home = path.join(dir, 'h', '.alp');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(path.join(dir, 'ht'), { recursive: true });
  step('host: fixture processes');
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
  const alp = (...args: string[]) => run(process.execPath, [CLI, ...args], { env, timeout: 60_000 });
  step('host: alp init');
  await alp('init', directory);
  step('host: alp daemon start');
  await alp('daemon', 'start');
  defer(() => alp('daemon', 'stop').catch(() => {}));
  const lock = JSON.parse(await readFile(path.join(home, 'alpd.lock'), 'utf8'));
  assert.ok(lock.ready && lock.socket.startsWith(`${dir}${path.sep}`));
  step('host: connecting to alpd');
  const client = await bounded('connecting to alpd', hostConnect(lock.socket));
  try {
    step('host: registering the project');
    const { revision } = await bounded('project.list', client.request('project.list', {}));
    await bounded('project.register', client.request('project.register', { directory, ifRevision: revision, requestId: 'desktop-browser-site' }));
  } finally { client.close(); }
  step('host: writing the alp wrapper');
  const wrapper = path.join(bin, 'alp');
  const exports = Object.entries(env).filter(([name]) => /^(ALP_[A-Z0-9_]+|PATH|HOME|TMPDIR|NODE_OPTIONS|USER|LOGNAME|LANG)$/.test(name)).map(([name, value]) => `${name}='${String(value).replaceAll("'", "'\\''")}'`);
  await writeFile(wrapper, `#!/bin/sh\nexec env -i ${exports.join(' ')} '${process.execPath}' '${CLI}' "$@"\n`);
  await chmod(wrapper, 0o755);
  defer(() => alp('dashboard', '--stop').catch(() => {}));
  return { home, directory, wrapper, dir };
}

/** The tail of every log under the scratch host's ALP home, for a failure report (tokens masked). */
async function hostLogs(dir: string) {
  const logs = path.join(dir, 'h', '.alp', 'logs');
  const found: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(file);
      else found.push(`--- ${path.relative(logs, file)}\n${(await readFile(file, 'utf8').catch(error => error.message)).slice(-3_000)}`);
    }
  };
  await walk(logs);
  return (found.join('\n') || '(no logs)').replace(/alpgw1\.[A-Za-z0-9_.-]+/g, 'alpgw1.<masked>');
}

const PAGE_STYLE = '<style>body{font:16px -apple-system,system-ui,sans-serif;background:#101418;color:#e8edf2;margin:0;padding:40px}h1{font-weight:600}code{color:#8ab4f8}</style>';

/** A local site the Browser tab visits; `hits` counts the requests per path. */
async function localSite(context: Context) {
  const hits: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, 'http://x');
    hits.push(url.pathname);
    if (url.pathname === '/redirect') { response.writeHead(302, { location: url.searchParams.get('to') ?? '/' }); response.end(); return; }
    if (url.pathname === '/download') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="payload.bin"' }); response.end('payload'); return; }
    const title = url.pathname === '/page2' ? 'Second page' : 'Local page';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>${title}</title>${PAGE_STYLE}<h1 id="title">${title}</h1><p>Served by the test at <code>${url.pathname}</code>, in ALP.app's Browser tab.</p><a id="blank" href="/page2" target="_blank">Open in a new tab</a>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.defer(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

/** The Browser tab guests: id and address. */
const guests = (app: ElectronApplication) => bounded<Guest[]>('listing the Browser tab guests', app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents: WebContentsLike) => contents.getType() === 'webview' && !contents.isDestroyed()).map((contents: WebContentsLike) => ({ id: contents.id, url: contents.getURL() }))));
/** Runs `code` in guest `id` (as a user gesture, so window.open and permission prompts are honest). */
const inGuest = (app: ElectronApplication, id: number, code: string) => bounded(`running ${code.slice(0, 80)} in guest ${id}`, app.evaluate(({ webContents }, [guest, script]: [number, string]) => webContents.fromId(guest)!.executeJavaScript(script, true), [id, code] as [number, string]));
const windowCount = (app: ElectronApplication) => bounded('counting windows', app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length));
/** What every guest is doing, for a failure report: a step stuck on a guest shows here. */
const guestStates = (app: ElectronApplication) => bounded('reading the guest states', app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents: WebContentsLike) => contents.getType() === 'webview').map((contents: WebContentsLike) => contents.isDestroyed() ? { destroyed: true } : { id: contents.id, url: contents.getURL(), loading: contents.isLoading(), waiting: contents.isWaitingForResponse(), crashed: contents.isCrashed(), focused: contents.isFocused() })), 5_000);
const capture = async (app: ElectronApplication, file: string) => {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  await writeFile(file, Buffer.from(png, 'base64'));
};

test('browser: a Browser tab shows a local page and is held to its guards', { timeout: 300_000 }, async t => {
  // Which step the test reached: logged as it goes, and reported (with the host's logs, and once the
  // app runs, its guests and output) when the test ends before its last step.
  let reached = 'start';
  let app: App;
  const step = (what: string) => { reached = what; console.log(`# browser.spec ${new Date().toISOString()} ${what}`); };
  const context = await scratch(t);
  context.defer(async () => {
    if (reached === 'done') return;
    t.diagnostic(`browser.spec stopped at: ${reached}`);
    t.diagnostic(`host logs:\n${await hostLogs(context.dir)}`);
  });
  step('host');
  const host = await browserHost(context, step);
  const site = await localSite(context);
  step('launching ALP.app');
  app = await launch(t, context, host.wrapper);
  context.defer(async () => {
    if (reached === 'done') return;
    const states = await guestStates(app).catch(error => error.message);
    t.diagnostic(`guests: ${JSON.stringify(states)}\napp output:\n${app.alpOutput().slice(-8_000)}`);
  });
  step('waiting for dashboard.json');
  const info = await waitFor(async () => {
    const value = JSON.parse(await readFile(path.join(host.home, 'dashboard.json'), 'utf8'));
    return value?.port ? value : undefined;
  }, 'alp dashboard to write dashboard.json', 90_000);
  const dashboard = `http://127.0.0.1:${info.port}`;
  step('waiting for the window to connect');
  await connectedTo(app, dashboard, 90_000);
  const page = app.windows()[0];
  page.setDefaultTimeout(30_000);
  // On a failure, what the Browser tab itself shows (t-a5d8): the address bar, its error line, the
  // focused element and the <webview> elements, as the guests alone did not tell an address never
  // submitted from one that did not load.
  context.defer(async () => {
    if (reached === 'done') return;
    const state = await bounded('reading the Browser tab state', page.evaluate(() => ({
      addresses: [...document.querySelectorAll<HTMLInputElement>('[data-testid="browser-address"]')].map(element => element.value),
      errors: [...document.querySelectorAll('[data-testid="browser-error"]')].map(element => element.textContent),
      focused: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null,
      webviews: [...document.querySelectorAll('webview')].map(element => element.getAttribute('src')),
    })), 5_000).catch(error => error.message);
    t.diagnostic(`Browser tab: ${JSON.stringify(state)}`);
  });
  // No evaluate in the app's main process or in the dashboard page may hang the test without a word.
  const appEvaluate = app.evaluate.bind(app);
  app.evaluate = ((fn: Parameters<typeof appEvaluate>[0], arg?: unknown) => bounded(`a main-process evaluate during ${reached}`, appEvaluate(fn, arg))) as typeof app.evaluate;
  const pageEvaluate = page.evaluate.bind(page);
  page.evaluate = ((fn: Parameters<typeof pageEvaluate>[0], arg?: unknown) => bounded(`a dashboard page evaluate during ${reached}`, pageEvaluate(fn, arg))) as typeof page.evaluate;
  await page.emulateMedia({ colorScheme: 'dark' });
  const shots = process.env.ALP_DESKTOP_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });

  step('connected; checking the dashboard page');
  // The marker is in the dashboard window's user agent; the page holds its token.
  assert.match(await page.evaluate(() => navigator.userAgent), /ALPDesktop\/1/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('alp-web:link-token') !== null), true);

  step('the + menu');
  // The + menu offers Browser after Diff.
  await page.getByTestId('project-row').first().waitFor({ timeout: 60_000 });
  const newTab = page.getByRole('button', { name: 'New tab' });
  await newTab.waitFor({ timeout: 60_000 });
  await newTab.click();
  const items = await page.getByRole('menuitem').allInnerTexts();
  assert.deepEqual(items.map(item => item.trim()), ['Agent', 'Terminal', 'Diff', 'Browser', 'Tasks', 'Agents']);
  if (shots) await capture(app, path.join(shots, 'plus-menu-browser.png'));
  await page.getByRole('menuitem', { name: 'Browser' }).click();

  step('(1) loading the local page');
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

  step('(1b) another tab in front keeps the page');
  // (1b) t-a35b: the page stays alive behind another tab (same guest, no new navigation, its scroll,
  // input and script state kept); hidden, it is invisible and inert.
  await app.evaluate(({ webContents }, id) => {
    (globalThis as unknown as Probes).keptProbe = { navigations: 0 };
    webContents.fromId(id)!.on('did-start-navigation', (details: { isMainFrame: boolean, isSameDocument: boolean }) => { if (details.isMainFrame && !details.isSameDocument) (globalThis as unknown as Probes).keptProbe.navigations += 1; });
  }, guest.id);
  const scrolled = await inGuest(app, guest.id, `document.body.style.height = '4000px'; const field = document.createElement('input'); field.id = 'kept'; document.body.prepend(field); field.value = 'typed'; window.__kept = 'yes'; window.scrollTo(0, 900); window.scrollY`);
  assert.equal(scrolled, 900);
  const resident = page.locator('[data-testid="browser-resident"]').first();
  await newTab.click();
  await page.getByRole('menuitem', { name: 'Tasks' }).click();
  await waitFor(async () => (await resident.getAttribute('data-shown')) === 'false', 'the Browser tab to be hidden behind Tasks');
  const hidden = await resident.evaluate((element: HTMLElement) => ({ inert: element.inert, visibility: getComputedStyle(element).visibility, pointer: getComputedStyle(element).pointerEvents }));
  assert.deepEqual(hidden, { inert: true, visibility: 'hidden', pointer: 'none' });
  assert.deepEqual((await guests(app)).map(entry => entry.id), [guest.id], 'the hidden tab lost its guest');
  await sleep(300);
  await page.locator('[data-tab^="browser:"]').first().click();
  await waitFor(async () => (await resident.getAttribute('data-shown')) === 'true', 'the Browser tab to be shown again');
  assert.deepEqual(JSON.parse(await inGuest(app, guest.id, `JSON.stringify({ kept: window.__kept ?? null, field: document.getElementById('kept')?.value ?? null, scroll: window.scrollY })`)), { kept: 'yes', field: 'typed', scroll: 900 });
  assert.deepEqual((await guests(app)).map(entry => entry.id), [guest.id]);
  assert.equal((await app.evaluate(() => (globalThis as unknown as Probes).keptProbe)).navigations, 0, 'the page loaded again');
  await inGuest(app, guest.id, `document.getElementById('kept').remove(); document.body.style.height = ''; window.scrollTo(0, 0); 'ok'`);

  step('(2) partition and isolation');
  // (2) Its own partition, and nothing of the dashboard's: no token, storage, cookies, Node or parent.
  const where = await app.evaluate(({ webContents, session }, id) => {
    const contents = webContents.fromId(id)!;
    const prefs: WebPrefs = (contents as unknown as LastPrefs).getLastWebPreferences?.() ?? {};
    return { own: contents.session === session.fromPartition('persist:alp-browser'), shared: contents.session === session.defaultSession, preload: prefs.preload ?? null, sandbox: prefs.sandbox, isolation: prefs.contextIsolation, node: prefs.nodeIntegration };
  }, guest.id);
  assert.deepEqual(where, { own: true, shared: false, preload: null, sandbox: true, isolation: true, node: false });
  const seen = await inGuest(app, guest.id, `JSON.stringify({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie, top: window.top === window, parent: window.parent === window, require: typeof require, process: typeof process, token: document.documentElement.outerHTML.includes('alpgw1') || location.href.includes('token') })`);
  assert.deepEqual(JSON.parse(seen), { local: 0, session: 0, cookie: '', top: true, parent: true, require: 'undefined', process: 'undefined', token: false });

  step('(3) navigation guards');
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
    const contents = webContents.fromId(id)!;
    (globalThis as unknown as Probes).browserProbe = { failed: [], redirects: [] };
    contents.on('did-fail-load', (_event: unknown, code: number, _description: string, url: string) => (globalThis as unknown as Probes).browserProbe.failed.push({ code, url }));
    contents.on('did-redirect-navigation', (details: { url: string }) => (globalThis as unknown as Probes).browserProbe.redirects.push(details.url));
  }, guest.id);
  const probeLog = () => app.evaluate(() => (globalThis as unknown as Probes).browserProbe);
  // The tab says which navigation the main process stopped (BLOCKED_EVENT, as text): every http one
  // here, as the address the guest asked for. file:, data:, chrome: and devtools: never reach the guard
  // (Chromium refuses them in the page), so the tab has nothing to say about them.
  const redirect = `${site.origin}/redirect?to=${encodeURIComponent(`http://localhost:${info.port}/`)}`;
  const noticed = new Map<string, string>([...dashboardSpellings.map((target): [string, string] => [target, new URL(target).href]), [redirect, `http://localhost:${info.port}/`]]);
  const noticeOf = async () => {
    const line = page.locator('[data-testid="browser-resident"][data-shown="true"]').getByTestId('browser-error');
    return (await line.count()) ? line.innerText({ timeout: 2_000 }).catch(() => '') : '';
  };
  const blocked = ['file:///etc/hosts', 'data:text/html,<p>x</p>', 'chrome://version', 'devtools://devtools/bundled/inspector.html', ...dashboardSpellings, redirect];
  for (const target of blocked) {
    step(`(3) navigation to ${target}`);
    await inGuest(app, guest.id, `location.href = ${JSON.stringify(target)}; 'ok'`).catch(() => undefined);
    await sleep(400);
    const now = (await guests(app)).find(entry => entry.id === guest.id)?.url;
    assert.equal(now, pageUrl, `navigation to ${target} was not blocked (guest at ${now})`);
    // A redirect to the dashboard is said as the address it was redirected to.
    if (noticed.has(target)) await waitFor(async () => (await noticeOf()) === `Blocked navigation to ${noticed.get(target)}`, `the tab to say the navigation to ${target} was blocked`, 10_000);
  }
  const log = await probeLog();
  assert.deepEqual(log.failed.filter(entry => entry.code === -20), [], 'a navigation reached the request guard: the navigation guard did not stop it');
  assert.ok(log.redirects.every(url => !url.includes(`:${info.port}`)), `a redirect to the dashboard was followed: ${log.redirects}`);
  step('(3) blob: navigation');
  // blob: top level too.
  await inGuest(app, guest.id, `location.href = URL.createObjectURL(new Blob(['<p>x</p>'], { type: 'text/html' })); 'ok'`).catch(() => undefined);
  await sleep(400);
  assert.equal((await guests(app))[0].url, pageUrl, 'a blob: page was not blocked');
  step('(3) iframe to the dashboard');
  // Frames: an iframe pointed at the dashboard never shows it.
  await inGuest(app, guest.id, `const f = document.createElement('iframe'); f.id = 'probe'; f.src = ${JSON.stringify(`http://localhost:${info.port}/`)}; document.body.append(f); 'ok'`);
  await sleep(800);
  const frames: { url: string, origin: string }[] = await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.mainFrame.frames.map((frame: { url: string, origin: string }) => ({ url: frame.url, origin: frame.origin })), guest.id);
  assert.ok(!frames.some(frame => frame.origin === `http://localhost:${info.port}`), JSON.stringify(frames));
  step('(3) webview.loadURL from the dashboard page');
  // Loads the dashboard page starts itself (webview.loadURL, as an XSS there could) emit no
  // will-navigate: they are stopped when they start, and file: is refused by the partition.
  for (const target of ['file:///etc/hosts', 'chrome://version', 'devtools://devtools/bundled/inspector.html', `http://localhost:${info.port}/`, `http://[::1]:${info.port}/`, 'data:text/html,<p>x</p>']) {
    step(`(3) loadURL ${target}`);
    await page.evaluate(url => (document.querySelector('[data-testid="browser-webview"]') as Element & { loadURL(url: string): Promise<void> }).loadURL(url).catch(() => undefined), target);
    await sleep(600);
    const now = (await guests(app)).find(entry => entry.id === guest.id)?.url;
    assert.equal(now, pageUrl, `a load of ${target} from the dashboard page was not stopped (guest at ${now})`);
  }
  assert.equal(await inGuest(app, guest.id, 'document.getElementById("title")?.textContent ?? null'), 'Local page');
  step('(3) address bar refusals');
  // The address bar refuses file: and says why; the dashboard's address is refused by the main process.
  await address.fill('file:///etc/hosts');
  await address.press('Enter');
  assert.match(await page.getByTestId('browser-error').innerText(), /only http and https/);
  await address.fill(`localhost:${info.port}`);
  await address.press('Enter');
  await waitFor(async () => /blocked/.test(await page.getByTestId('browser-error').innerText().catch(() => '')), 'the address bar to say the dashboard is blocked');
  assert.equal((await guests(app))[0].url, pageUrl);

  step('(4) requests to the dashboard port');
  // (4) Requests: fetch, XHR and WebSocket to the dashboard's port are cancelled by onBeforeRequest
  // (no-cors fetch resolves whenever a request went out; the control request to the site does).
  const probe = (target: string) => inGuest(app, guest.id, `fetch(${JSON.stringify(target)}, { mode: 'no-cors' }).then(() => 'sent', () => 'blocked')`);
  assert.equal(await probe(`${site.origin}/control`), 'sent');
  for (const target of dashboardSpellings.slice(0, 7)) assert.equal(await probe(`${target}v1/tickets`), 'blocked', target);
  const xhr = await inGuest(app, guest.id, `new Promise(resolve => { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(`http://127.0.0.1:${info.port}/`)}); x.onload = () => resolve('loaded'); x.onerror = () => resolve('blocked'); x.send(); })`);
  assert.equal(xhr, 'blocked');
  const socket = await inGuest(app, guest.id, `new Promise(resolve => { const s = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${info.port}/`)}); s.onopen = () => resolve('open'); s.onerror = () => resolve('blocked'); })`);
  assert.equal(socket, 'blocked');

  step('(5) permissions');
  // (5) Permissions are denied; devtools stay shut; downloads are cancelled.
  assert.equal(await inGuest(app, guest.id, 'Notification.requestPermission()'), 'denied');
  // The dashboard page may show notifications (t-0166); its Browser tabs still may not.
  assert.equal(await inGuest(app, guest.id, 'Notification.permission'), 'denied');
  assert.equal(await inGuest(app, guest.id, "navigator.permissions.query({ name: 'notifications' }).then(s => s.state)"), 'denied');
  assert.equal(await inGuest(app, guest.id, `navigator.permissions.query({ name: 'geolocation' }).then(s => s.state)`), 'denied');
  assert.equal(await inGuest(app, guest.id, `navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', () => 'denied')`), 'denied');
  assert.equal(await inGuest(app, guest.id, `navigator.clipboard.readText().then(() => 'granted', () => 'denied')`), 'denied');
  step('(5) devtools');
  const devtools = await app.evaluate(async ({ webContents }, id) => { const contents = webContents.fromId(id)!; contents.openDevTools(); await new Promise(resolve => setTimeout(resolve, 500)); return contents.isDevToolsOpened(); }, guest.id);
  assert.equal(devtools, false);
  step('(5) download');
  await inGuest(app, guest.id, `location.href = '/download'; 'ok'`);
  await waitFor(() => site.hits.includes('/download'), 'the download request');
  await sleep(800);
  const downloads = path.join(context.dir, 'app-home', 'Downloads');
  assert.deepEqual(await readdir(downloads).catch(() => []), [], 'nothing was downloaded');
  assert.equal((await guests(app))[0].url, pageUrl);

  step('(6) window.open');
  // (6) window.open and target=_blank: new Browser tabs in the workspace, never a window.
  // A new tab is shown at once and the opener's tab (with its guest) leaves the page, so whatever
  // opens one runs after the script has answered: an executeJavaScript whose guest is destroyed
  // before it answers never settles (the CI hang of t-a876). The user gesture outlives the timeout.
  await inGuest(app, guest.id, `setTimeout(() => window.open(${JSON.stringify(`${site.origin}/page2`)})); 'ok'`);
  await waitFor(async () => (await page.locator('[data-tab^="browser:"]').count()) === 2, 'a second Browser tab');
  await waitFor(async () => (await guests(app)).some(entry => entry.url === `${site.origin}/page2`), 'the new tab to show page2');
  assert.equal(await windowCount(app), 1);
  // A window.open to the dashboard is refused outright.
  const [second] = (await guests(app)).filter(entry => entry.url === `${site.origin}/page2`);
  await inGuest(app, second.id, `window.open(${JSON.stringify(`http://localhost:${info.port}/`)}); window.open('file:///etc/hosts'); 'ok'`);
  await inGuest(app, second.id, `setTimeout(() => document.getElementById('blank').click()); 'ok'`);
  await waitFor(async () => (await page.locator('[data-tab^="browser:"]').count()) === 3, 'a third Browser tab from target=_blank');
  await sleep(500);
  assert.equal(await page.locator('[data-tab^="browser:"]').count(), 3);
  assert.equal(await windowCount(app), 1);

  step('(6b) a hidden tab opens a tab and is told of its own blocked navigation');
  // t-a35b: the first tab is now behind the others, its page alive: its window.open still opens a tab,
  // and its blocked navigation is said in its own tab, not in the one shown.
  await inGuest(app, guest.id, `location.hash = 'fresh'; 'ok'`);
  await inGuest(app, guest.id, `setTimeout(() => window.open(${JSON.stringify(`${site.origin}/page2?hidden-opener`)})); 'ok'`);
  await waitFor(async () => (await page.locator('[data-tab^="browser:"]').count()) === 4, 'a Browser tab from the hidden opener');
  await waitFor(async () => (await guests(app)).some(entry => entry.url === `${site.origin}/page2?hidden-opener`), 'the new tab to show its page');
  await inGuest(app, guest.id, `location.href = ${JSON.stringify(`http://localhost:${info.port}/`)}; 'ok'`).catch(() => undefined);
  await sleep(600);
  assert.equal((await guests(app)).find(entry => entry.id === guest.id)?.url, `${pageUrl}#fresh`);
  const shownNotice = await page.locator('[data-testid="browser-resident"][data-shown="true"]').getByTestId('browser-error').count();
  assert.equal(shownNotice, 0, 'the shown tab was told of another tab\'s blocked navigation');
  await page.locator('[data-tab^="browser:"]').first().click();
  await waitFor(async () => (await noticeOf()) === `Blocked navigation to http://localhost:${info.port}/`, 'the first tab to say its navigation was blocked');
  await page.locator('[data-tab^="browser:"]').last().click();
  await waitFor(async () => (await page.locator('[data-testid="browser-resident"][data-shown="true"]').count()) === 1, 'the last Browser tab to be shown');
  assert.equal(await windowCount(app), 1);

  step('(7) page-made webviews');
  // (7) A <webview> the page makes itself: another partition, no partition or a file: src is refused;
  // a preload is dropped (the preload would mark the document).
  const preload = path.join(context.dir, 'preload.js');
  await writeFile(preload, "window.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.preloaded = 'yes'; });\n");
  const before = (await guests(app)).length;
  const attach = (attributes: Record<string, string>, testId: string) => page.evaluate(([attrs, id]: [Record<string, string>, string]) => {
    const view = document.createElement('webview');
    for (const [name, value] of Object.entries(attrs)) view.setAttribute(name, value);
    view.dataset.probe = id;
    view.style.cssText = 'position:fixed;width:10px;height:10px;bottom:0;right:0';
    document.body.append(view);
  }, [attributes, testId] as [Record<string, string>, string]);
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
    const contents = webContents.fromId(id)!;
    return { own: contents.session === session.fromPartition('persist:alp-browser'), preload: (contents as unknown as LastPrefs).getLastWebPreferences?.()?.preload ?? null };
  }, preloaded.id);
  assert.deepEqual(forced, { own: true, preload: null });
  await page.evaluate(() => { for (const view of document.querySelectorAll('webview[data-probe]')) view.remove(); });
  assert.equal(await windowCount(app), 1);

  step('(8) keys in a Browser tab');
  // (8) t-0166: ⌘W pressed in a Browser tab's page closes that tab (the dashboard's key), not the
  // window; ⌘C stays the page's.
  if (process.platform === 'darwin') {
    const tabsBefore = await page.locator('[data-tab^="browser:"]').count();
    const shown = await waitFor(async () => {
      const ids = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents: WebContentsLike) => contents.getType() === 'webview' && !contents.isDestroyed()).map((contents: WebContentsLike) => contents.id));
      return ids.at(-1);
    }, 'a Browser tab guest');
    await inGuest(app, shown, "window.__keys = []; window.addEventListener('keydown', e => window.__keys.push(e.code)); 'ok'");
    const pressIn = (code: string, keyCode: string) => app.evaluate(({ webContents }, [id, key]: [number, string]) => {
      const contents = webContents.fromId(id)!;
      contents.focus();
      contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['meta'] });
      contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['meta'] });
    }, [shown, keyCode] as [number, string]);
    await pressIn('KeyC', 'C');
    await waitFor(async () => (await inGuest(app, shown, 'window.__keys.join()')).includes('KeyC'), 'the page to get ⌘C');
    await pressIn('KeyW', 'W');
    await waitFor(async () => (await page.locator('[data-tab^="browser:"]').count()) === tabsBefore - 1, 'the Browser tab to close');
    assert.equal(await windowCount(app), 1);
    // ⌥⌘1 in a Browser tab's page goes to the dashboard's first tab.
    await page.locator('[data-tab^="browser:"]').last().click();
    const next = await waitFor(async () => {
      const ids = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents: WebContentsLike) => contents.getType() === 'webview' && !contents.isDestroyed()).map((contents: WebContentsLike) => contents.id));
      return ids.at(-1);
    }, 'the next Browser tab guest');
    await app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)!;
      contents.focus();
      contents.sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['meta', 'alt'] });
      contents.sendInputEvent({ type: 'keyUp', keyCode: '1', modifiers: ['meta', 'alt'] });
    }, next);
    const workspaceTabs = page.getByTestId('workspace-tab');
    await waitFor(async () => (await workspaceTabs.first().getAttribute('aria-selected')) === 'true', 'the first tab to be shown', 10_000);
  }
  step('done');
});
