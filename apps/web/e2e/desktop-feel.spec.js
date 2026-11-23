// Paseo parity batch 1 (t-0166) as the page sees it: in ALP.app (its user agent marker) the shortcuts
// are Paseo's desktop set (Mod+W closes the tab, Mod+1-9 and Mod+[ ] go through the sessions, Mod+Alt+1-9
// through the tabs; Alt+1-9 off a Mac) and the Shortcuts dialog lists them; a browser keeps the web set.
// Settings › Notifications sends a test notification once they are allowed. What ALP.app itself does
// (the permission, ⌘W on its own pages, the window's bounds) is apps/desktop's e2e.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect, newSession } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36 ALPDesktop/1';
const heading = (page, name) => page.getByRole('heading', { level: 1, name });
const selected = (page, name) => expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');

test('ALP.app takes Paseo\'s desktop keys; a browser keeps the web ones', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await connect(page, world);
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  const mod = mac ? 'Meta' : 'Control';
  await newSession(page, 'Desk one');
  await newSession(page, 'Desk two');
  const body = () => page.locator('body').click({ position: { x: 700, y: 300 } });
  await body();

  // The dialog lists the desktop keys.
  await page.keyboard.press('Shift+?');
  const help = page.getByRole('dialog', { name: 'Shortcuts' });
  await help.getByLabel('Search shortcuts').fill('close current tab');
  await expect(help.getByTestId('shortcut-row')).toHaveText([mac ? /⌘W/ : /Ctrl\+W/]);
  await help.getByLabel('Search shortcuts').fill('jump to');
  await expect(help.getByTestId('shortcut-row')).toHaveText(mac ? [/Jump to session.*⌘1-9/, /Jump to tab.*⌥⌘1-9/] : [/Jump to session.*Ctrl\+1-9/, /Jump to tab.*Alt\+1-9/]);
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  // Sessions: newest first; Mod+] and Mod+[ step, Mod+digit jumps. The web keys do nothing here.
  await expect(heading(page, 'Desk two')).toBeVisible();
  await page.keyboard.press(`${mod}+BracketRight`);
  await expect(heading(page, 'Desk one')).toBeVisible();
  await page.keyboard.press(`${mod}+BracketLeft`);
  await expect(heading(page, 'Desk two')).toBeVisible();
  await page.keyboard.press(`${mod}+Digit2`);
  await expect(heading(page, 'Desk one')).toBeVisible();
  await page.keyboard.press('Alt+Digit1');
  await expect(heading(page, 'Desk one')).toBeVisible();

  // Tabs: Mod+Alt+digit (Alt+digit off a Mac) jumps, Mod+W closes the current tab.
  await page.keyboard.press(`${mod}+Shift+KeyT`);
  await selected(page, 'Terminal');
  await body();
  await page.keyboard.press(mac ? 'Meta+Alt+Digit1' : 'Alt+Digit1');
  await selected(page, 'Desk one');
  await page.keyboard.press(mac ? 'Meta+Alt+Digit2' : 'Alt+Digit2');
  await selected(page, 'Terminal');
  await body();
  await page.keyboard.press('Alt+Shift+KeyW');
  await expect(page.getByRole('tab', { name: 'Terminal', exact: true })).toHaveCount(1);
  await page.keyboard.press(`${mod}+KeyW`);
  await expect(page.getByRole('tab', { name: 'Terminal', exact: true })).toHaveCount(0);
  await context.close();

  // A browser: the web set, as before.
  const plain = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const web = await plain.newPage();
  await connect(web, world);
  await web.locator('body').click({ position: { x: 700, y: 300 } });
  await web.keyboard.press('Alt+Digit2');
  await expect(heading(web, 'Desk one')).toBeVisible();
  await web.keyboard.press('Shift+?');
  const webHelp = web.getByRole('dialog', { name: 'Shortcuts' });
  await webHelp.getByLabel('Search shortcuts').fill('close current tab');
  await expect(webHelp.getByTestId('shortcut-row')).toHaveText([mac ? /⌥⇧W/ : /Alt\+Shift\+W/]);
  await web.keyboard.press('Escape');
  await web.keyboard.press(`${mod}+Digit1`);
  await expect(heading(web, 'Desk one')).toBeVisible();
  await web.keyboard.press('Alt+Digit1');
  await expect(heading(web, 'Desk two')).toBeVisible();
  await plain.close();
});

