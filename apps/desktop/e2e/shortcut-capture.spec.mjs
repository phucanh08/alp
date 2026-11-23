/**
 * Settings › Shortcuts in ALP.app (t-81b0.13, t-81b0.14): while a row waits for keys, the app menu's
 * key equivalents (⌘Q, ⌘H, ⌘Z, ⇧⌘Z, ⌘X, ⌘C, ⌘V, ⌥⇧⌘V, ⌘A, ⌘R, ⌘0, ⌘=, ⌘-, ⌃⌘F, ⌘M, ⇧⌘R, the dev
 * build's ⌥⌘I) are recorded by the row and their menu items do not run; after the capture they act
 * again. No bridge to the main process is needed: Electron on macOS gives a Cmd key to the focused page
 * first and runs the menu item only when the page did not handle it, and the capture listener calls
 * preventDefault on every key (apps/web ShortcutsPage.tsx). docs/alp/desktop.md §4.
 *
 * Menu items run only for key presses that come from the system: webContents.sendInputEvent goes to the
 * page directly and never reaches the menu. These tests therefore post real key events with
 * CoreGraphics (CGEventPostToPid, from osascript's JavaScript bridge) to the test app's own process
 * only, never to whatever app is in front. A host that does not deliver them (the test runner has no
 * Accessibility permission) skips, after a probe key shows that nothing arrived. ⌥⌘H (Hide Others) is
 * never pressed: it would hide the user's other apps if it ran.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixtureProcesses } from '../../../test/support/fixture-processes.js';
import { APP, bounded, cleanEnv, connectedTo, freePort, launch, scratch, waitFor } from './support.mjs';

const CLI = path.join(APP, '..', '..', 'packages/cli/dist/cli.js');

const limit = { timeout: 180_000 };
const exec = promisify(execFile);

/** Posts key `keyCode` (a macOS virtual key code) with `flags` (CGEventFlags) to process `pid` only. */
const POST_KEY = `ObjC.import('Cocoa');
function run(argv) {
  const pid = Number(argv[0]), key = Number(argv[1]), flags = Number(argv[2]);
  for (const down of [true, false]) {
    const event = $.CGEventCreateKeyboardEvent(null, key, down);
    $.CGEventSetFlags(event, flags);
    $.CGEventPostToPid(pid, event);
  }
  return 'posted';
}`;
/** macOS virtual key codes (Carbon kVK_ANSI_*). */
const KEY_CODES = { a: 0, h: 4, z: 6, x: 7, c: 8, v: 9, f: 3, q: 12, r: 15, eq: 24, minus: 27, d0: 29, i: 34, m: 46 };

/**
 * A scratch host with alpd (Settings needs a dashboard that reached its host), as ./browser.spec.mjs
 * builds one: everything under the test's scratch directory, never the user's ~/.alp or alpd. The app
 * runs the `alp` wrapper.
 */
async function alpdHost(context) {
  const { dir, defer } = context;
  const home = path.join(dir, 'h', '.alp');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(path.join(dir, 'ht'), { recursive: true });
  const processes = await fixtureProcesses(home);
  defer(() => processes.stop());
  const project = path.join(dir, 'projects', 'site');
  await mkdir(project, { recursive: true });
  const env = {
    ...cleanEnv(), ...processes.env,
    HOME: path.dirname(home), TMPDIR: path.join(dir, 'ht'), ALP_LAUNCHCTL: '/usr/bin/false',
    ALP_CODEX_BIN: path.join(dir, 'no-real-codex'), ALP_CLAUDE_BIN: path.join(dir, 'no-real-claude'), ALP_ANTIGRAVITY_BIN: path.join(dir, 'no-real-antigravity'),
  };
  for (const value of [env.ALP_HOME, env.HOME, env.TMPDIR, env.ALP_SERVICE_DIR]) assert.ok(value.startsWith(`${dir}${path.sep}`), `${value} is outside the scratch directory`);
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ dashboard: { port: await freePort() }, web: { relay: { enabled: false } } }));
  const alp = (...args) => exec(process.execPath, [CLI, ...args], { env, timeout: 60_000 });
  await alp('init', await realpath(project));
  await alp('daemon', 'start');
  defer(() => alp('daemon', 'stop').catch(() => {}));
  const bin = path.join(dir, 'hb');
  await mkdir(bin, { recursive: true });
  const wrapper = path.join(bin, 'alp');
  const exports = Object.entries(env).filter(([name]) => /^(ALP_[A-Z0-9_]+|PATH|HOME|TMPDIR|NODE_OPTIONS|USER|LOGNAME|LANG)$/.test(name)).map(([name, value]) => `${name}='${String(value).replaceAll("'", "'\\''")}'`);
  await writeFile(wrapper, `#!/bin/sh\nexec env -i ${exports.join(' ')} '${process.execPath}' '${CLI}' "$@"\n`);
  await chmod(wrapper, 0o755);
  defer(() => alp('dashboard', '--stop').catch(() => {}));
  return { home, wrapper };
}

