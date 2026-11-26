// Paseo parity batch 2 (t-a876), through the real UI, gateway and alpd (fake Codex, no fixed waits):
// the session header's menu (Copy path, Copy branch name, New terminal, New browser tab), Archive's
// Undo toast, the project menu's Remove project, per-session Pin to top and Labels with the sidebar's
// Pinned section, and Settings › Notifications' Play sound and Refresh. Readers get no write item.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { connect as hostConnect } from '@anhlp/alp-client';
import type { RegistryWorkspace, SessionSummary } from '@anhlp/alp-protocol';
import { startWorld } from './support/world.ts';
import type { World } from './support/world.ts';
import { connect, newSession } from './support/app.ts';

const git = promisify(execFile);

let world: World;

// The page global the notification init script below sets.
declare global {
  interface Window { __setPermission(value: string): void }
}
/** The fake Notification's instances, as window.__notes holds them (__notes is not global: other specs record other shapes). */
type Note = { title: string, options: NotificationOptions };
type NotesWindow = typeof window & { __notes: Note[] };

async function host(method: string, params = {}) {
  const client = await hostConnect(world.socket);
  try { return await client.request(method, params); } finally { client.close(); }
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  world = await startWorld({ terminal: true });
  const main = world.projects.main;
  await git('git', ['init', '-q', '-b', 'feature/menus'], { cwd: main });
  await git('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'start'], { cwd: main });
  const { revision } = await host('project.list', {});
  await host('project.register', { directory: await realpath(main), ifRevision: revision, requestId: 'menus' });
});
test.afterAll(async () => { await world?.close(); });

const nav = (page: Page) => page.getByRole('navigation', { name: 'Workspaces and sessions' });
const row = (page: Page, title: string) => nav(page).getByTestId('session-row').filter({ hasText: title });
const labels = (menu: Locator) => menu.getByRole('menuitem').evaluateAll(items => items.map(item => item.querySelector('span')?.textContent?.trim() ?? item.textContent?.trim()));

async function sessionOf(title: string, extra = {}) {
  for (const projectRoot of new Set([world.projects.main, await realpath(world.projects.main)])) {
    const found = (await host('session.list', { projectRoot, includeClosed: true, ...extra })).sessions.find((session: SessionSummary) => session.title === title);
    if (found) return found;
  }
  return undefined;
}

async function headerMenu(page: Page) {
  await page.locator('main header').getByRole('button', { name: 'Session actions' }).click();
  const menu = page.getByRole('menu', { name: 'Session actions' });
  await expect(menu).toBeVisible();
  return menu;
}

async function rowMenu(page: Page, title: string) {
  await row(page, title).first().hover();
  await nav(page).getByRole('button', { name: `Actions for ${title}` }).first().click();
  const menu = page.getByRole('menu', { name: `Actions for ${title}` });
  await expect(menu).toBeVisible();
  return menu;
}

