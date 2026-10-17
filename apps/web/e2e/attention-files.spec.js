// t-7679.10, through the real UI, gateway and alpd (fake Codex): Paseo's finished attention on a
// session that is not open (question.watch { turns: true }), the command center's Files scope
// (Cmd/Ctrl+P, workspace.files.search) and its Workspaces section.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect, newSession, send } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => {
  world = await startWorld();
  await mkdir(path.join(world.projects.main, 'src', 'checkout'), { recursive: true });
  await writeFile(path.join(world.projects.main, 'src', 'checkout', 'cart-total.ts'), 'export const total = 0;\n');
  await writeFile(path.join(world.projects.main, 'NOTES.md'), '# notes\n');
});
test.afterAll(async () => { await world?.close(); });

const nav = page => page.getByRole('navigation', { name: 'Workspaces and sessions' });
const row = (page, title) => nav(page).getByTestId('session-row').filter({ hasText: title });
const center = page => page.getByRole('dialog', { name: 'Command center' });
const body = page => page.locator('body').click({ position: { x: 700, y: 300 } });

test('a turn that finishes in a session not open marks its row and the favicon; opening it clears them', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Long job');
  await send(page, 'Count to ten [slow]');
  await expect(row(page, 'Long job').locator('[data-status]')).toHaveAttribute('data-status', 'running');
  // Another session opens while the first works: the first is no longer attached.
  await newSession(page, 'Elsewhere');
  // Its turn ends (about three seconds): Paseo's green "finished" dot, the favicon's attention.
  await expect(row(page, 'Long job').locator('[data-status]')).toHaveAttribute('data-status', 'attention', { timeout: 15_000 });
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('data-status', 'attention');
  await expect(row(page, 'Elsewhere').locator('[data-status]')).toHaveAttribute('data-status', 'done');
  // History shows it too.
  await nav(page).getByTestId('sidebar-history').click();
  await expect(page.getByTestId('history-row').filter({ hasText: 'Long job' }).getByTestId('history-row-attention')).toHaveText('Finished');
  await page.getByTestId('history-row').filter({ hasText: 'Long job' }).click();
  // Opened: the user looks at it, the attention goes.
  await expect(page.getByRole('heading', { level: 1, name: 'Long job' })).toBeVisible();
  await expect(row(page, 'Long job').locator('[data-status]')).toHaveAttribute('data-status', 'done');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('data-status', 'none');
});

test('Cmd/Ctrl+P searches the workspace\'s files; picking one copies its path', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await connect(page, world);
  await body(page);
  await page.keyboard.press('ControlOrMeta+P');
  const dialog = center(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('command-center-files-scope')).toHaveText('Files');
  const input = dialog.getByTestId('command-center-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('placeholder', 'Search files...');
  // The empty query lists the shallowest files; only files show in the scope.
  await expect(dialog.getByRole('group')).toHaveText([/^Files/]);
  await expect(dialog.getByTestId('command-center-file').filter({ hasText: 'NOTES.md' })).toBeVisible();
  await input.fill('cart');
  // The empty query's list may already hold it: wait for the host's answer to 'cart' to rank it first.
  await expect(dialog.getByTestId('command-center-file').first()).toHaveAttribute('data-path', 'src/checkout/cart-total.ts');
  const file = dialog.getByTestId('command-center-file').filter({ hasText: 'cart-total.ts' });
  await expect(file).toHaveAttribute('data-path', 'src/checkout/cart-total.ts');
  await expect(file).toContainText('src/checkout');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  // Paseo opens the file; ALP has no file read yet: the relative path goes to the clipboard.
  await expect(page.getByRole('status').filter({ hasText: 'Copied src/checkout/cart-total.ts' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('src/checkout/cart-total.ts');

  // Backspace in the empty field drops the scope; outside it a query adds a Files section.
  await page.keyboard.press('ControlOrMeta+P');
  await expect(dialog.getByTestId('command-center-files-scope')).toBeVisible();
  await input.press('Backspace');
  await expect(dialog.getByTestId('command-center-files-scope')).toHaveCount(0);
  await expect(input).toHaveAttribute('placeholder', 'Search commands, files, workspaces, and agents...');
  await input.fill('cart-total');
  await expect(dialog.getByRole('group', { name: 'Files' }).getByTestId('command-center-file')).toHaveAttribute('data-path', 'src/checkout/cart-total.ts');
  await page.keyboard.press('Escape');

  // The shortcut is listed in Paseo's General section.
  await body(page);
  await page.keyboard.press('Shift+?');
  const help = page.getByRole('dialog', { name: 'Shortcuts' });
  await help.getByLabel('Search shortcuts').fill('search files');
  await expect(help.getByTestId('shortcut-row')).toHaveText([/Search files/]);
});

test('a token without project.read is told it cannot list files', async ({ page }) => {
  const token = world.tokens.sessionsOnly;
  await connect(page, world, token);
  await body(page);
  await page.keyboard.press('ControlOrMeta+P');
  await expect(center(page).getByTestId('command-center-file-search-error')).toHaveText('This access token cannot list files (needs project.read).');
});

test('command center Workspaces: the granted workspaces, and choosing one switches to it', async ({ page }) => {
  await connect(page, world, world.tokens.both);
  await body(page);
  await page.keyboard.press('ControlOrMeta+K');
  const dialog = center(page);
  const workspaces = dialog.getByRole('group', { name: 'Workspaces' }).getByTestId('command-center-workspace');
  await expect(workspaces).toHaveCount(2);
  // By name: "plain" before "shop"; the open one marked.
  await expect(workspaces.nth(0)).toHaveAttribute('data-path', /projects\/plain$/);
  await expect(workspaces.nth(1)).toHaveAttribute('data-path', /projects\/shop$/);
  await expect(workspaces.nth(1)).toHaveAttribute('aria-current', 'true');
  await dialog.getByTestId('command-center-input').fill('plain');
  await dialog.getByRole('group', { name: 'Workspaces' }).getByTestId('command-center-workspace').first().click();
  await expect(dialog).toBeHidden();
  await page.keyboard.press('ControlOrMeta+K');
  await expect(dialog.getByTestId('command-center-workspace').filter({ hasText: 'Current' })).toHaveAttribute('data-path', /projects\/plain$/);
});