async function connectedSetup(t) {
  const context = await scratch(t);
  const alp = await alpdHost(context);
  const app = await launch(t, context, alp.wrapper);
  const info = await waitFor(async () => {
    const value = JSON.parse(await readFile(path.join(alp.home, 'dashboard.json'), 'utf8'));
    return value?.port ? value : undefined;
  }, 'alp dashboard to write dashboard.json', 90_000);
  const origin = `http://127.0.0.1:${info.port}`;
  await connectedTo(app, origin, 90_000);
  const page = app.windows()[0];
  page.setDefaultTimeout(30_000);
  // The dashboard window, kept by id: a test opens a second window to take focus away from it.
  // Its blurs are counted: a press during which the window lost focus (another app came to the
  // front, as on a desktop someone is using) is pressed again, never counted as a pass.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    globalThis.__dashboardId = window.id;
    globalThis.__blurs = 0;
    window.on('blur', () => { globalThis.__blurs += 1; });
  });
  return { context, origin, app, page };
}

/**
 * Brings the dashboard window to the front (a real key goes to the key window) when it is not there,
 * and waits until its page has focus. A window already in front is left alone: activating the app
 * again for every key let a key posted during the activation get lost.
 */
async function front(app, page) {
  await app.evaluate(({ app: electron, BrowserWindow }) => {
    const window = BrowserWindow.fromId(globalThis.__dashboardId);
    if (window.isFocused()) return;
    electron.focus({ steal: true });
    window.show();
    window.focus();
  });
  await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.fromId(globalThis.__dashboardId)?.isFocused()), 'the window to have focus');
  if (page) await waitFor(() => page.evaluate(() => document.hasFocus()), 'the page to have focus');
}

/** A real key press, from the system, to the test app's process. */
async function realKey(app, key, flags, page) {
  await front(app, page);
  await bounded(`posting key ${key}`, exec('osascript', ['-l', 'JavaScript', '-e', POST_KEY, String(app.process().pid), String(KEY_CODES[key]), String(flags)]));
}

const blurs = app => app.evaluate(() => globalThis.__blurs);

/**
 * Presses `key` until `done` answers true. A press is repeated (three at most) only when the window
 * lost focus while it was pressed; a key lost while the window kept focus fails the test.
 */
async function press(app, page, key, flags, done, what, timeoutMs = 5_000) {
  for (let attempt = 1; ; attempt += 1) {
    await front(app, page);
    const before = await blurs(app);
    await realKey(app, key, flags, page);
    try { return await waitFor(done, what, timeoutMs); } catch (error) {
      const lostFocus = (await blurs(app)) !== before || !await app.evaluate(({ BrowserWindow }) => BrowserWindow.fromId(globalThis.__dashboardId).isFocused());
      if (!lostFocus || attempt >= 3) throw error;
    }
  }
}

const settingsRow = (page, id) => page.getByTestId(`shortcut-setting-${id}`);
async function openShortcuts(page) {
  const open = page.getByTestId('sidebar-settings');
  await open.waitFor({ timeout: 60_000 });
  await open.click();
  try { await page.getByTestId('settings-shortcuts').click({ timeout: 10_000 }); } catch (error) {
    throw new Error(`${error.message}\npage: ${(await page.evaluate(() => [document.body.innerText.slice(0, 1500), [...document.querySelectorAll('[data-testid]')].map(e => e.dataset.testid).slice(0, 60).join(' ')].join('\n---\n')))}`);
  }
  await page.getByTestId('shortcuts-page').waitFor();
}
/** Opens row `id`'s menu and chooses Bind/Rebind: the row waits for keys. */
async function startCapture(page, id) {
  const item = page.getByTestId(`shortcut-bind-${id}`);
  await settingsRow(page, id).scrollIntoViewIfNeeded();
  await waitFor(async () => {
    if (!await item.isVisible()) await settingsRow(page, id).getByTestId(`shortcut-actions-${id}`).click();
    return item.isVisible();
  }, `the ${id} row's menu`);
  await item.click();
  await page.getByTestId('shortcut-capture').waitFor();
}
/** A mark that only a reload of the page takes away. */
const mark = page => page.evaluate(() => { window.__notReloaded = true; });
const reloaded = page => page.evaluate(() => window.__notReloaded !== true).catch(() => false);


