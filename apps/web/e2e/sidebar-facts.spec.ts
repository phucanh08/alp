// The sidebar as Paseo's (t-ff83; docs/alp/dashboard.md, the sidebar): every workspace lists its
// sessions, for any client; the host owner (alp dashboard's own link) also sees each workspace's
// diff, PR and CI on its most recent session row, the project's icon, the account usage over the
// footer, a Schedules row and New workspace. A remote gateway credential (never the owner) makes
// none of the owner's calls and keeps New session at the top.
//
// Real alpd, gateway, dashboard and fake Codex. host.workspace.facts is the dashboard's own owner
// handler reading real Git repositories in this world's scratch directory, with a FAKE gh first on
// the dashboard's PATH (no network): shop's branch has an open PR with failed CI, secret's a merged
// PR with passed CI; shop has a logo.svg, secret and plain none. schedule.list goes through the
// real gateway to alpd. Only daemon.usage is answered by this spec in the page's WebSocket (fixture
// data): real usage needs real provider accounts.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { connect as hostConnect } from '@anhlp/alp-client';
import type { AlpClient } from '@anhlp/alp-client';
import type { RegistryProject } from '@anhlp/alp-protocol';
import { startWorld } from './support/world.ts';
import type { World } from './support/world.ts';
import { closeWorldAfter } from './support/cleanup.ts';
import { dashboardSettings, startDashboard } from './support/dashboard.ts';
import type { Dashboard } from './support/dashboard.ts';
import { connect } from './support/app.ts';

const SHOT_DIR = process.env.ALP_WEB_SIDEBAR_SHOT_DIR;
const execute = promisify(execFile);
// shop's logo, found by the facts handler (logo.svg is one of its ICON_CANDIDATES).
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#f5f5f5"/><path d="M6 5 3 8l3 3M10 5l3 3-3 3" fill="none" stroke="#111" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>\n';
const ICON = `data:image/svg+xml;base64,${Buffer.from(LOGO).toString('base64')}`;
const OWNER_ONLY = ['host.workspace.facts', 'schedule.list', 'schedule.get', 'daemon.usage'];

let world: World;
let dashboard: Dashboard;
/** Workspace id by directory, and the directories by name. */
const ids: Record<string, string> = {};
const dirs: Record<string, string> = {};
let remoteToken = '';
let jobId = '';
let ghLog = '';

async function host(method: string, params = {}) {
  const client = await hostConnect(world.socket);
  try { return await client.request(method, params); } finally { client.close(); }
}

async function sessionIn(client: AlpClient, directory: string, id: string, title: string) {
  await client.request('session.create', { sessionId: id, workspaceId: ids[directory], spec: { workflow: 'pho', model: 'codex:gpt-5.6-sol', persist: true } });
  await client.request('session.rename', { sessionId: id, title });
}

