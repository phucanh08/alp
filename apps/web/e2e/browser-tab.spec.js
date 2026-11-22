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