test('the session header menu: Copy path, Copy branch name, then the session\'s items; Copy writes the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await connect(page, world);
  await newSession(page, 'Header first');
  let menu = await headerMenu(page);
  // No terminal.exec on this token: no New terminal. Not ALP.app: no New browser tab.
  expect(await labels(menu)).toEqual(['Copy path', 'Copy branch name', 'Rename', 'Copy session ID', 'Archive']);
  await menu.getByRole('menuitem', { name: 'Copy path' }).click();
  await expect.poll(async () => realpath(await page.evaluate(() => navigator.clipboard.readText())).catch(() => '')).toBe(await realpath(world.projects.main));
  menu = await headerMenu(page);
  await menu.getByRole('menuitem', { name: 'Copy branch name' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('feature/menus');
});

test('New terminal in the header opens the Terminal tab (a token with terminal.exec)', async ({ page }) => {
  // The terminal token reads sessions; a writer opens one first so the header has a session.
  await connect(page, world);
  await newSession(page, 'Header terminal');
  await connect(page, world, world.tokens.terminal);
  await row(page, 'Header terminal').click();
  const menu = await headerMenu(page);
  // A reader with terminal.exec: Copy items, New terminal, Copy session ID; no Rename or Archive.
  expect(await labels(menu)).toEqual(['Copy path', 'Copy branch name', 'New terminal', 'Copy session ID']);
  await menu.getByRole('menuitem', { name: 'New terminal' }).click();
  await expect(page.getByRole('tab', { name: 'Terminal', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('a reader\'s header menu has no write item', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Header reader');
  await connect(page, world, world.tokens.viewer);
  await row(page, 'Header reader').click();
  const menu = await headerMenu(page);
  expect(await labels(menu)).toEqual(['Copy path', 'Copy branch name', 'Copy session ID']);
});

test('Archive of an idle session: it leaves at once and the toast\'s Undo brings it back', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Archive undo');
  await newSession(page, 'Archive stays');
  const menu = await rowMenu(page, 'Archive undo');
  await menu.getByRole('menuitem', { name: 'Archive' }).click();
  // No confirmation for an idle session (Paseo's): the row goes, the host archives it.
  await expect(page.getByRole('dialog', { name: 'Archive session?' })).toHaveCount(0);
  await expect(row(page, 'Archive undo')).toHaveCount(0);
  await expect.poll(async () => (await sessionOf('Archive undo', { includeArchived: true }))?.archived).toBe(true);
  const toast = page.getByRole('status').filter({ hasText: 'Archived “Archive undo”' });
  await expect(toast).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('archive-undo-toast.png') });
  await toast.getByTestId('notice-undo-archive').click();
  await expect(row(page, 'Archive undo')).toHaveCount(1);
  await expect.poll(async () => (await sessionOf('Archive undo'))?.archived ?? false).toBe(false);
  await expect(page.getByRole('status').filter({ hasText: 'Restored “Archive undo”' })).toBeVisible();

  // The header's Archive and the shortcut take the same way.
  await row(page, 'Archive stays').click();
  const header = await headerMenu(page);
  await header.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(row(page, 'Archive stays')).toHaveCount(0);
  await page.getByTestId('notice-undo-archive').click();
  await expect(row(page, 'Archive stays')).toHaveCount(1);
});

test('Remove project: confirmed, the project leaves the host\'s list; readers never see it', async ({ page }) => {
  // A second project the registry writer may remove (its grant has the main workspace only, so
  // register a managed copy: here the main project itself, then Add it back).
  await connect(page, world, world.tokens.registryWriter);
  const project = nav(page).getByTestId('project-row').first();
  await project.hover();
  await nav(page).getByRole('button', { name: /^Project actions for / }).first().click();
  const menu = page.getByRole('menu', { name: /^Project actions for / });
  await expect(menu.getByRole('menuitem', { name: 'Remove project' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Remove project' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove project?' });
  await expect(confirm).toContainText('No file changes');
  await confirm.getByTestId('remove-project-confirm').click();
  await expect(confirm).toBeHidden();
  await expect.poll(async () => (await host('project.list', {})).projects.length).toBe(0);
  // Add project brings it back (project.register of the granted directory).
  await project.hover();
  await nav(page).getByRole('button', { name: /^Project actions for / }).first().click();
  await page.getByRole('menu', { name: /^Project actions for / }).getByRole('menuitem', { name: 'Add to projects' }).click();
  await expect.poll(async () => (await host('project.list', {})).projects.length).toBe(1);

  const reader = await page.context().newPage();
  await connect(reader, world, world.tokens.viewer);
  await nav(reader).getByTestId('project-row').first().hover();
  await nav(reader).getByRole('button', { name: /^Project actions for / }).first().click();
  const readerMenu = reader.getByRole('menu', { name: /^Project actions for / });
  await expect(readerMenu).toBeVisible();
  await expect(readerMenu.getByRole('menuitem', { name: 'Remove project' })).toHaveCount(0);
  await reader.close();
});

test('Pin to top and Labels on a session: kept by the host, the row moves to Pinned and shows its labels', async ({ page }) => {
  // The host's label catalog (the owner's Settings › Workspaces makes labels): two labels, then
  // taken off the workspace again so the row's labels are the session's own.
  const { workspaces } = await host('workspace.list', {});
  const workspaceId = workspaces.find((entry: RegistryWorkspace) => !entry.archivedAt).id;
  // Each write takes the registry's revision as it is now (the app's own reads and writes move it).
  const owner = async (operation: string, args: object, requestId: string) => host('registry.owner', { operation, args, ifRevision: (await host('registry.owner', {})).registry.revision, requestId });
  for (const [name, color, assigned] of [['urgent', 'red', true], ['review', 'sky', true], ['urgent', 'red', false], ['review', 'sky', false]]) {
    await owner('label.assign', { workspaceId, label: { name, color }, assigned }, `menus-${name}-${assigned}`);
  }
  await connect(page, world);
  await newSession(page, 'Pin me');
  await newSession(page, 'Stay put');

  // Pin to top: the host keeps pinnedAt; the row leaves its project for the Pinned section.
  let menu = await rowMenu(page, 'Pin me');
  await menu.getByRole('menuitem', { name: 'Pin to top' }).click();
  await expect.poll(async () => typeof (await sessionOf('Pin me'))?.pinnedAt).toBe('string');
  const pinned = nav(page).getByTestId('sidebar-pinned-sessions');
  await expect(pinned.getByTestId('session-row').filter({ hasText: 'Pin me' })).toHaveAttribute('data-pinned', 'true');
  await expect(nav(page).getByTestId('sidebar-project').getByTestId('session-row').filter({ hasText: 'Pin me' })).toHaveCount(0);
  await expect(nav(page).getByTestId('sidebar-project').getByTestId('session-row').filter({ hasText: 'Stay put' })).toHaveCount(1);

  // Labels: the catalog's labels as checks; a check is kept by the host in the catalog's spelling.
  menu = await rowMenu(page, 'Pin me');
  await menu.getByRole('menuitem', { name: 'Labels' }).click();
  // The menu shows its Labels page in place (named after it).
  const page2 = page.getByRole('menu', { name: 'Labels' });
  await expect(page2.getByTestId('sidebar-workspace-menu-label')).toHaveText(['urgent', 'review']);
  await page2.getByRole('menuitemcheckbox', { name: 'urgent' }).click();
  await expect(page2.getByRole('menuitemcheckbox', { name: 'urgent' })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await sessionOf('Pin me'))?.labels).toEqual(['urgent']);
  await page.screenshot({ path: test.info().outputPath('session-labels.png') });
  await page.keyboard.press('Escape');
  await expect(row(page, 'Pin me').locator('[data-meta="labels"]')).toHaveText('urgent');

  // A reload keeps them (the host's, not this page's).
  await page.reload();
  await connect(page, world);
  await expect(nav(page).getByTestId('sidebar-pinned-sessions').getByTestId('session-row').filter({ hasText: 'Pin me' })).toHaveCount(1);
  await expect(row(page, 'Pin me').locator('[data-meta="labels"]')).toHaveText('urgent');

  // A catalog rename follows to the session.
  await owner('label.update', { name: 'urgent', newName: 'hot' }, 'menus-rename');
  await expect.poll(async () => (await sessionOf('Pin me'))?.labels).toEqual(['hot']);

  // Unpin: back under its project.
  menu = await rowMenu(page, 'Pin me');
  await menu.getByRole('menuitem', { name: 'Unpin' }).click();
  await expect.poll(async () => (await sessionOf('Pin me'))?.pinnedAt).toBeUndefined();
  await expect(nav(page).getByTestId('sidebar-project').getByTestId('session-row').filter({ hasText: 'Pin me' })).toHaveCount(1);

  // A reader: no Pin to top, no Labels.
  const reader = await page.context().newPage();
  await connect(reader, world, world.tokens.viewer);
  const readerMenu = await rowMenu(reader, 'Pin me');
  expect(await labels(readerMenu)).toEqual(['Copy path', 'Copy branch name']);
  await reader.close();
});

test('Settings › Notifications: Play sound decides a notification\'s silent; Refresh reads the permission again', async ({ page }) => {
  await page.addInitScript(() => {
    const shown: Note[] = [];
    let permission = 'default';
    class FakeNotification {
      declare title: string;
      declare options: NotificationOptions;
      static get permission() { return permission; }
      static async requestPermission() { return permission; }
      constructor(title: string, options: NotificationOptions = {}) { this.title = title; this.options = options; shown.push(this); }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
    Object.defineProperty(window, '__notes', { value: shown });
    // What the system settings would change behind the page's back.
    Object.defineProperty(window, '__setPermission', { value: (value: string) => { permission = value; } });
  });
  await connect(page, world);
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  // Notifications is its own page, as Paseo's (t-81b0.12).
  await settings.getByTestId('settings-notifications').click();
  const section = settings.locator('section', { hasText: 'Test notification' });
  // Blocked in the system, then allowed there: Refresh shows it without a reload.
  await page.evaluate(() => window.__setPermission('denied'));
  await section.getByTestId('notification-permission-refresh').click();
  await expect(section.getByTestId('notification-permission')).toHaveText('Blocked');
  await expect(section).toContainText('then Refresh');
  await page.evaluate(() => window.__setPermission('granted'));
  await section.getByTestId('notification-permission-refresh').click();
  await expect(section.getByTestId('notification-permission')).toHaveText('Allowed');

  // Play sound on (the default): the notification is not silent.
  const sound = section.getByTestId('notification-sound');
  await expect(sound).toHaveAttribute('aria-checked', 'true');
  await section.getByTestId('notification-test').click();
  await expect.poll(() => page.evaluate(() => (window as NotesWindow).__notes.at(-1)?.options.silent)).toBe(false);
  // Off: silent, and it stays off after a reload (this browser's preferences).
  await sound.click();
  await expect(sound).toHaveAttribute('aria-checked', 'false');
  await section.getByTestId('notification-test').click();
  await expect.poll(() => page.evaluate(() => (window as NotesWindow).__notes.at(-1)?.options.silent)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('settings-notifications.png') });
  await page.reload();
  await connect(page, world);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('region', { name: 'Settings' }).getByTestId('settings-notifications').click();
  await expect(page.getByRole('region', { name: 'Settings' }).getByTestId('notification-sound')).toHaveAttribute('aria-checked', 'false');
});