const git = (cwd: string, ...args: string[]) => execute('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args],
  { cwd, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
const lines = (count: number, word: string) => Array.from({ length: count }, (_, i) => `${word} ${i}`).join('\n') + '\n';

/**
 * A repository in `directory` (alp init's .alp ignored): main with `base` committed and pointed at by
 * origin/main, then `branch` committing `change`; a remote, so the facts handler asks gh.
 */
async function repository(directory: string, { branch, base, change }: { branch: string, base: Record<string, string>, change: Record<string, string> }) {
  await writeFile(path.join(directory, '.gitignore'), '.alp/\n');
  for (const [name, content] of Object.entries(base)) await writeFile(path.join(directory, name), content);
  await git(directory, 'init', '-q');
  await git(directory, 'add', '.');
  await git(directory, 'commit', '-qm', 'base');
  await git(directory, 'remote', 'add', 'origin', 'https://example.invalid/sidebar.git');
  await git(directory, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await git(directory, 'checkout', '-qb', branch);
  for (const [name, content] of Object.entries(change)) await writeFile(path.join(directory, name), content);
  await git(directory, 'add', '.');
  await git(directory, 'commit', '-qm', 'change');
}

/**
 * A fake gh in `bin`: logs "<cwd> <args>" and prints `gh pr view --json` for the workspace it runs
 * in (shop: PR 2 open, a failed check; secret: PR 344 merged, checks passed); fails elsewhere.
 */
async function fakeGh(bin: string) {
  await mkdir(bin, { recursive: true });
  const log = path.join(bin, 'gh.log');
  const open = JSON.stringify({ number: 2, state: 'OPEN', isDraft: false, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }] });
  const merged = JSON.stringify({ number: 344, state: 'MERGED', isDraft: false, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }] });
  await writeFile(path.join(bin, 'gh'), `#!/bin/sh
echo "$PWD $*" >> '${log}'
case "$PWD" in
  ${dirs.main}) printf '%s\\n' '${open}' ;;
  ${dirs.other}) printf '%s\\n' '${merged}' ;;
  *) exit 1 ;;
esac
`);
  await chmod(path.join(bin, 'gh'), 0o755);
  return log;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  world = await startWorld({ settings: await dashboardSettings() });
  for (const [name, directory] of Object.entries({ main: world.projects.main, other: world.projects.other, custom: world.projects.custom })) dirs[name] = await realpath(directory);
  // shop: +2600 -0 on feat/sidebar-facts, with a logo; secret: 74 lines changed and 598 added
  // (+672 -74) on fix/totals, no logo; plain: no repository, no logo.
  await repository(dirs.main, { branch: 'feat/sidebar-facts', base: { 'README.md': '# shop\n', 'logo.svg': LOGO }, change: { 'catalog.txt': lines(2600, 'item') } });
  await repository(dirs.other, { branch: 'fix/totals', base: { 'totals.txt': lines(100, 'total') },
    change: { 'totals.txt': lines(74, 'fixed') + lines(100, 'total').split('\n').slice(74).join('\n') + lines(598, 'added') } });
  const bin = path.join(world.directory, 'fake-gh-bin');
  ghLog = await fakeGh(bin);
  for (const name of ['main', 'other', 'custom']) {
    const { revision } = await host('project.list', {});
    await host('project.register', { directory: dirs[name], ifRevision: revision, requestId: `sidebar-${name}` });
  }
  const { workspaces } = await host('workspace.list', {});
  for (const row of workspaces) if (!row.archivedAt && !ids[row.directory]) ids[row.directory] = row.id;
  // Two sessions in shop (the second is the most recent), one in secret, none in plain (its graph
  // is not the fake's, so no session starts there).
  // One client opens the sessions and schedules the wake while they are open.
  const client = await hostConnect(world.socket);
  try {
    await sessionIn(client, dirs.main, 'sidebar-older', 'Older shop work');
    await new Promise(resolve => setTimeout(resolve, 30));
    await sessionIn(client, dirs.main, 'sidebar-newest', 'Newest shop work');
    await sessionIn(client, dirs.other, 'sidebar-secret', 'Secret project work');
    const { job } = await client.request('schedule.create', { projectRoot: dirs.main, sessionId: 'sidebar-newest', dueAt: new Date(Date.now() + 86_400_000).toISOString(), prompt: 'Check the nightly build and report back' });
    jobId = job.id;
  } finally { client.close(); }
  // A remote credential for two workspaces: a non-owner that still sees both workspaces' sessions.
  const made = JSON.parse(await world.gatewayCli('credential', 'create', '--label', 'sidebar-remote', '--workspace', world.projects.main, '--workspace', world.projects.other, '--json'));
  remoteToken = made.token;
  // The fake gh first on the dashboard's PATH (its facts handler finds gh and git on PATH).
  dashboard = await startDashboard(world, { env: { PATH: `${bin}${path.delimiter}${world.env.PATH}` } });
});
test.afterAll(async () => {
  if (world) await closeWorldAfter(world, async () => { await dashboard?.stop(); });
});

/**
 * Routes the page's gateway socket: records every method the page sends and answers daemon.usage
 * (fixture: real usage needs real provider accounts); everything else goes to the real gateway.
 */
async function intercept(page: Page) {
  // any: JSON-RPC requests the page sent, parsed from the socket.
  const sent: any[] = [];
  await page.routeWebSocket(() => true, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let request;
      try { request = JSON.parse(String(message)); } catch {}
      if (request?.method) sent.push(request);
      if (request?.method === 'daemon.usage') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { providers: [
          { runtime: 'claude', available: true, checkedAt: new Date().toISOString(), plan: 'max', limited: false, pause: null, parked: 0, windows: [{ name: 'five_hour', usedPercent: 98, resetsAt: null }, { name: 'seven_day', usedPercent: 61, resetsAt: null }] },
          { runtime: 'codex', available: true, checkedAt: new Date().toISOString(), plan: 'pro', limited: false, pause: null, parked: 0, windows: [{ name: 'Codex · 5 hour window', usedPercent: 82, resetsAt: null }, { name: 'Codex · 7 day window', usedPercent: 37, resetsAt: null }] },
        ] } }));
        return;
      }
      server.send(message);
    });
    server.onMessage(message => socket.send(message));
  });
  return sent;
}

/** The session of `directory` alpd updated last: the row that carries its workspace's facts. */
async function latestIn(directory: string) {
  const { sessions } = await host('session.list', { projectRoot: directory, rootsOnly: true, includeClosed: true });
  return [...sessions].sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)) || a.id.localeCompare(b.id))[0].id;
}

