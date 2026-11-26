// Settings' host pages for the host owner (t-a95b.1 group B; docs/alp/dashboard.md §4.7): through
// alp dashboard's own link (the owner gateway), Usage reads the account's usage, Providers adds,
// tests and diagnoses a provider after showing what will run, Terminals turns the host's switch on
// (after the CLI's warning) and off, Workspaces archives and labels, Projects registers and removes
// a directory; each with an effect seen on the host. The same pages through the world's standalone
// alp-gateway (never the owner) keep their Unavailable panels. Real alpd, fake Codex, no fixed waits.
import { expect, test } from '@playwright/test';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connect as hostConnect } from '@anhlp/alp-client';
import { startWorld } from './support/world.js';
import { closeWorldAfter } from './support/cleanup.js';
import { dashboardSettings, startDashboard } from './support/dashboard.js';
import { connect } from './support/app.js';

const FAKE_ACP = fileURLToPath(new URL('../../../test/support/fake-acp.ts', import.meta.url));

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
/** @type {Awaited<ReturnType<typeof startDashboard>>} */
let dashboard;

async function host(method, params = {}) {
  const client = await hostConnect(world.socket);
  try { return await client.request(method, params); } finally { client.close(); }
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  world = await startWorld({ settings: await dashboardSettings() });
  // Two registered projects before the dashboard starts: its grant follows alpd's registry.
  for (const [index, directory] of [world.projects.main, world.projects.custom].entries()) {
    const { revision } = await host('project.list', {});
    await host('project.register', { directory: await realpath(directory), ifRevision: revision, requestId: `settings-host-${index}` });
  }
  dashboard = await startDashboard(world);
});
test.afterAll(async () => {
  if (world) await closeWorldAfter(world, async () => { await dashboard?.stop(); });
});

const openSettings = async page => {
  await page.getByRole('button', { name: 'Settings' }).click();
  return page.getByRole('region', { name: 'Settings' });
};

/** Opens alp dashboard's link: this page is the host owner. */
async function asOwner(page) {
  await page.goto(dashboard.url);
  await expect(page.getByLabel('Access token')).toHaveCount(0);
  await expect(page.locator('main header')).toBeVisible();
  return openSettings(page);
}

test('a standalone gateway credential (not the owner) still sees every host page\'s Unavailable panel', async ({ page }) => {
  await connect(page, world, world.tokens.registryWriter);
  const settings = await openSettings(page);
  for (const [tab, text] of [
    ['usage', 'Usage and limits is not available in this beta'],
    ['providers', 'Adding, testing or diagnosing providers is not available in this beta'],
    ['terminals', 'Changing the host\'s terminal switch is not available in this beta'],
    ['workspaces', 'Archiving workspaces, labels and placement is not available in this beta'],
    ['projects', 'Granting or removing projects is not available in this beta'],
  ]) {
    await settings.getByTestId(`settings-${tab}`).click();
    await expect(settings).toContainText(text);
  }
  await expect(settings.getByRole('button', { name: 'Refresh all' })).toHaveCount(0);
  await expect(settings.getByTestId('usage-options-menu')).toHaveCount(0);
  await expect(settings.getByTestId('terminals-switch')).toHaveCount(0);
  await expect(settings.getByTestId('owner-workspace-row')).toHaveCount(0);
  await expect(settings.getByTestId('owner-project-row')).toHaveCount(0);
});

test('owner › Usage shows each provider\'s usage from the host and refreshes it', async ({ page }) => {
  const settings = await asOwner(page);
  await settings.getByTestId('settings-usage').click();
  await expect(settings).not.toContainText('Usage and limits is not available');
  const providers = settings.getByTestId('usage-provider');
  await expect(providers).toHaveCount(2);
  await expect(settings.locator('[data-testid="usage-provider"][data-runtime="codex"]')).toContainText('Codex');
  await expect(settings.locator('[data-testid="usage-provider"][data-runtime="claude"]')).toContainText('Claude');
  const refresh = settings.getByRole('button', { name: 'Refresh all' });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(providers).toHaveCount(2);
});

