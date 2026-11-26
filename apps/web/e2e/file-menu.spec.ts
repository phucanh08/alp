// t-a35b (Paseo parity batch 4), through the real UI, gateway and alpd: the Files panel's context
// menu (right click or Shift+F10 on an entry), which changes nothing on the host — Open or
// Expand, Copy path / relative path / name. No create, rename or delete is offered.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => {
  world = await startWorld();
  await mkdir(path.join(world.projects.main, 'src'), { recursive: true });
  await writeFile(path.join(world.projects.main, 'src', 'cart.ts'), 'export const total = 0;\n');
});
test.afterAll(async () => { await world?.close(); });

const dock = page => page.getByRole('complementary', { name: 'Explorer' });
const entry = (page, name) => dock(page).locator(`[data-testid="files-entry"][data-path="${name}"]`);
const menu = page => page.getByTestId('files-context-menu');

test('right click: open, expand, copy path, relative path and name; nothing that writes', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await connect(page, world, world.tokens.filesReader);
  await dock(page).getByRole('tab', { name: 'Files' }).click();
  await expect(entry(page, 'src')).toBeVisible();

  // A folder: Expand, then the copies.
  await entry(page, 'src').click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Expand', 'Copy path', 'Copy relative path', 'Copy name']);
  await page.screenshot({ path: test.info().outputPath('files-context-menu.png') });
  await menu(page).getByTestId('files-menu-toggle').click();
  await expect(entry(page, 'src/cart.ts')).toBeVisible();

  // A file, by keyboard: Shift+F10 opens the menu on the focused entry.
  await entry(page, 'src/cart.ts').focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Open', 'Copy path', 'Copy relative path', 'Copy name']);
  await expect(menu(page)).not.toContainText(/Delete|Rename|New file|New folder/);
  await menu(page).getByTestId('files-menu-copy-relative').click();
  await expect(menu(page)).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('src/cart.ts');
  await entry(page, 'src/cart.ts').click({ button: 'right' });
  await menu(page).getByTestId('files-menu-copy-path').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${world.projects.main.replace(/\/+$/, '')}/src/cart.ts`);
  await entry(page, 'src/cart.ts').click({ button: 'right' });
  await menu(page).getByTestId('files-menu-copy-name').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('cart.ts');

  // Escape closes it; Open opens the file in a tab.
  await entry(page, 'src/cart.ts').click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await entry(page, 'src/cart.ts').click({ button: 'right' });
  await menu(page).getByTestId('files-menu-open').click();
  await expect(page.getByRole('main').getByTestId('file-view')).toHaveAttribute('data-path', 'src/cart.ts');
});