const project = (page: Page, directory: string) => page.locator(`[data-testid="sidebar-project"][data-path="${directory}"]`);
const row = (page: Page, id: string) => page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);

test('owner: sessions under every workspace, facts on the most recent row, icon or letter tile, usage, Schedules, New workspace', async ({ page }) => {
  test.setTimeout(150_000);
  const sent = await intercept(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(dashboard.url);
  await expect(page.locator('main header')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Workspaces and sessions' });

  // The top rows: New workspace (not New session), History, Search, Schedules.
  await expect(nav.getByTestId('sidebar-new-workspace')).toHaveText('New workspace');
  await expect(nav.getByRole('button', { name: 'New session', exact: true })).toHaveCount(0);
  await expect(nav.getByTestId('sidebar-schedules')).toBeVisible();

  // Every workspace lists its sessions, the open one and the others.
  await expect(row(page, 'sidebar-newest')).toContainText('Newest shop work');
  await expect(row(page, 'sidebar-older')).toContainText('Older shop work');
  await expect(row(page, 'sidebar-secret')).toContainText('Secret project work');
  await expect(project(page, dirs.other).getByTestId('session-row')).toHaveCount(1);
  await expect(project(page, dirs.custom).getByTestId('session-row')).toHaveCount(0);

  // Facts once per workspace, on its most recent session only: branch, diff, PR, CI.
  const latest = await latestIn(dirs.main);
  const earlier = latest === 'sidebar-newest' ? 'sidebar-older' : 'sidebar-newest';
  const newest = row(page, latest);
  await expect(newest).toHaveAttribute('data-facts', 'true');
  await expect(newest.getByTestId('sidebar-row-diff')).toHaveText('+2.6k -0');
  await expect(newest.locator('[data-meta="branch"]')).toHaveText('feat/sidebar-facts');
  // Paseo's default row items: branch on, host off, no trailing time (on every row).
  await expect(nav.locator('[data-meta="host"]')).toHaveCount(0);
  await expect(nav.getByTestId('sidebar-workspace-timestamp')).toHaveCount(0);
  await expect(newest.locator('[data-meta="pr"]')).toHaveText('2');
  await expect(newest.locator('[data-meta="ci"]')).toHaveText('failed');
  await expect(row(page, earlier)).not.toHaveAttribute('data-facts', 'true');
  await expect(row(page, earlier).getByTestId('sidebar-row-diff')).toHaveCount(0);
  await expect(row(page, earlier).locator('[data-meta="pr"], [data-meta="ci"]')).toHaveCount(0);
  const secret = row(page, 'sidebar-secret');
  await expect(secret.getByTestId('sidebar-row-diff')).toHaveText('+672 -74');
  await expect(secret.locator('[data-meta="pr"]')).toHaveText('344 Merged');
  await expect(secret.locator('[data-meta="ci"]')).toHaveText('passed');
  await expect(secret.locator('[data-meta="branch"]')).toHaveText('fix/totals');
  // Those came from gh, run by the dashboard in each repository (plain has no repository: no gh).
  const ghCalls = (await readFile(ghLog, 'utf8')).trim().split('\n');
  expect(ghCalls.some(line => line.startsWith(`${dirs.main} pr view feat/sidebar-facts --json`))).toBe(true);
  expect(ghCalls.some(line => line.startsWith(`${dirs.other} pr view fix/totals --json`))).toBe(true);
  expect(ghCalls.some(line => line.startsWith(`${dirs.custom} `))).toBe(false);

  // The project's icon as an <img> when the facts give one, the letter tile otherwise.
  await expect(project(page, dirs.main).getByTestId('project-icon')).toHaveAttribute('src', ICON);
  await expect(project(page, dirs.other).getByTestId('project-icon')).toHaveCount(0);
  await expect(project(page, dirs.other).getByTestId('project-letter-tile')).toHaveText('S');
  await expect(project(page, dirs.custom).getByTestId('project-letter-tile')).toHaveText('P');

  // Usage per provider over the footer: "98% 5h 61% wk".
  const usage = nav.getByTestId('sidebar-usage-line');
  await expect(usage.locator('[data-runtime="claude"]')).toHaveText('98% 5h61% wk');
  await expect(usage.locator('[data-runtime="codex"]')).toHaveText('82% 5h37% wk');

  // Facts were asked in batches of at most 50 ids, for registered workspaces only.
  const factCalls = sent.filter(request => request.method === 'host.workspace.facts');
  expect(factCalls.length).toBeGreaterThan(0);
  for (const call of factCalls) {
    expect(call.params.workspaceIds.length).toBeGreaterThan(0);
    expect(call.params.workspaceIds.length).toBeLessThanOrEqual(50);
  }

  if (SHOT_DIR) {
    await mkdir(SHOT_DIR, { recursive: true });
    await page.mouse.move(900, 600);
    await page.getByTestId('sidebar-column').screenshot({ path: `${SHOT_DIR}/sidebar-owner-dark.png` });
  }

  // The usage line opens Settings › Usage.
  await usage.click();
  const settings = page.getByRole('region', { name: 'Settings' });
  await expect(settings.getByTestId('usage-provider')).toHaveCount(2);
  // Settings › Sidebar names the owner's header slot New workspace and lists Schedules.
  await settings.getByRole('button', { name: 'Sidebar', exact: true }).click();
  await expect(settings.getByTestId('sidebar-nav-item-new-session')).toContainText('New workspace');
  await expect(settings.getByTestId('sidebar-nav-item-schedules')).toContainText('Schedules');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  // Schedules lists the job alpd holds, read only, with a link to its session.
  await nav.getByTestId('sidebar-schedules').click();
  const screen = page.getByTestId('schedules-screen');
  const job = screen.locator(`[data-testid="schedule-row"][data-schedule-id="${jobId}"]`);
  await expect(job.getByTestId('schedule-status')).toHaveText('pending');
  await expect(job.getByTestId('schedule-prompt')).toHaveText('Check the nightly build and report back');
  await expect(job.getByTestId('schedule-due')).toContainText('Due ');
  await expect(screen.getByRole('button', { name: /cancel|delete|pause/i })).toHaveCount(0);
  await job.getByTestId('schedule-session').click();
  await expect(screen).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Newest shop work' })).toBeVisible();

  // New workspace registers a directory of the host (host.project.register): it joins the list.
  const fresh = `${world.directory}/projects/fresh`;
  await mkdir(fresh, { recursive: true });
  await nav.getByTestId('sidebar-new-workspace').click();
  const dialog = page.getByRole('dialog', { name: 'New workspace' });
  await dialog.getByLabel('Workspace directory').fill(fresh);
  await dialog.getByTestId('new-workspace-register').click();
  await expect(dialog).toHaveCount(0);
  // The dashboard grant follows alpd's registry: the page lists it (by the path as registered).
  const added = nav.getByTestId('sidebar-project').filter({ has: page.getByRole('button', { name: 'fresh', exact: true }) });
  await expect(added).toBeVisible({ timeout: 30_000 });
  await expect(added.getByTestId('project-letter-tile')).toHaveText('F');
  await expect.poll(async () => (await host('project.list', {})).projects.some((entry: RegistryProject) => entry.root.endsWith('/projects/fresh') && !entry.removedAt)).toBe(true);
});

test('a remote credential (not the owner): sessions of both workspaces, no owner calls, no Schedules, New session at the top', async ({ page }) => {
  const sent = await intercept(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await connect(page, world, remoteToken);
  const nav = page.getByRole('navigation', { name: 'Workspaces and sessions' });
  await expect(row(page, 'sidebar-newest')).toBeVisible();
  await expect(row(page, 'sidebar-secret')).toContainText('Secret project work');
  await expect(nav.getByRole('button', { name: 'New session', exact: true }).first()).toBeVisible();
  await expect(nav.getByTestId('sidebar-new-workspace')).toHaveCount(0);
  await expect(nav.getByTestId('sidebar-schedules')).toHaveCount(0);
  await expect(nav.getByTestId('sidebar-usage-line')).toHaveCount(0);
  await expect(nav.getByTestId('sidebar-row-diff')).toHaveCount(0);
  await expect(nav.locator('[data-meta="pr"], [data-meta="ci"]')).toHaveCount(0);
  await expect(nav.getByTestId('project-icon')).toHaveCount(0);
  await expect(nav.getByTestId('project-letter-tile')).toHaveText(['S', 'S']);
  // Branch is a row item for everyone (alpd's registry row), not an owner fact.
  await expect(row(page, 'sidebar-secret').locator('[data-meta="branch"]')).toHaveText('fix/totals');
  if (SHOT_DIR) {
    await mkdir(SHOT_DIR, { recursive: true });
    await page.mouse.move(900, 600);
    await page.getByTestId('sidebar-column').screenshot({ path: `${SHOT_DIR}/sidebar-remote-dark.png` });
  }
  // Long enough for a background read to have gone out (the first facts read waits 400 ms).
  await page.waitForTimeout(1500);
  expect(sent.filter(request => OWNER_ONLY.includes(request.method)).map(request => request.method)).toEqual([]);
});
