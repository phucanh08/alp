// t-7679.18, through the real UI, gateway and alpd (fake Codex): reading workspace files remotely
// as Paseo does — the command center's file pick opens a read-only file tab, the Files panel
// browses the tree, a file link in an agent's reply opens the file, and a token without files.read
// (the default, as the owner's here) keeps the clipboard fallback and plain-text links.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, newSession, send, users } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => {
  world = await startWorld();
  const root = world.projects.main;
  await mkdir(path.join(root, 'src', 'checkout'), { recursive: true });
  await mkdir(path.join(root, 'build'), { recursive: true });
  await writeFile(path.join(root, 'src', 'checkout', 'cart-total.ts'), 'export const total = 0;\nexport const tax = 0.1;\nexport const sum = total + tax;\n');
  await writeFile(path.join(root, 'NOTES.md'), '# Release notes\n\nThe **cart** is ready.\n');
  await writeFile(path.join(root, '.editorconfig'), 'root = true\n');
  await writeFile(path.join(root, '.env'), 'API_KEY=never-shown\n');
  // alpd asks git which files .gitignore hides: the workspace is a repository.
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  await writeFile(path.join(root, '.gitignore'), 'build/\n*.log\n');
  await writeFile(path.join(root, 'build', 'out.js'), 'console.log("built");\n');
  await writeFile(path.join(root, 'debug.log'), 'a log line\n');
  await writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
  await writeFile(path.join(root, 'big.txt'), 'x'.repeat(1024 * 1024 + 10));
});
test.afterAll(async () => { await world?.close(); });

const center = page => page.getByRole('dialog', { name: 'Command center' });
const body = page => page.locator('body').click({ position: { x: 700, y: 300 } });
const dock = page => page.getByRole('complementary', { name: 'Explorer' });
const fileView = page => page.getByRole('main').getByTestId('file-view');
const fileTab = (page, file) => page.getByRole('main').locator(`[data-tab="file:${file}"]`);

async function openFilesPanel(page) {
  await dock(page).getByRole('tab', { name: 'Files' }).click();
  await expect(dock(page).getByTestId('files-panel')).toBeVisible();
}
const entry = (page, file) => dock(page).locator(`[data-testid="files-entry"][data-path="${file}"]`);