test('owner › Providers adds a provider after showing what will run (env value masked), tests and diagnoses it', async ({ page }) => {
  const settings = await asOwner(page);
  await settings.getByTestId('settings-providers').click();
  await expect(settings).not.toContainText('Adding, testing or diagnosing providers is not available');
  const form = settings.getByRole('form', { name: 'Add a provider' });
  await form.getByLabel('Id').fill('fake-acp');
  await form.getByLabel('Command').fill(process.execPath);
  await form.getByLabel('Arguments (one per line)').fill(FAKE_ACP);
  await form.getByLabel('Environment (NAME=value, one per line)').fill('FAKE_SECRET=hunter2-do-not-show');
  await form.getByRole('button', { name: 'Review' }).click();
  const confirm = settings.getByTestId('provider-confirm');
  await expect(confirm.getByTestId('provider-confirm-command')).toHaveText(`${process.execPath} ${FAKE_ACP}`);
  await expect(confirm.getByTestId('provider-confirm-env')).toHaveText('FAKE_SECRET=‹hidden on the host›');
  await expect(confirm).not.toContainText('hunter2');
  // Nothing is written before the confirm.
  await expect(readFile(path.join(world.home, 'providers', 'fake-acp.json'))).rejects.toThrow();
  await confirm.getByRole('button', { name: 'Add provider' }).click();
  await expect(settings.getByText('Added fake-acp to your library.')).toBeVisible();
  // On the host: what alp provider add writes.
  const saved = JSON.parse(await readFile(path.join(world.home, 'providers', 'fake-acp.json'), 'utf8'));
  expect(saved).toEqual({ kind: 'acp', command: process.execPath, args: [FAKE_ACP], env: { FAKE_SECRET: 'hunter2-do-not-show' } });
  await expect(settings.getByTestId('library-row-fake-acp')).toBeVisible();
  // Test: the host starts it and it speaks ACP.
  await expect(settings.getByLabel('Provider to test')).toHaveValue('fake-acp');
  await settings.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(settings.getByTestId('provider-test-result')).toContainText(/fake-acp: .* speaks ACP/);
  // Diagnose: alp doctor's runtime and provider checks.
  await settings.getByRole('button', { name: 'Diagnose' }).click();
  await expect(settings.getByTestId('diagnose-providers')).toBeVisible({ timeout: 60_000 });
  await expect(settings.getByTestId('diagnose-codex')).toBeVisible();
  await expect(settings).not.toContainText('hunter2');
});

test('owner › Terminals turns the host\'s switch on after the CLI\'s warning, and off', async ({ page }) => {
  const terminalFile = path.join(world.home, 'terminal.json');
  const settings = await asOwner(page);
  await settings.getByTestId('settings-terminals').click();
  await expect(settings).not.toContainText('Changing the host\'s terminal switch is not available');
  await expect(settings.getByTestId('terminals-switch')).toHaveText('Off');
  await settings.getByRole('button', { name: 'Allow…' }).click();
  const confirm = settings.getByTestId('terminals-confirm');
  await expect(confirm).toContainText('It is NOT a sandbox.');
  await expect(confirm).toContainText('terminal.exec');
  await expect(readFile(terminalFile)).rejects.toThrow();
  await confirm.getByRole('button', { name: 'Allow remote terminals' }).click();
  await expect(settings.getByTestId('terminals-switch')).toHaveText('Allowed');
  expect(JSON.parse(await readFile(terminalFile, 'utf8'))).toEqual({ version: 1, allowRemoteTerminal: true });
  expect(await world.alp('terminal', 'status', '--json')).toContain('"allowRemoteTerminal":true');
  await expect(settings.getByTestId('terminals-paseo')).toHaveText('Off');
  // Paseo-device access set on the host shows on the page (it is the host's, never turned on here).
  await world.alp('terminal', 'allow', '--paseo', '--yes');
  // Leaving the page and coming back reads the host's switch again.
  await settings.getByTestId('settings-usage').click();
  await settings.getByTestId('settings-terminals').click();
  const again = settings;
  await expect(again.getByTestId('terminals-paseo')).toHaveText('Allowed');
  await again.getByRole('button', { name: 'Turn off' }).click();
  await expect(again.getByTestId('terminals-switch')).toHaveText('Off');
  await expect(again.getByTestId('terminals-paseo')).toHaveCount(0);
  expect(JSON.parse(await readFile(terminalFile, 'utf8'))).toEqual({ version: 1, allowRemoteTerminal: false });
});