const F = { shift: 1 << 17, ctrl: 1 << 18, alt: 1 << 19, cmd: 1 << 20 };
/** The app menu's keys (main.ts buildMenu, the roles' defaults), as the row shows them once recorded. */
const MENU_KEYS = [
  ['⌘Q', 'q', F.cmd], ['⌘H', 'h', F.cmd], ['⌘Z', 'z', F.cmd], ['⇧⌘Z', 'z', F.cmd | F.shift], ['⌘X', 'x', F.cmd],
  ['⌘C', 'c', F.cmd], ['⌘V', 'v', F.cmd], ['⌥⇧⌘V', 'v', F.cmd | F.alt | F.shift], ['⌘A', 'a', F.cmd], ['⌘R', 'r', F.cmd],
  ['⌘0', 'd0', F.cmd], ['⌘=', 'eq', F.cmd], ['⌘-', 'minus', F.cmd], ['⌃⌘F', 'f', F.cmd | F.ctrl], ['⌘M', 'm', F.cmd],
  ['⇧⌘R', 'r', F.cmd | F.shift], ['⌥⌘I', 'i', F.cmd | F.alt],
];

/** What a menu item would have changed in the dashboard window. */
const windowState = app => app.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.fromId(globalThis.__dashboardId);
  return { zoom: window.webContents.getZoomLevel(), fullScreen: window.isFullScreen(), minimized: window.isMinimized(), visible: window.isVisible(), devTools: window.webContents.isDevToolsOpened() };
});
const CALM = { zoom: 0, fullScreen: false, minimized: false, visible: true, devTools: false };
const shownKeys = row => row.getByTestId('shortcut-keys').innerText({ timeout: 1_000 }).catch(() => '');

/** Skips the test unless a key posted to the app reaches its page. */
async function canPostKeys(t, app, page) {
  // Registered before any capture starts, so it sees every key before the capture's own listener
  // (window, capture phase, which stops the key there).
  await page.evaluate(() => {
    window.__probe = 0;
    window.__seen = [];
    window.addEventListener('keydown', event => { window.__seen.push(event.code); if (event.code === 'KeyA' && !event.metaKey) window.__probe += 1; }, true);
  });
  // The skip says what failed, so a window that never got focus is not mistaken for a missing permission.
  const reached = await press(app, page, 'a', 0, () => page.evaluate(() => window.__probe > 0), 'a posted key').catch(error => error);
  if (reached !== true) t.skip(`this host does not deliver posted key events (no Accessibility permission for the test runner?): ${reached instanceof Error ? reached.message : 'the key never reached the page'}`);
  return reached === true;
}

/** Presses `key` while row `id` captures and checks that the row recorded it and no menu item ran. */
async function recordedWithoutMenu(app, page, [shown, key, flags], id = 'sidebar.left') {
  const row = settingsRow(page, id);
  await mark(page);
  await page.evaluate(() => { window.__seen = []; });
  try {
    await press(app, page, key, flags, async () => (await shownKeys(row)) === shown, `the row to record ${shown}`);
  } catch (error) {
    const exit = app.process().exitCode ?? app.process().signalCode;
    const seen = await page.evaluate(() => window.__seen ?? []).catch(failure => failure.message);
    throw new Error(`${error.message}\nwindow: ${JSON.stringify(await windowState(app).catch(failure => failure.message))}\nkeys the page saw: ${JSON.stringify(seen)}\napp process: ${exit === null ? 'running' : `ended (${exit})`}\nrow: ${await row.innerText({ timeout: 2_000 }).catch(failure => failure.message)}\napp output:\n${app.alpOutput().slice(-3_000)}`);
  }
  // A menu item runs at once if it runs; give a late one time to show.
  await sleep(300);
  assert.equal(await reloaded(page), false, `${shown} reloaded the page`);
  assert.deepEqual(await windowState(app), CALM, `${shown} ran its menu item`);
  assert.equal(await page.getByTestId('shortcut-capture').count(), 0, `the capture did not end after ${shown}`);
}

const macOnly = { ...limit, skip: process.platform !== 'darwin' && 'macOS menu key equivalents' };

test('real keys: every menu key is recorded during capture and runs no menu item; after the capture ⌘=, ⌘M and ⌘R act again', macOnly, async t => {
  const { app, page, origin } = await connectedSetup(t);
  if (!await canPostKeys(t, app, page)) return;
  await openShortcuts(page);
  for (const entry of MENU_KEYS) {
    await startCapture(page, 'sidebar.left');
    await recordedWithoutMenu(app, page, entry);
  }
  // Out of capture the menu has its keys: View › Zoom In, Window › Minimize, View › Reload.
  await press(app, page, 'eq', F.cmd, async () => (await windowState(app)).zoom > 0, 'View › Zoom In (⌘=)');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.fromId(globalThis.__dashboardId).webContents.setZoomLevel(0));
  await press(app, page, 'm', F.cmd, async () => (await windowState(app)).minimized, 'Window › Minimize (⌘M)');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.fromId(globalThis.__dashboardId).restore());
  await waitFor(async () => !(await windowState(app)).minimized, 'the window back from the Dock');
  await mark(page);
  await press(app, page, 'r', F.cmd, () => reloaded(page), 'View › Reload (⌘R)');
  await connectedTo(app, origin);
});

