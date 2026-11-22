// ALP.app's Browser tab (t-9116) as a normal browser sees it: the + menu and a New tab pane do not
// offer Browser, and a Browser tab kept from ALP.app (same layout in localStorage) says where it works.
// With ALP.app's marker in the user agent the menu offers it after Diff, as Paseo's. What a Browser
// tab may load is apps/desktop's e2e (e2e/browser.spec.mjs).
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

test('Browser is offered only in ALP.app; elsewhere a kept Browser tab says so', async ({ browser }) => {
  // A browser that carries ALP.app's marker: Browser after Diff, and it opens a Browser tab.
  const marked = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36 ALPDesktop/1', viewport: { width: 1440, height: 900 } });
  const desktop = await marked.newPage();
  await connect(desktop, world);
  await desktop.getByRole('button', { name: 'New tab' }).click();
  await expect(desktop.getByRole('menuitem')).toHaveText(['Agent', 'Terminal', 'Diff', 'Browser', 'Tasks', 'Agents']);
  await desktop.getByRole('menuitem', { name: 'Browser' }).click();
  await expect(desktop.getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true');
  await expect(desktop.getByTestId('browser-address')).toBeVisible();
  // The address bar's own refusals, before anything reaches the page.
  await desktop.getByTestId('browser-address').fill('file:///etc/passwd');
  await desktop.getByTestId('browser-address').press('Enter');
  await expect(desktop.getByTestId('browser-error')).toContainText('only http and https');
  await desktop.getByTestId('browser-address').fill('two words');
  await desktop.getByTestId('browser-address').press('Enter');
  await expect(desktop.getByTestId('browser-error')).toContainText('no search');
  const state = await marked.storageState();
  await marked.close();

  // A normal browser with the same storage: no Browser in the + menu or a New tab pane, and the kept
  // Browser tab shows the note instead of a page.
  const plain = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
  const page = await plain.newPage();
  await connect(page, world);
  await expect(page.getByRole('tab', { name: 'Browser' })).toBeVisible();
  await page.getByRole('tab', { name: 'Browser' }).click();
  await expect(page.getByTestId('browser-unavailable')).toContainText('Only available in ALP.app');
  await expect(page.locator('webview')).toHaveCount(0);
  await page.getByRole('button', { name: 'New tab' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Agent', 'Terminal', 'Diff', 'Tasks', 'Agents']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More actions' }).first().click();
  await page.getByTestId('workspace-split-pane-right').click();
  await expect(page.getByTestId('workspace-pane-new-tab-panel')).toBeVisible();
  await expect(page.getByTestId('workspace-pane-new-tab-browser')).toHaveCount(0);
  await expect(page.getByTestId('workspace-pane-new-tab-diff')).toBeVisible();
  await plain.close();
});

test('an address submitted before the Browser tab guest is ready loads once it is (t-a876)', async ({ browser }) => {
  // ALP.app's <webview> as the page sees it: loadURL throws, synchronously, until the guest has
  // emitted dom-ready. On a slow start (a cold machine) a user types an address before then.
  const marked = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36 ALPDesktop/1', viewport: { width: 1440, height: 900 } });
  await marked.addInitScript(() => {
    const views = [];
    window.__loads = [];
    window.__thrown = 0;
    const create = Document.prototype.createElement;
    Document.prototype.createElement = function (name, options) {
      const element = create.call(this, name, options);
      if (String(name).toLowerCase() !== 'webview') return element;
      let ready = false;
      Object.assign(element, {
        loadURL(url) {
          if (!ready) { window.__thrown += 1; throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.'); }
          window.__loads.push(url);
          return Promise.resolve();
        },
        getWebContentsId: () => 7, canGoBack: () => false, canGoForward: () => false,
        __ready() { ready = true; element.dispatchEvent(new Event('dom-ready')); },
      });
      views.push(element);
      return element;
    };
    window.__readyAll = () => { for (const view of views) if (view.isConnected) view.__ready(); };
  });
  const desktop = await marked.newPage();
  await connect(desktop, world);
  await desktop.getByRole('button', { name: 'New tab' }).click();
  await desktop.getByRole('menuitem', { name: 'Browser' }).click();
  const address = desktop.getByTestId('browser-address');
  await address.fill('127.0.0.1:5173/early');
  await address.press('Enter');
  // Not loaded, not thrown, not refused: it waits for the guest.
  await expect(desktop.getByTestId('browser-error')).toHaveCount(0);
  expect(await desktop.evaluate(() => [window.__loads, window.__thrown])).toEqual([[], 0]);
  await desktop.evaluate(() => window.__readyAll());
  await expect.poll(() => desktop.evaluate(() => window.__loads)).toEqual(['http://127.0.0.1:5173/early']);
  // Once ready, an address loads at once.
  await address.fill('127.0.0.1:5173/later');
  await address.press('Enter');
  await expect.poll(() => desktop.evaluate(() => window.__loads)).toEqual(['http://127.0.0.1:5173/early', 'http://127.0.0.1:5173/later']);
  expect(await desktop.evaluate(() => window.__thrown)).toBe(0);
  await marked.close();
});

/**
 * ALP.app's <webview> as the page sees it, for the tests below: each one a guest with its own id
 * (window.__views[n].__id), loadURL recorded in window.__loads; it throws until __ready() and, after,
 * refuses (a rejected promise, or a throw) while window.__refuse says so.
 */
const fakeWebview = () => {
  const views = [];
  window.__views = views;
  window.__loads = [];
  window.__refuse = '';
  const create = Document.prototype.createElement;
  Document.prototype.createElement = function (name, options) {
    const element = create.call(this, name, options);
    if (String(name).toLowerCase() !== 'webview') return element;
    let ready = false;
    const id = 100 + views.length;
    Object.assign(element, {
      __id: id,
      loadURL(url) {
        if (!ready || window.__refuse === 'throw') throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.');
        if (window.__refuse === 'reject') return Promise.reject(new Error('ERR_BLOCKED_BY_CLIENT'));
        window.__loads.push([id, url]);
        return Promise.resolve();
      },
      getWebContentsId: () => id, canGoBack: () => false, canGoForward: () => false,
      __ready() { ready = true; element.dispatchEvent(new Event('dom-ready')); },
    });
    views.push(element);
    return element;
  };
  window.__readyAll = () => { for (const view of views) if (view.isConnected) view.__ready(); };
};
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36 ALPDesktop/1';
const OPEN_EVENT = 'alp-desktop:browser-open';
const BLOCKED_EVENT = 'alp-desktop:browser-blocked';

test('a load refused after the Browser tab guest is ready shows the error line (t-a876 review)', async ({ browser }) => {
  const marked = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1440, height: 900 } });
  await marked.addInitScript(fakeWebview);
  const desktop = await marked.newPage();
  await connect(desktop, world);
  await desktop.getByRole('button', { name: 'New tab' }).click();
  await desktop.getByRole('menuitem', { name: 'Browser' }).click();
  await desktop.evaluate(() => window.__readyAll());
  const address = desktop.getByTestId('browser-address');
  // Refused as a rejected promise (what ALP.app's main process does for a refused address)…
  await desktop.evaluate(() => { window.__refuse = 'reject'; });
  await address.fill('127.0.0.1:5173/refused');
  await address.press('Enter');
  await expect(desktop.getByTestId('browser-error')).toHaveText('http://127.0.0.1:5173/refused is blocked in Browser or did not load.');
  // …or thrown synchronously: the same line, nothing loaded.
  await desktop.evaluate(() => { window.__refuse = 'throw'; });
  await address.fill('127.0.0.1:5173/thrown');
  await address.press('Enter');
  await expect(desktop.getByTestId('browser-error')).toHaveText('http://127.0.0.1:5173/thrown is blocked in Browser or did not load.');
  expect(await desktop.evaluate(() => window.__loads)).toEqual([]);
  // A load that goes through clears it.
  await desktop.evaluate(() => { window.__refuse = ''; });
  await address.fill('127.0.0.1:5173/fine');
  await address.press('Enter');
  await expect.poll(() => desktop.evaluate(() => window.__loads.map(([, url]) => url))).toEqual(['http://127.0.0.1:5173/fine']);
  await expect(desktop.getByTestId('browser-error')).toHaveCount(0);
  await marked.close();
});

