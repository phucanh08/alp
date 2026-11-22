/**
 * Paseo parity batch 1 (t-0166) in the real Electron app, against a disposable alp dashboard host and a
 * fake `alp` (./support.mjs): notifications allowed for the dashboard's origin only, ⌘W left to the
 * dashboard page (it closes the current tab) and closing the window on a bundled page, the Dock badge
 * read from the dashboard's favicon, and the window's size and place kept across launches.
 * What the page does with the keys is apps/web's e2e (e2e/desktop-feel.spec.js); that a Browser tab is
 * still denied every permission is ./browser.spec.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { closeWindows, connectedTo, fakeAlp, freePort, host, inPage, launch, only, scratch, waitFor } from './support.mjs';

const limit = { timeout: 120_000 };

async function connectedSetup(t) {
  const context = await scratch(t);
  const web = await host(t, context);
  await web.start(await freePort());
  const alp = await fakeAlp(context);
  await alp.prints(web.address);
  return { context, web, alp };
}

/** Sends a key press to the single window, as the keyboard would (before-input-event sees it). */
const press = (app, keyCode, modifiers) => app.evaluate(({ BrowserWindow }, [code, mods]) => {
  const contents = BrowserWindow.getAllWindows()[0].webContents;
  contents.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: mods });
  contents.sendInputEvent({ type: 'char', keyCode: code, modifiers: mods });
  contents.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: mods });
}, [keyCode, modifiers]);
const windowCount = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const MOD = process.platform === 'darwin' ? 'meta' : 'control';

test('notifications: allowed for the alp dashboard page, denied to a bundled page; geolocation stays denied', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  assert.equal(await inPage(app, 'Notification.requestPermission()'), 'granted');
  assert.equal(await inPage(app, 'Notification.permission'), 'granted');
  assert.equal(await inPage(app, "navigator.permissions.query({ name: 'notifications' }).then(s => s.state)"), 'granted');
  assert.equal(await inPage(app, "navigator.permissions.query({ name: 'geolocation' }).then(s => s.state)"), 'denied');
  assert.equal(await inPage(app, "navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', () => 'denied')"), 'denied');
  // A notification the page shows is handed to the system: show, or error where the system refuses
  // (an unsigned Electron under test); either way Chromium let the page create it.
  const shown = await inPage(app, `new Promise(resolve => { const n = new Notification('ALP e2e', { body: 'desktop-feel', silent: true }); n.onshow = () => { n.close(); resolve('show'); }; n.onerror = () => resolve('error'); setTimeout(() => resolve('pending'), 5000); })`);
  t.diagnostic(`notification outcome in the test Electron: ${shown}`);
  assert.notEqual(shown, 'error');

  // A bundled page (alp-page://app, here the error page after a failed connect) gets nothing.
  await alp.set("echo 'error: stopped for the test' >&2; exit 1");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find(item => item.label === 'File')?.submenu?.items.find(entry => entry.label === 'Connect again')?.click());
  await waitFor(async () => (await only(app))?.page === 'error.html', 'the error page');
  assert.equal(await inPage(app, 'Notification.permission'), 'denied');
  assert.equal(await inPage(app, 'Notification.requestPermission()'), 'denied');
});