test('Cmd/Ctrl+P picks a file: it opens in a file tab with its lines numbered', async ({ page }) => {
  await connect(page, world, world.tokens.filesReader);
  await body(page);
  await page.keyboard.press('ControlOrMeta+P');
  const dialog = center(page);
  await dialog.getByTestId('command-center-input').fill('cart');
  await expect(dialog.getByTestId('command-center-file').first()).toHaveAttribute('data-path', 'src/checkout/cart-total.ts');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(fileTab(page, 'src/checkout/cart-total.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(fileTab(page, 'src/checkout/cart-total.ts')).toContainText('cart-total.ts');
  const view = fileView(page);
  await expect(view.getByTestId('file-view-path')).toHaveText('src/checkout/cart-total.ts');
  await expect(view.getByTestId('file-view-content')).toHaveText('export const total = 0;\nexport const tax = 0.1;\nexport const sum = total + tax;\n');
  await expect(view.getByTestId('file-view-gutter')).toHaveText('1\n2\n3');
  await expect(view.getByTestId('file-view-meta')).toHaveText('80 B · 3 lines');
  // No clipboard notice: the file opened.
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toHaveCount(0);

  // A reload (and connecting again) keeps the file tab, in front.
  await page.reload();
  await connect(page, world, world.tokens.filesReader);
  await expect(fileTab(page, 'src/checkout/cart-total.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(fileView(page).getByTestId('file-view-content')).toContainText('export const tax = 0.1;');
});

test('the Files panel: tree, folders on demand, hidden files, never .env; Markdown preview', async ({ page }) => {
  await connect(page, world, world.tokens.filesReader);
  await openFilesPanel(page);
  const entries = dock(page).getByTestId('files-entry');
  // Directories first; dot-names, ignored files (build/, debug.log), .env and .alp are not shown.
  await expect(entries).toHaveText(['src', 'ALP.md', 'big.txt', 'logo.png', 'NOTES.md']);
  await entry(page, 'src').click();
  await entry(page, 'src/checkout').click();
  await expect(entry(page, 'src/checkout/cart-total.ts')).toBeVisible();
  await entry(page, 'src/checkout/cart-total.ts').click();
  await expect(fileTab(page, 'src/checkout/cart-total.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(fileView(page).getByTestId('file-view-content')).toContainText('export const total = 0;');

  // The sort cycles name → modified → size.
  await expect(dock(page).getByTestId('files-sort')).toHaveAttribute('data-sort', 'name');
  await dock(page).getByTestId('files-sort').click();
  await expect(dock(page).getByTestId('files-sort')).toHaveAttribute('data-sort', 'modified');
  await dock(page).getByTestId('files-sort').click();
  await expect(dock(page).getByTestId('files-sort')).toHaveAttribute('data-sort', 'size');
  await expect(entries.filter({ hasText: /^(big\.txt|logo\.png|NOTES\.md)$/ })).toHaveText(['big.txt', 'NOTES.md', 'logo.png']);
  await dock(page).getByTestId('files-sort').click();

  // Show hidden files: dot-names and what .gitignore hides; .env and .alp still never.
  await dock(page).getByTestId('files-show-hidden').click();
  await expect(entry(page, '.editorconfig')).toBeVisible();
  await expect(entry(page, '.gitignore')).toBeVisible();
  await expect(entry(page, 'build')).toBeVisible();
  await expect(entry(page, 'debug.log')).toBeVisible();
  await expect(entry(page, '.env')).toHaveCount(0);
  await expect(entry(page, '.alp')).toHaveCount(0);
  await expect(dock(page)).not.toContainText('.env');
  await dock(page).getByTestId('files-show-hidden').click();
  await expect(entry(page, 'debug.log')).toHaveCount(0);

  // Markdown opens on its preview; Source shows the text.
  await entry(page, 'NOTES.md').click();
  await expect(fileView(page).getByTestId('file-view-preview').getByRole('heading', { name: 'Release notes' })).toBeVisible();
  await fileView(page).getByRole('button', { name: 'Source' }).click();
  await expect(fileView(page).getByTestId('file-view-content')).toContainText('The **cart** is ready.');

  // Binary and too-large files say so, as Paseo's file pane.
  await entry(page, 'logo.png').click();
  await expect(fileView(page).getByTestId('file-view-error')).toHaveAttribute('data-reason', 'binary');
  await expect(fileView(page).getByTestId('file-view-error')).toContainText('Binary preview unavailable');
  await entry(page, 'big.txt').click();
  await expect(fileView(page).getByTestId('file-view-error')).toHaveAttribute('data-reason', 'too_large');
  await expect(fileView(page).getByTestId('file-view-error')).toContainText('This file is too large to display');
});

test('a file link in the agent\'s reply opens the file at its line; an ignored file shows on demand', async ({ page }) => {
  await connect(page, world, world.tokens.filesReader);
  await newSession(page, 'Links');
  await send(page, 'Look at `src/checkout/cart-total.ts:2` and `build/out.js` and `.env`');
  await idle(page);
  const reply = assistant(page).last();
  await expect(reply).toContainText('Echo: Look at');
  const links = reply.getByTestId('chat-file-link');
  await expect(links).toHaveCount(2);
  // The user's own message stays text; a blocked path is never a link.
  await expect(users(page).last().getByTestId('chat-file-link')).toHaveCount(0);
  await links.filter({ hasText: 'cart-total.ts:2' }).click();
  await expect(fileTab(page, 'src/checkout/cart-total.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(fileView(page).getByTestId('file-view-target-line')).toBeVisible();
  await expect(fileView(page).getByTestId('file-view-content')).toContainText('export const tax');

  // build/ is .gitignore'd: hidden by default, "Show anyway" reads it.
  await page.getByRole('main').locator('[data-tab^="agent:"]').first().click();
  await assistant(page).last().getByTestId('chat-file-link').filter({ hasText: 'build/out.js' }).click();
  await expect(fileView(page).getByTestId('file-view-error')).toHaveAttribute('data-reason', 'ignored');
  await fileView(page).getByTestId('file-view-show-ignored').click();
  await expect(fileView(page).getByTestId('file-view-content')).toHaveText('console.log("built");\n');
});

test('a token without files.read: the Files panel says how to get it, links stay text, a pick copies the path', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await connect(page, world, world.tokens.owner);
  await dock(page).getByRole('tab', { name: 'Files' }).click();
  const note = dock(page).getByTestId('files-forbidden');
  await expect(note).toContainText('This access token cannot read files (needs files.read).');
  await expect(note).toContainText('--permission files.read');

  await newSession(page, 'No files');
  await send(page, 'See `src/checkout/cart-total.ts:2`');
  await idle(page);
  await expect(assistant(page).last()).toContainText('Echo: See');
  await expect(assistant(page).last().getByTestId('chat-file-link')).toHaveCount(0);

  await body(page);
  await page.keyboard.press('ControlOrMeta+P');
  await center(page).getByTestId('command-center-input').fill('cart-total');
  await expect(center(page).getByTestId('command-center-file').first()).toHaveAttribute('data-path', 'src/checkout/cart-total.ts');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Copied src/checkout/cart-total.ts (this access token cannot read files)' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('src/checkout/cart-total.ts');
  await expect(page.getByRole('main').locator('[data-tab^="file:"]')).toHaveCount(0);
});
