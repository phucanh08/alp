// Settings › Shortcuts (Paseo's keyboard-shortcuts-section.tsx, t-81b0.13): rebind a shortcut by
// pressing the new keys, clear it, reset one or all; keys another shortcut uses or a key that would
// type are refused; the keys survive a reload and are the ones the window, the Shortcuts dialog and
// the command center's hints use. Through the real UI, gateway and alpd.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { startWorld } from './support/world.ts';
import type { World } from './support/world.ts';
import { connect, newSession } from './support/app.ts';

let world: World;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const nav = (page: Page) => page.getByRole('navigation', { name: 'Workspaces and sessions' });
const openShortcuts = async (page: Page) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  await settings.getByTestId('settings-shortcuts').click();
  await expect(settings.getByTestId('shortcuts-page')).toBeVisible();
  return settings;
};
const closeSettings = async (page: Page) => {
  await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('region', { name: 'Settings' })).toHaveCount(0);
};
const row = (settings: Locator, id: string) => settings.getByTestId(`shortcut-setting-${id}`);
const act = async (page: Page, settings: Locator, id: string, action: string) => {
  const item = page.getByTestId(`shortcut-${action}-${id}`);
  // Scrolling the row into view closes a menu that opened before the scroll event arrived (the
  // Menu closes when its trigger scrolls), so open it again until it stays.
  await row(settings, id).scrollIntoViewIfNeeded();
  await expect(async () => {
    if (!await item.isVisible()) await row(settings, id).getByTestId(`shortcut-actions-${id}`).click();
    await expect(item).toBeVisible({ timeout: 1000 });
  }).toPass();
  await item.click();
};
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('alp-web:preferences') ?? '{}').shortcutOverrides);