test('ALP.app: Mod+W that closes no tab closes the window; never while a dialog is open; a browser never', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { window.__closed = 0; window.close = () => { window.__closed += 1; }; });
  const page = await context.newPage();
  await connect(page, world);
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  const mod = mac ? 'Meta' : 'Control';
  await newSession(page, 'Close one');
  const body = () => page.locator('body').click({ position: { x: 700, y: 300 } });
  await body();
  const closed = () => page.evaluate(() => window.__closed);
  // A tab to close: the tab closes, the window stays.
  await page.keyboard.press(`${mod}+Shift+KeyT`);
  await selected(page, 'Terminal');
  await body();
  await page.keyboard.press(`${mod}+KeyW`);
  await expect(page.getByRole('tab', { name: 'Terminal', exact: true })).toHaveCount(0);
  expect(await closed()).toBe(0);
  // A dialog open: nothing closes.
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Shortcuts' })).toBeVisible();
  await page.keyboard.press(`${mod}+KeyW`);
  await page.waitForTimeout(200);
  expect(await closed()).toBe(0);
  await page.keyboard.press('Escape');
  // History hides the tabs: nothing to close there, so the window closes.
  await page.getByRole('navigation', { name: 'Workspaces and sessions' }).getByTestId('sidebar-history').click();
  await expect(page.getByTestId('history-screen')).toBeVisible();
  await page.keyboard.press(`${mod}+KeyW`);
  await expect.poll(closed).toBe(1);
  await context.close();

  // A browser: Mod+W is the browser's, the page never closes itself.
  const plain = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await plain.addInitScript(() => { window.__closed = 0; window.close = () => { window.__closed += 1; }; });
  const web = await plain.newPage();
  await connect(web, world);
  await web.getByRole('navigation', { name: 'Workspaces and sessions' }).getByTestId('sidebar-history').click();
  await web.keyboard.press(`${mod}+KeyW`);
  await web.waitForTimeout(200);
  expect(await web.evaluate(() => window.__closed)).toBe(0);
  await plain.close();
});

test('Settings › Notifications: Enable, then Send shows a test notification that brings the window forward', async ({ page }) => {
  // The browser's Notification, recorded: what was shown, and the permission prompt's answer.
  await page.addInitScript(() => {
    const shown = [];
    let permission = 'default';
    class FakeNotification {
      static get permission() { return permission; }
      static async requestPermission() { permission = 'granted'; return permission; }
      constructor(title, options = {}) { this.title = title; this.options = options; this.onclick = null; this.closed = false; shown.push(this); }
      close() { this.closed = true; }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
    Object.defineProperty(window, '__notes', { value: shown });
  });
  await connect(page, world);
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  const section = settings.locator('section', { hasText: 'Test notification' });
  await expect(section).toContainText('Test notification');
  await expect(section.getByTestId('notification-test')).toBeDisabled();
  await expect(section).toContainText('Allow notifications before testing.');
  await section.getByRole('button', { name: 'Enable' }).click();
  await expect(section.getByTestId('notification-permission')).toHaveText('Allowed');
  await expect(section.getByTestId('notification-test')).toBeEnabled();
  await section.getByTestId('notification-test').click();
  await expect(section.getByTestId('notification-test-result')).toHaveText('Test notification sent.');
  const note = await page.evaluate(() => ({ title: window.__notes[0]?.title, tag: window.__notes[0]?.options.tag, count: window.__notes.length }));
  expect(note).toEqual({ title: 'Test notification', tag: 'alp-test', count: 1 });
  // Its click focuses the window and closes it.
  const clicked = await page.evaluate(() => {
    let focused = false;
    const focus = window.focus;
    window.focus = () => { focused = true; };
    window.__notes[0].onclick();
    window.focus = focus;
    return { focused, closed: window.__notes[0].closed };
  });
  expect(clicked).toEqual({ focused: true, closed: true });
});

// t-81b0.12: ALP.app on macOS has no title bar of its own and the page leaves the traffic lights room
// through the Window Controls Overlay (styles.css .window-drag); a browser has no overlay, so the
// drag strip, the sidebar's top row and the header's inset are all zero and the page is unchanged.
test('a browser, even with the ALP.app marker, has no window chrome room: no drag strip, no inset', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await connect(page, world);
  const sizes = await page.evaluate(() => {
    const box = selector => { const element = document.querySelector(selector); const rect = element?.getBoundingClientRect(); return rect ? [rect.width, rect.height] : null; };
    return { drag: box('.window-drag'), row: box('nav[aria-label="Workspaces and sessions"] .window-controls-row') };
  });
  expect(sizes.drag).toEqual([1440, 0]);
  expect(sizes.row?.[1]).toBe(0);
  // The sidebar closed: the header starts at its usual place, no room kept.
  await page.getByRole('button', { name: 'Close sessions' }).first().click();
  const inset = page.locator('main header .window-controls-inset');
  await expect(inset).toHaveCount(1);
  expect((await inset.evaluate(element => element.getBoundingClientRect().width))).toBe(0);
  await context.close();
});