/** A page on another origin, for a Browser tab guest. */
async function localSite(context) {
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Local page</title><p>local</p>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.defer(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('real keys: a capture that outlives a blur still records the menu keys; focus inside a Browser tab guest', macOnly, async t => {
  const { context, app, page } = await connectedSetup(t);
  if (!await canPostKeys(t, app, page)) return;
  await openShortcuts(page);
  const row = settingsRow(page, 'sidebar.left');

  // The window loses focus to another window and gets it back; the row still waits for keys.
  await startCapture(page, 'sidebar.left');
  await app.evaluate(({ BrowserWindow }) => {
    const other = new BrowserWindow({ width: 200, height: 120, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
    globalThis.__other = other;
    other.focus();
  });
  await waitFor(() => app.evaluate(({ BrowserWindow }) => !BrowserWindow.fromId(globalThis.__dashboardId).isFocused()), 'the dashboard window to lose focus', 10_000);
  await app.evaluate(() => globalThis.__other.destroy());
  assert.equal(await page.getByTestId('shortcut-capture').count(), 1, 'the capture ended on blur');
  for (const entry of [['⌘R', 'r', F.cmd], ['⌘M', 'm', F.cmd]]) {
    if (await page.getByTestId('shortcut-capture').count() === 0) await startCapture(page, 'sidebar.left');
    await recordedWithoutMenu(app, page, entry);
  }

  // Focus inside a Browser tab guest while the row waits (the UI does not lead there: Settings covers
  // the window and choosing Bind puts focus in the dashboard page). The guest is a page of its own:
  // the row never sees its keys and keeps waiting, and the menu items act as they do in any Browser
  // tab (measured on 2026-11-23: ⌘M minimized the window). What the menu did is reported, not asserted.
  const site = await localSite(context);
  await page.evaluate(src => {
    const view = document.createElement('webview');
    view.setAttribute('src', src);
    view.setAttribute('partition', 'persist:alp-browser');
    view.style.cssText = 'position:fixed;width:200px;height:120px;bottom:0;right:0;z-index:2147483647';
    view.dataset.probe = 'capture';
    document.body.append(view);
  }, `${site}/guest`);
  const guest = await waitFor(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url && !contents.isLoading())?.id, `${site}/guest`), 'the guest to load');
  const results = [];
  for (const [shown, key, flags] of [['⌘=', 'eq', F.cmd], ['⌘R', 'r', F.cmd], ['⌘M', 'm', F.cmd]]) {
    if (await page.getByTestId('shortcut-capture').count() === 0) await startCapture(page, 'sidebar.left');
    const before = await shownKeys(row);
    await mark(page);
    await front(app);
    await page.evaluate(() => document.querySelector('webview[data-probe="capture"]')?.focus());
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).focus(), guest);
    const guestFocused = await waitFor(() => app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.hasFocus()'), guest), 'the guest to have focus', 5_000).catch(() => false);
    await bounded(`posting ${shown}`, exec('osascript', ['-l', 'JavaScript', '-e', POST_KEY, String(app.process().pid), String(KEY_CODES[key]), String(flags)]));
    await sleep(1_500);
    const state = await windowState(app);
    results.push({ key: shown, guestFocused, recorded: (await shownKeys(row)) === shown && before !== shown, capturing: await page.getByTestId('shortcut-capture').count().catch(() => -1), reloaded: await reloaded(page), ...state });
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.fromId(globalThis.__dashboardId); window.webContents.setZoomLevel(0); if (window.isMinimized()) window.restore(); });
    await waitFor(async () => !(await windowState(app)).minimized, 'the window back from the Dock');
    if (results.at(-1).reloaded) { await page.waitForLoadState(); await openShortcuts(page); }
  }
  t.diagnostic(`focus in a Browser tab guest during capture: ${JSON.stringify(results)}`);
  for (const result of results) {
    assert.equal(result.guestFocused, true, `the guest did not get focus for ${result.key}`);
    assert.equal(result.recorded, false, `the dashboard row recorded ${result.key} pressed in the guest`);
    assert.equal(result.capturing, 1, `the capture ended on ${result.key} pressed in the guest`);
  }
});
