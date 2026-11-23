// t-81b0.12 round 4: Paseo's Settings › General › Open location (v0.17.3) for the sources ALP has,
// through the real UI, gateway and alpd: a file clicked in the Explorer's Files panel opens in the
// side pane (made at the right of the center, then reused), or in the main one; the choice is kept
// in this browser. Settings › About links ALP's repository (Paseo's community links).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect, newSession } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => {
  world = await startWorld();
  const root = world.projects.main;
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n');
  await writeFile(path.join(root, 'NOTES.md'), '# Notes\n');
  await writeFile(path.join(root, 'todo.txt'), 'ship it\n');
});
test.afterAll(async () => { await world?.close(); });

const pane = (page, id) => page.getByTestId(`workspace-pane-${id}`);
const dock = page => page.getByRole('complementary', { name: 'Explorer' });
const entry = (page, name) => dock(page).locator(`[data-testid="files-entry"][data-path="${name}"]`);

async function setFromFiles(page, value) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  const select = settings.getByLabel('Clicking a file in the Explorer sidebar');
  await expect(select).toHaveValue(value === 'side' ? 'main' : 'side');
  await select.selectOption(value);
  await settings.getByRole('button', { name: 'Back' }).click();
}

test('Open location: Explorer files open on the side (one side pane, reused) or in the main panel; the choice is kept', async ({ page }) => {
  await connect(page, world, world.tokens.filesReader);
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  // Paseo's rows ALP has, each Main panel by default.
  for (const row of ['Clicking a file in the Explorer sidebar', 'Clicking a change in the Explorer sidebar', 'Clicking a file in an agent chat']) {
    await expect(settings.getByLabel(row)).toHaveValue('main');
    expect(await settings.getByLabel(row).locator('option').allTextContents()).toEqual(['Main panel', 'On the side']);
  }
  await page.screenshot({ path: test.info().outputPath('settings-open-location.png') });
  await settings.getByRole('button', { name: 'Back' }).click();
  await setFromFiles(page, 'side');
  // Something in the main pane (a pane left empty goes, as Paseo's).
  await newSession(page, 'Side work');

  await dock(page).getByRole('tab', { name: 'Files' }).click();
  await entry(page, 'NOTES.md').click();
  await expect(page.getByTestId('workspace-panes')).toHaveAttribute('data-panes', '2');
  await expect(pane(page, 'pane-1').getByTestId('workspace-tab')).toHaveCount(1);
  await expect(pane(page, 'pane-1').getByTestId('workspace-tab')).toContainText('NOTES.md');
  await entry(page, 'todo.txt').click();
  await expect(page.getByTestId('workspace-panes')).toHaveAttribute('data-panes', '2');
  await expect(pane(page, 'pane-1').getByTestId('workspace-tab')).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath('open-location-side.png') });

  // Kept across a reload; Main panel opens in the focused pane again.
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('alp-web:preferences'))).openInSidePane).toEqual({ explorerFiles: true, diffs: false, chatFiles: false });
  await page.reload();
  await connect(page, world, world.tokens.filesReader);
  await setFromFiles(page, 'main');
  await dock(page).getByRole('tab', { name: 'Files' }).click();
  await entry(page, 'docs').click();
  await entry(page, 'docs/guide.md').click();
  // No new pane: the file opens in the focused one, as any tab does.
  await expect(page.getByTestId('workspace-panes')).toHaveAttribute('data-panes', '2');
  await expect(page.locator('section[data-focused="true"]').getByTestId('workspace-tab').filter({ hasText: 'guide.md' })).toHaveCount(1);
});

test('About: ALP\'s repository as Paseo\'s Star link; no other community link', async ({ page }) => {
  await connect(page, world);
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  await settings.getByTestId('settings-about').click();
  const links = settings.getByTestId('community-links').getByRole('link');
  await expect(links).toHaveCount(1);
  await expect(links).toHaveText('Star');
  await expect(links).toHaveAttribute('href', 'https://github.com/phucanh08/alp');
  await expect(links).toHaveAttribute('target', '_blank');
});