test('rebind, conflicts, typing keys, clear, reset one and all; persisted and used everywhere', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Keys');
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  const keys = (key: string) => mac ? `⌘${key}` : `Ctrl+${key}`;
  const explorer = page.getByRole('complementary', { name: 'Explorer' });

  let settings = await openShortcuts(page);
  const left = row(settings, 'sidebar.left');
  await expect(left.getByTestId('shortcut-keys')).toHaveText(keys('B'));
  await expect(settings.getByTestId('shortcuts-reset-all')).toHaveCount(0);
  // The composer's keys are listed but cannot be changed here.
  await expect(row(settings, 'composer.focus')).toContainText('cannot be changed here');
  await expect(row(settings, 'composer.focus').getByRole('button')).toHaveCount(0);

  // Keys another shortcut uses are refused with its name; the capture waits for other keys.
  await act(page, settings, 'sidebar.left', 'bind');
  await expect(left.getByTestId('shortcut-capture')).toHaveText('Press shortcut…');
  await page.keyboard.press('ControlOrMeta+E');
  await expect(left.getByRole('alert')).toHaveText(`${keys('E')} is already used by Toggle Explorer sidebar.`);
  // A key that would type is refused too.
  await page.keyboard.press('J');
  await expect(left.getByRole('alert')).toContainText('Add');
  // While recording, the app's own keys do nothing: Mod+, (Toggle settings) is only refused as taken.
  await page.keyboard.press('ControlOrMeta+Comma');
  await expect(left.getByRole('alert')).toHaveText(`${keys(',')} is already used by Toggle settings.`);
  await expect(settings.getByTestId('shortcuts-page')).toBeVisible();
  // Escape cancels: the old keys stay, Settings stays open.
  await page.keyboard.press('Escape');
  await expect(left.getByTestId('shortcut-capture')).toHaveCount(0);
  await expect(left.getByTestId('shortcut-keys')).toHaveText(keys('B'));
  await expect(settings.getByTestId('shortcuts-page')).toBeVisible();
  expect(await stored(page)).toEqual({});

  // Rebind: the new keys show and are stored.
  await act(page, settings, 'sidebar.left', 'bind');
  await page.keyboard.press('ControlOrMeta+J');
  await expect(left.getByTestId('shortcut-keys')).toHaveText(keys('J'));
  await expect(settings.getByTestId('shortcuts-reset-all')).toBeVisible();
  expect(await stored(page)).toEqual({ 'sidebar.left': 'Mod+J' });
  await page.screenshot({ path: test.info().outputPath('settings-shortcuts.png') });

  // Clear the Explorer's: "Not set", its keys do nothing.
  await act(page, settings, 'sidebar.right', 'clear');
  await expect(row(settings, 'sidebar.right').getByTestId('shortcut-keys')).toHaveText('Not set');
  expect(await stored(page)).toEqual({ 'sidebar.left': 'Mod+J', 'sidebar.right': null });
  await closeSettings(page);

  // The window uses the new keys, not the old ones.
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await expect(nav(page)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(nav(page)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+J');
  await expect(nav(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+J');
  await expect(nav(page)).toBeVisible();
  await expect(explorer).toBeVisible();
  // The cleared Explorer keys and its Ctrl+` alias do nothing (each followed by a key that does).
  await page.keyboard.press('ControlOrMeta+E');
  await page.keyboard.press('ControlOrMeta+J');
  await expect(nav(page)).toBeHidden();
  await expect(explorer).toBeVisible();
  await page.keyboard.press('Control+Backquote');
  await page.keyboard.press('ControlOrMeta+J');
  await expect(nav(page)).toBeVisible();
  await expect(explorer).toBeVisible();

  // The Shortcuts dialog and the command center's hints show the user's keys.
  await page.keyboard.press('Shift+?');
  const help = page.getByRole('dialog', { name: 'Shortcuts' });
  await help.getByLabel('Search shortcuts').fill('sidebar');
  await expect(help.getByTestId('shortcut-row')).toHaveText([new RegExp(`Toggle left sidebar.*${keys('J').replace('+', '\\+')}`), /Toggle Explorer sidebar.*Not set/, /Toggle both sidebars/]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+K');
  const center = page.getByRole('dialog', { name: 'Command center' });
  await page.keyboard.type('left sidebar');
  await expect(center.getByRole('option', { name: /Toggle left sidebar/ })).toContainText(keys('J'));
  await page.keyboard.press('Escape');

  // A reload keeps them.
  await page.reload();
  await connect(page, world);
  settings = await openShortcuts(page);
  await expect(row(settings, 'sidebar.left').getByTestId('shortcut-keys')).toHaveText(keys('J'));
  await expect(row(settings, 'sidebar.right').getByTestId('shortcut-keys')).toHaveText('Not set');

  // Reset one: back to its default, the other change stays.
  await act(page, settings, 'sidebar.left', 'reset');
  await expect(row(settings, 'sidebar.left').getByTestId('shortcut-keys')).toHaveText(keys('B'));
  expect(await stored(page)).toEqual({ 'sidebar.right': null });
  // Now free, the old Explorer keys can go to another shortcut, and Reset all undoes everything.
  await act(page, settings, 'sidebar.both', 'bind');
  await page.keyboard.press('ControlOrMeta+E');
  await expect(row(settings, 'sidebar.both').getByTestId('shortcut-keys')).toHaveText(keys('E'));
  // Resetting the Explorer's now would put two shortcuts on its default keys: refused, with why.
  await act(page, settings, 'sidebar.right', 'reset');
  await expect(row(settings, 'sidebar.right').getByTestId('shortcut-reset-error')).toHaveText(`Its default ${keys('E')} is now used by Toggle both sidebars. Change that shortcut first.`);
  await expect(row(settings, 'sidebar.right').getByTestId('shortcut-keys')).toHaveText('Not set');
  expect(await stored(page)).toEqual({ 'sidebar.right': null, 'sidebar.both': 'Mod+E' });
  await settings.getByTestId('shortcuts-reset-all').click();
  await expect(row(settings, 'sidebar.right').getByTestId('shortcut-reset-error')).toHaveCount(0);
  await expect(row(settings, 'sidebar.right').getByTestId('shortcut-keys')).toHaveText(keys('E'));
  await expect(row(settings, 'sidebar.both').getByTestId('shortcut-keys')).toHaveText(keys('.'));
  await expect(settings.getByTestId('shortcuts-reset-all')).toHaveCount(0);
  expect(await stored(page)).toEqual({});
  await closeSettings(page);
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.press('ControlOrMeta+E');
  await expect(explorer).toBeHidden();
});