// t-81b0.12 follow-up, Paseo's desktop titlebar: with the traffic lights in the page (the Window Controls
// Overlay visible, stubbed here; ALP.app's real one is apps/desktop's e2e), the window owns the sidebar
// toggle, right after the lights, and the explorer toggle, at the right edge. They stay put while the
// panels open and close, the headers keep a slot instead of a second button, and when the overlay goes
// (full screen) the headers draw their own toggles again.
test('ALP.app on macOS: the sidebar and explorer toggles stay in the top row as the panels open and close', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    const overlay = new EventTarget();
    overlay.visible = true;
    overlay.getTitlebarAreaRect = () => new DOMRect(overlay.visible ? 85 : 0, 0, overlay.visible ? 1300 : 0, overlay.visible ? 38 : 0);
    Object.defineProperty(navigator, 'windowControlsOverlay', { value: overlay, configurable: true });
  });
  const page = await context.newPage();
  await connect(page, world);
  const sidebar = page.getByTestId('window-sidebar-toggle');
  const explorer = page.getByTestId('workspace-explorer-toggle');
  const at = async locator => { const box = await locator.boundingBox(); return box && [Math.round(box.x), Math.round(box.y)]; };
  await expect(sidebar).toHaveAttribute('aria-label', 'Close sessions');
  await expect(explorer).toHaveCount(1);
  const start = { sidebar: await at(sidebar), explorer: await at(explorer) };
  // The explorer toggle at the window's right edge, in the explorer's tab row, which keeps it a slot.
  expect(start.explorer[0]).toBe(1440 - 6 - 32);
  await expect(page.getByRole('complementary', { name: 'Explorer' }).getByTestId('window-explorer-toggle-slot')).toHaveCount(1);
  await expect(page.locator('main header').getByRole('button', { name: /sessions$/ })).toHaveCount(0);

  await sidebar.click();
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await expect(sidebar).toHaveAttribute('aria-label', 'Open sessions');
  await expect(sidebar).toBeFocused();
  expect(await at(sidebar)).toEqual(start.sidebar);
  await expect(page.locator('main header').getByTestId('window-sidebar-toggle-slot')).toHaveCount(1);

  await explorer.click();
  await expect(page.getByTestId('explorer-column')).toHaveCount(0);
  await expect(explorer).toHaveAttribute('aria-expanded', 'false');
  expect(await at(explorer)).toEqual(start.explorer);
  await expect(page.locator('main header').getByTestId('window-explorer-toggle-slot')).toHaveCount(1);
  await explorer.click();
  await sidebar.click();
  await expect(page.getByTestId('explorer-column')).toHaveCount(1);
  await expect(page.getByTestId('sidebar-column')).toHaveCount(1);

  // Full screen: no lights, so the headers own the toggles again, as in a browser.
  await page.evaluate(() => { navigator.windowControlsOverlay.visible = false; navigator.windowControlsOverlay.dispatchEvent(new Event('geometrychange')); });
  await expect(sidebar).toHaveCount(0);
  await expect(page.locator('main header').getByRole('button', { name: 'Close sessions' })).toHaveCount(1);
  await expect(page.locator('main header').getByTestId('workspace-explorer-toggle')).toHaveCount(1);
  await context.close();
});