test('Browser tab pages stay alive behind other tabs and across panes; blocked navigation is said in its own tab (t-a35b)', async ({ browser }) => {
  const marked = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1440, height: 900 } });
  await marked.addInitScript(fakeWebview);
  const desktop = await marked.newPage();
  await connect(desktop, world);
  await desktop.getByRole('button', { name: 'New tab' }).click();
  await desktop.getByRole('menuitem', { name: 'Browser' }).click();
  await desktop.evaluate(() => window.__readyAll());
  await desktop.getByTestId('browser-address').fill('127.0.0.1:5173/kept');
  await desktop.getByTestId('browser-address').press('Enter');
  await expect.poll(() => desktop.evaluate(() => window.__loads)).toEqual([[100, 'http://127.0.0.1:5173/kept']]);
  const first = desktop.locator('[data-testid="browser-resident"][data-browser="b1"]');
  await expect(first).toHaveAttribute('data-shown', 'true');

  // Another tab in front: the page is kept (the same <webview>, still in the document) but hidden,
  // inert and out of the pointer's way; the address typed stays.
  await desktop.getByRole('button', { name: 'New tab' }).click();
  await desktop.getByRole('menuitem', { name: 'Tasks' }).click();
  await expect(first).toHaveAttribute('data-shown', 'false');
  await expect(first).toHaveAttribute('inert', '');
  await expect(first).toBeHidden();
  expect(await first.evaluate(element => [getComputedStyle(element).visibility, getComputedStyle(element).pointerEvents])).toEqual(['hidden', 'none']);
  expect(await desktop.evaluate(() => window.__views.map(view => [view.__id, view.isConnected]))).toEqual([[100, true]]);
  const center = await desktop.getByTestId('workspace-pane-main').boundingBox();
  expect(await desktop.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="browser-resident"]'), [center.x + center.width / 2, center.y + center.height / 2])).toBe(false);

  // A hidden page's window.open still opens a tab (the opener is not unmounted).
  await desktop.evaluate(([type]) => window.dispatchEvent(new CustomEvent(type, { detail: { guest: 100, url: 'http://127.0.0.1:5173/opened' } })), [OPEN_EVENT]);
  await expect(desktop.locator('[data-tab^="browser:"]')).toHaveCount(2);
  await expect(desktop.locator('[data-testid="browser-resident"][data-browser="b2"]')).toHaveAttribute('data-shown', 'true');
  await desktop.evaluate(() => window.__readyAll());

  // A blocked navigation of the first page: said in its tab only, as text.
  const spoof = 'http://x.test/<img src=x onerror="window.__owned=1">';
  await desktop.evaluate(([type, url]) => window.dispatchEvent(new CustomEvent(type, { detail: { guest: 100, url } })), [BLOCKED_EVENT, spoof]);
  await expect(desktop.locator('[data-testid="browser-resident"][data-browser="b2"]').getByTestId('browser-error')).toHaveCount(0);
  await desktop.locator('[data-tab="browser:b1"]').click();
  await expect(first).toHaveAttribute('data-shown', 'true');
  await expect(first.getByTestId('browser-error')).toHaveText(`Blocked navigation to ${spoof}`);
  expect(await desktop.evaluate(() => [window.__owned ?? null, document.querySelectorAll('[data-testid="browser-error"] img').length])).toEqual([null, 0]);
  await expect(first.getByTestId('browser-address')).toHaveValue('http://127.0.0.1:5173/kept');

  // Moved to another pane: the same <webview>, laid over the new pane.
  await desktop.getByRole('button', { name: 'More actions' }).first().click();
  await desktop.getByTestId('workspace-split-pane-right').click();
  await expect(desktop.getByTestId('workspace-pane-new-tab-panel')).toBeVisible();
  await desktop.locator('[data-tab="browser:b1"]').click();
  await desktop.keyboard.press('ControlOrMeta+K');
  const palette = desktop.getByRole('dialog', { name: 'Command center' });
  await palette.getByRole('combobox').fill('move tab right');
  await palette.getByTestId('command-center-action-pane-move-tab-right').click();
  await expect(desktop.getByTestId('workspace-pane-pane-1').locator('[data-tab="browser:b1"]')).toHaveCount(1);
  await expect(first).toHaveAttribute('data-shown', 'true');
  const right = await desktop.getByTestId('workspace-pane-pane-1').locator('[data-testid="browser-slot"]').boundingBox();
  const shown = await first.boundingBox();
  expect(Math.abs(shown.x - right.x) + Math.abs(shown.y - right.y) + Math.abs(shown.width - right.width) + Math.abs(shown.height - right.height)).toBeLessThan(4);
  expect(await desktop.evaluate(() => window.__views.map(view => [view.__id, view.isConnected]))).toEqual([[100, true], [101, true]]);
  expect(await desktop.evaluate(() => window.__loads.filter(([id]) => id === 100).length)).toBe(1);

  // Closing the tab removes its page.
  await desktop.getByTestId('workspace-pane-pane-1').getByRole('button', { name: 'Close Browser' }).click();
  await expect(desktop.locator('[data-tab="browser:b1"]')).toHaveCount(0);
  expect(await desktop.evaluate(() => window.__views.map(view => [view.__id, view.isConnected]))).toEqual([[100, false], [101, true]]);
  await marked.close();
});
