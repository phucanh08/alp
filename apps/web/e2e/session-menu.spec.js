// A session row's ⋮ menu, as Paseo's workspace menu (t-747e; sidebar-workspace-menu.tsx): Copy path,
// Copy branch name, Rename, Mark as read / Mark as unread, Open in file manager, Archive (⇧⌘⌫), in that
// order, through the real UI, gateway and alpd. Readers get the copy items only; Open in file manager
// is the host owner's ALP.app only (alp dashboard's link with ALP.app's user agent), and opens the
// workspace's directory on the host (a recording program stands in for the file manager here).
// Real alpd, fake Codex, no fixed waits.
import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { chmod, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { connect as hostConnect } from '@anhlp/alp-client';
import { startWorld } from './support/world.js';
import { closeWorldAfter } from './support/cleanup.js';
import { dashboardSettings, startDashboard } from './support/dashboard.js';
import { connect, newSession } from './support/app.js';

const git = promisify(execFile);
const DESKTOP_MARKER = 'ALPDesktop/1';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
/** @type {Awaited<ReturnType<typeof startDashboard>>} */
let dashboard;
/** Where the stand-in file manager writes the directory it was asked to open. */
let opened;

async function host(method, params = {}) {
  const client = await hostConnect(world.socket);
  try { return await client.request(method, params); } finally { client.close(); }
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  world = await startWorld({ settings: await dashboardSettings() });
  // A Git checkout on a branch, so the owner's sidebar knows it (host.workspace.facts).
  const main = world.projects.main;
  await git('git', ['init', '-q', '-b', 'feature/session-menu'], { cwd: main });
  await git('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'start'], { cwd: main });
  const { revision } = await host('project.list', {});
  await host('project.register', { directory: await realpath(main), ifRevision: revision, requestId: 'session-menu' });
  opened = path.join(world.directory, 'opened.txt');
  const fileManager = path.join(world.directory, 'file-manager.sh');
  await writeFile(fileManager, `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`);
  await chmod(fileManager, 0o755);
  dashboard = await startDashboard(world, { env: { ALP_DASHBOARD_FILE_MANAGER: fileManager } });
});
test.afterAll(async () => {
  if (world) await closeWorldAfter(world, async () => { await dashboard?.stop(); });
});

const nav = page => page.getByRole('navigation', { name: 'Workspaces and sessions' });
const row = (page, title) => nav(page).getByTestId('session-row').filter({ hasText: title });

/** Opens a row's ⋮ menu and answers it with the labels of its items, in order. */
async function openMenu(page, title) {
  await row(page, title).hover();
  await nav(page).getByRole('button', { name: `Actions for ${title}` }).click();
  const menu = page.getByRole('menu', { name: `Actions for ${title}` });
  await expect(menu).toBeVisible();
  return menu;
}
const labels = menu => menu.getByRole('menuitem').evaluateAll(items => items.map(item => item.querySelector('span')?.textContent?.trim() ?? item.textContent?.trim()));
/** The host's row of the session titled `title`, by either spelling of the project's path (a temporary directory may sit under a symbolic link). */
async function sessionOf(title, extra = {}) {
  for (const projectRoot of new Set([world.projects.main, await realpath(world.projects.main)])) {
    // A root nobody has open is closed, and still in the sidebar.
    const found = (await host('session.list', { projectRoot, includeClosed: true, ...extra })).sessions.find(session => session.title === title);
    if (found) return found;
  }
  return undefined;
}

test('a writer\'s menu: Paseo\'s items in order; copy, rename, mark unread then read, archive change what they say', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await connect(page, world);
  await newSession(page, 'Menu first');
  await newSession(page, 'Menu second');

  let menu = await openMenu(page, 'Menu first');
  // Not the owner: no file manager. The checkout's branch is known. Not in front and idle: Mark as unread.
  expect(await labels(menu)).toEqual(['Copy path', 'Copy branch name', 'Rename', 'Mark as unread', 'Archive']);
  await expect(menu.getByTestId('sidebar-workspace-menu-archive')).toContainText(/⇧⌘⌫|Ctrl\+Shift\+⌫/);

  // Copy path: the session's directory on the host.
  await menu.getByRole('menuitem', { name: 'Copy path' }).click();
  await expect(menu).toBeHidden();
  await expect.poll(async () => realpath(await page.evaluate(() => navigator.clipboard.readText())).catch(() => '')).toBe(await realpath(world.projects.main));
  menu = await openMenu(page, 'Menu first');
  await menu.getByRole('menuitem', { name: 'Copy branch name' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('feature/session-menu');

  // Mark as unread: the host keeps a finished attention for every client; the row shows it.
  menu = await openMenu(page, 'Menu first');
  await menu.getByRole('menuitem', { name: 'Mark as unread' }).click();
  await expect.poll(async () => (await sessionOf('Menu first'))?.attention?.reason).toBe('finished');
  await expect(row(page, 'Menu first').locator('[data-status]')).toHaveAttribute('data-status', 'attention');
  // …and the menu offers Mark as read in its place, which clears it on the host.
  menu = await openMenu(page, 'Menu first');
  expect(await labels(menu)).toEqual(['Copy path', 'Copy branch name', 'Rename', 'Mark as read', 'Archive']);
  await menu.getByRole('menuitem', { name: 'Mark as read' }).click();
  await expect.poll(async () => (await sessionOf('Menu first'))?.attention).toBeUndefined();
  await expect(row(page, 'Menu first').locator('[data-status]')).toHaveAttribute('data-status', 'done');

  // The session in front keeps its mark until the user looks at it again.
  menu = await openMenu(page, 'Menu second');
  await menu.getByRole('menuitem', { name: 'Mark as unread' }).click();
  await expect.poll(async () => (await sessionOf('Menu second'))?.attention?.reason).toBe('finished');
  await expect(row(page, 'Menu second').locator('[data-status]')).toHaveAttribute('data-status', 'attention');
  await row(page, 'Menu second').click();
  await expect.poll(async () => (await sessionOf('Menu second'))?.attention).toBeUndefined();

  // Rename: the session's title changes on the host.
  menu = await openMenu(page, 'Menu first');
  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename session' });
  await rename.getByLabel('Title').fill('Menu renamed');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(row(page, 'Menu renamed')).toHaveCount(1);
  await expect.poll(async () => !!(await sessionOf('Menu renamed'))).toBe(true);

  // Archive: after Paseo's confirmation the row leaves the list and the host archives it.
  menu = await openMenu(page, 'Menu renamed');
  await menu.getByRole('menuitem', { name: 'Archive' }).click();
  const confirm = page.getByRole('dialog', { name: 'Archive session?' });
  await confirm.getByRole('button', { name: 'Archive' }).click();
  await expect(row(page, 'Menu renamed')).toHaveCount(0);
  const archived = await sessionOf('Menu renamed', { includeArchived: true });
  expect(archived?.archived).toBe(true);
});

test('a reader\'s menu has the copy items only', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Menu for readers');
  const reader = await page.context().newPage();
  await connect(reader, world, world.tokens.viewer);
  const menu = await openMenu(reader, 'Menu for readers');
  expect(await labels(menu)).toEqual(['Copy path', 'Copy branch name']);
  await reader.close();
});

test.describe('the host owner\'s ALP.app', () => {
  test.use({ userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 ${DESKTOP_MARKER}` });

  test('adds Copy branch name and Open in file manager, which opens the workspace\'s directory on the host', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: dashboard.origin });
    await page.goto(dashboard.url);
    await expect(page.getByLabel('Access token')).toHaveCount(0);
    const start = () => nav(page).getByRole('button', { name: /^Start a session in / }).first();
    await newSession(page, 'Owner menu', { from: start() });
    await newSession(page, 'Owner other', { from: start() });
    let menu = await openMenu(page, 'Owner menu');
    await expect.poll(() => labels(menu)).toEqual(['Copy path', 'Copy branch name', 'Rename', 'Mark as unread', 'Open in file manager', 'Archive']);
    await menu.getByRole('menuitem', { name: 'Copy branch name' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('feature/session-menu');
    menu = await openMenu(page, 'Owner menu');
    await page.screenshot({ path: path.join(test.info().outputDir, 'owner-session-menu.png') });
    await menu.getByRole('menuitem', { name: 'Open in file manager' }).click();
    await expect.poll(() => readFile(opened, 'utf8').catch(() => '')).toBe(await realpath(world.projects.main));
  });

  test('in a plain browser, the owner has no Open in file manager', async ({ browser }) => {
    const plain = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
    await plain.goto(dashboard.url);
    await expect(plain.getByLabel('Access token')).toHaveCount(0);
    const menu = await openMenu(plain, 'Owner menu');
    await expect.poll(() => labels(menu)).toEqual(['Copy path', 'Copy branch name', 'Rename', 'Mark as unread', 'Archive']);
    await plain.close();
  });
});
