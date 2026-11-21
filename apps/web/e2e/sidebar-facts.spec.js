// The sidebar as Paseo's (t-ff83; docs/alp/dashboard.md, the sidebar): every workspace lists its
// sessions, for any client; the host owner (alp dashboard's own link) also sees each workspace's
// diff, PR and CI on its most recent session row, the project's icon, the account usage over the
// footer, a Schedules row and New workspace. A remote gateway credential (never the owner) makes
// none of the owner's calls and keeps New session at the top.
//
// Real alpd, gateway, dashboard and fake Codex. host.workspace.facts and daemon.usage are answered
// in the page's WebSocket by this spec (fixture data, no network, no git or gh); schedule.list is
// answered from the real alpd's schedule store (a job this spec created there), because the
// gateway's owner handlers for both new methods land in a separate change (t-ff83 PR-A).
import { expect, test } from '@playwright/test';
import { mkdir, realpath } from 'node:fs/promises';
import { connect as hostConnect } from '@anhlp/alp-client';
import { startWorld } from './support/world.js';
import { closeWorldAfter } from './support/cleanup.js';
import { dashboardSettings, startDashboard } from './support/dashboard.js';
import { connect } from './support/app.js';

const SHOT_DIR = process.env.ALP_WEB_SIDEBAR_SHOT_DIR;
// The project's icon as host.workspace.facts sends it: a data:image URL (here a small SVG).
const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iI2Y1ZjVmNSIvPjxwYXRoIGQ9Ik02IDUgMyA4bDMgM00xMCA1bDMgMy0zIDMiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzExMSIgc3Ryb2tlLXdpZHRoPSIxLjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjwvc3ZnPg==';
const OWNER_ONLY = ['host.workspace.facts', 'schedule.list', 'schedule.get', 'daemon.usage'];

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
/** @type {Awaited<ReturnType<typeof startDashboard>>} */
let dashboard;
/** Workspace id by directory, and the directories by name. */
const ids = {};
const dirs = {};
let remoteToken = '';
let jobId = '';

async function host(method, params = {}) {
  const client = await hostConnect(world.socket);
  try { return await client.request(method, params); } finally { client.close(); }
}

async function sessionIn(client, directory, id, title) {
  await client.request('session.create', { sessionId: id, workspaceId: ids[directory], spec: { workflow: 'pho', model: 'codex:gpt-5.6-sol', persist: true } });
  await client.request('session.rename', { sessionId: id, title });
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  world = await startWorld({ settings: await dashboardSettings() });
  for (const [name, directory] of Object.entries({ main: world.projects.main, other: world.projects.other, custom: world.projects.custom })) {
    dirs[name] = await realpath(directory);
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
  dashboard = await startDashboard(world);
});
test.afterAll(async () => {
  if (world) await closeWorldAfter(world, async () => { await dashboard?.stop(); });
});

/**
 * Routes the page's gateway socket: records every method the page sends, and answers the owner's
 * facts and usage (fixture) and schedule.list (from the real alpd) in place of the gateway.
 */
async function intercept(page) {
  const sent = [];
  await page.routeWebSocket(() => true, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let request;
      try { request = JSON.parse(String(message)); } catch {}
      if (request?.method) sent.push(request);
      const reply = result => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      if (request?.method === 'host.workspace.facts') {
        const byId = Object.fromEntries(Object.entries(ids).map(([directory, id]) => [id, directory]));
        const workspaces = {};
        for (const id of request.params.workspaceIds) {
          if (byId[id] === dirs.main) workspaces[id] = { branch: 'feat/sidebar-facts', additions: 2600, deletions: 0, pr: { number: 2, state: 'open' }, ci: 'failed', icon: ICON, fetchedAt: new Date().toISOString() };
          if (byId[id] === dirs.other) workspaces[id] = { branch: 'main', additions: 672, deletions: 74, pr: { number: 344, state: 'merged' }, ci: 'passed', fetchedAt: new Date().toISOString() };
        }
        reply({ workspaces });
        return;
      }
      if (request?.method === 'daemon.usage') {
        reply({ providers: [
          { runtime: 'claude', available: true, checkedAt: new Date().toISOString(), plan: 'max', limited: false, pause: null, parked: 0, windows: [{ name: 'five_hour', usedPercent: 98, resetsAt: null }, { name: 'seven_day', usedPercent: 61, resetsAt: null }] },
          { runtime: 'codex', available: true, checkedAt: new Date().toISOString(), plan: 'pro', limited: false, pause: null, parked: 0, windows: [{ name: 'Codex · 5 hour window', usedPercent: 82, resetsAt: null }, { name: 'Codex · 7 day window', usedPercent: 37, resetsAt: null }] },
        ] });
        return;
      }
      if (request?.method === 'schedule.list') {
        void host('schedule.list', request.params).then(reply, error => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: error.code ?? 1000, message: error.message } })));
        return;
      }
      server.send(message);
    });
    server.onMessage(message => socket.send(message));
  });
  return sent;
}

/** Show › Branch on, Host off, no trailing time: the row items of the Paseo screenshot this matches. */
async function paseoRowItems(page) {
  await page.addInitScript(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('alp-web:preferences') ?? 'null');
      const base = stored?.v === 1 ? stored : { v: 1 };
      localStorage.setItem('alp-web:preferences', JSON.stringify({ ...base, sidebarDisplay: { ...(base.sidebarDisplay ?? {}), rowItems: { branch: true, project: false, host: false, labels: true }, trailing: 'none' } }));
    } catch {}
  });
}

/** The session of `directory` alpd updated last: the row that carries its workspace's facts. */
async function latestIn(directory) {
  const { sessions } = await host('session.list', { projectRoot: directory, rootsOnly: true, includeClosed: true });
  return [...sessions].sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)) || a.id.localeCompare(b.id))[0].id;
}

const project = (page, directory) => page.locator(`[data-testid="sidebar-project"][data-path="${directory}"]`);
const row = (page, id) => page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);

test('owner: sessions under every workspace, facts on the most recent row, icon or letter tile, usage, Schedules, New workspace', async ({ page }) => {
  test.setTimeout(150_000);
  const sent = await intercept(page);
  await paseoRowItems(page);
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
  await expect(newest.locator('[data-meta="pr"]')).toHaveText('2');
  await expect(newest.locator('[data-meta="ci"]')).toHaveText('failed');
  await expect(row(page, earlier)).not.toHaveAttribute('data-facts', 'true');
  await expect(row(page, earlier).getByTestId('sidebar-row-diff')).toHaveCount(0);
  await expect(row(page, earlier).locator('[data-meta="pr"], [data-meta="ci"]')).toHaveCount(0);
  const secret = row(page, 'sidebar-secret');
  await expect(secret.getByTestId('sidebar-row-diff')).toHaveText('+672 -74');
  await expect(secret.locator('[data-meta="pr"]')).toHaveText('344 Merged');
  await expect(secret.locator('[data-meta="ci"]')).toHaveText('passed');

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
  await expect.poll(async () => (await host('project.list', {})).projects.some(entry => entry.root.endsWith('/projects/fresh') && !entry.removedAt)).toBe(true);
});

test('a remote credential (not the owner): sessions of both workspaces, no owner calls, no Schedules, New session at the top', async ({ page }) => {
  const sent = await intercept(page);
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
  // Long enough for a background read to have gone out (the first facts read waits 400 ms).
  await page.waitForTimeout(1500);
  expect(sent.filter(request => OWNER_ONLY.includes(request.method)).map(request => request.method)).toEqual([]);
});