test('⌘W: no menu item takes it; the dashboard page gets it and the window stays; a bundled page closes', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  // No accelerator on ⌘W (and no Close role, whose default it is) anywhere in the menu bar.
  const items = await app.evaluate(({ Menu }) => {
    const all = [];
    const walk = menu => { for (const item of menu?.items ?? []) { all.push({ label: item.label, role: item.role ?? '', accelerator: String(item.accelerator ?? '') }); walk(item.submenu); } };
    walk(Menu.getApplicationMenu());
    return all;
  });
  assert.ok(items.some(item => item.label === 'Close Window'), JSON.stringify(items.map(item => item.label)));
  assert.deepEqual(items.filter(item => /^(CmdOrCtrl|Cmd|Command|CommandOrControl|Ctrl|Control)\+W$/i.test(item.accelerator) || item.role.toLowerCase() === 'close'), []);

  // The dashboard page receives ⌘W, ⌘1 and ⌘⌥1; the window stays open.
  await inPage(app, "window.__keys = []; window.addEventListener('keydown', e => window.__keys.push([e.metaKey, e.ctrlKey, e.altKey, e.code].join(':'))); 1");
  await press(app, 'W', [MOD]);
  await press(app, '1', [MOD]);
  await press(app, '1', [MOD, 'alt']);
  const keys = await waitFor(async () => { const value = await inPage(app, 'window.__keys'); return value.length >= 3 ? value : undefined; }, 'the page to see the keys');
  const flag = MOD === 'meta' ? 'true:false' : 'false:true';
  assert.deepEqual(keys, [`${flag}:false:KeyW`, `${flag}:false:Digit1`, `${flag}:true:Digit1`]);
  assert.equal(await windowCount(app), 1);
  assert.equal((await only(app))?.origin, web.origin);

  // On a bundled page there are no tabs: ⌘W closes the window, as File › Close Window does.
  await alp.set("echo 'error: stopped for the test' >&2; exit 1");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find(item => item.label === 'File')?.submenu?.items.find(entry => entry.label === 'Connect again')?.click());
  await waitFor(async () => (await only(app))?.page === 'error.html', 'the error page');
  await press(app, 'W', [MOD]);
  await waitFor(async () => (await windowCount(app)) === 0, 'the window to close');
});

test('Dock badge: a dot while the dashboard shows its attention favicon, none otherwise', { ...limit, skip: process.platform !== 'darwin' && 'the Dock is macOS only' }, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  const badge = () => app.evaluate(({ app: electron }) => electron.dock?.getBadge() ?? '');
  const setIcon = href => inPage(app, `(() => { let link = document.querySelector('link[rel="icon"]'); if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); } link.href = ${JSON.stringify(href)}; return 1; })()`);
  await setIcon('/favicon-attention.svg');
  await waitFor(async () => (await badge()) === '•', 'the attention dot');
  await setIcon('/favicon-running.svg');
  await waitFor(async () => (await badge()) === '', 'the dot to go');
  // An icon elsewhere does not count.
  await setIcon('https://example.com/favicon-attention.svg');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await badge(), '');
});

test('the window keeps its size and place across launches; a place on no display is dropped', limit, async t => {
  const { context, web, alp } = await connectedSetup(t);
  const stateFile = path.join(context.dir, 'user-data', 'window-state.json');
  let app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const wanted = { x: area.x + 40, y: area.y + 30, width: Math.min(1000, area.width - 80), height: Math.min(700, area.height - 60) };
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), wanted);
  await waitFor(async () => {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    return saved.width === wanted.width && saved.height === wanted.height && saved.x === wanted.x && saved.y === wanted.y;
  }, 'window-state.json to hold the new bounds', 10_000);
  await closeWindows(app);
  await app.close();

  app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  const reopened = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  assert.deepEqual(reopened, wanted);
  await closeWindows(app);
  await app.close();

  // Saved on a display that is gone: the size is kept (fitted), the place is the system's, on screen.
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ x: -20000, y: -20000, width: 900, height: 600, maximized: false }));
  app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  const placed = await app.evaluate(({ BrowserWindow, screen }) => {
    const bounds = BrowserWindow.getAllWindows()[0].getBounds();
    const display = screen.getDisplayMatching(bounds).workArea;
    const overlap = Math.max(0, Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x));
    return { width: bounds.width, height: bounds.height, onScreen: overlap >= 100 };
  });
  assert.deepEqual(placed, { width: 900, height: 600, onScreen: true });
  await closeWindows(app);
  await app.close();

  // Saved maximized: it opens maximized, and keeps the size it had before for unmaximizing.
  await writeFile(stateFile, JSON.stringify({ ...wanted, maximized: true }));
  app = await launch(t, context, alp.file);
  await connectedTo(app, web.origin);
  await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), 'the window to open maximized', 10_000);
  await closeWindows(app);
  await waitFor(async () => JSON.parse(await readFile(stateFile, 'utf8')).maximized === true, 'window-state.json to say maximized', 10_000);
});