test('owner › Workspaces labels, archives and unarchives a workspace in alpd\'s registry', async ({ page }) => {
  const custom = await realpath(world.projects.custom);
  const settings = await asOwner(page);
  await settings.getByTestId('settings-workspaces').click();
  await expect(settings).not.toContainText('Archiving workspaces, labels and placement is not available');
  const row = settings.getByTestId('owner-workspace-row').filter({ hasText: custom });
  await expect(row).toHaveCount(1);
  await row.getByLabel(/^New label for/).fill('Client');
  await row.getByLabel(/^Color of the new label for/).selectOption('sky');
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByTestId('workspace-label')).toHaveText(/Client/);
  const registryOf = async () => (await host('registry.owner', {})).registry;
  const workspaceOf = async () => (await registryOf()).workspaces.find(entry => entry.directory === custom && entry.projectId);
  await expect.poll(async () => (await workspaceOf())?.labels).toEqual(['Client']);
  expect((await registryOf()).labels.catalog).toEqual([{ name: 'Client', color: 'sky' }]);

  await row.getByRole('button', { name: /^Archive workspace/ }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => !!(await workspaceOf())?.archivedAt).toBe(true);
  await settings.getByLabel(/Show archived/).check();
  const archived = settings.getByTestId('owner-workspace-row').filter({ hasText: custom });
  await expect(archived.getByTestId('owner-workspace-archived')).toBeVisible();
  await archived.getByRole('button', { name: /^Unarchive workspace/ }).click();
  await expect(archived.getByTestId('owner-workspace-archived')).toHaveCount(0);
  await expect.poll(async () => (await workspaceOf())?.archivedAt ?? null).toBe(null);

  await archived.getByRole('button', { name: 'Remove label Client' }).click();
  await expect.poll(async () => (await workspaceOf())?.labels).toEqual([]);
});

test('owner › Projects registers any existing directory and removes it; a bad path is refused on the host', async ({ page }) => {
  const added = path.join(world.directory, 'projects', 'added-by-owner');
  await mkdir(added, { recursive: true });
  const directory = await realpath(added);
  const settings = await asOwner(page);
  await settings.getByTestId('settings-projects').click();
  await expect(settings).not.toContainText('Granting or removing projects is not available');
  await settings.getByLabel('Directory to register').fill(path.join(directory, 'missing'));
  await settings.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('does not exist');

  await settings.getByLabel('Directory to register').fill(directory);
  await settings.getByRole('button', { name: 'Register', exact: true }).click();
  const row = settings.locator(`[data-testid="owner-project-row"][data-project-root="${directory}"]`);
  await expect(row).toBeVisible();
  await expect.poll(async () => (await host('project.list', {})).projects.some(project => project.root === directory && !project.removedAt)).toBe(true);
  // The dashboard grant follows alpd's registry: the page gets the new project too.
  await expect(page.locator(`[data-testid="project-row"][data-workspace="${directory}"]`)).toBeAttached({ timeout: 30_000 });

  await row.getByRole('button', { name: /^Remove project/ }).click();
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await host('project.list', {})).projects.some(project => project.root === directory)).toBe(false);
});
