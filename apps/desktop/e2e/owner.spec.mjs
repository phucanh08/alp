/**
 * The desktop window as the host owner (t-ff83; docs/alp/dashboard.md, the sidebar; docs/alp/desktop.md §5):
 * the real Electron app, driven by Playwright's `_electron`, opens a scratch host's real `alp dashboard`
 * (this checkout's packages/cli/dist/cli.js, which keeps a real alpd running) through an `alp` wrapper
 * that pins the scratch environment. It checks one owner Settings action (General › Agents' language,
 * persisted in the host's settings.json) and the sidebar: a workspace with its sessions, branch and
 * diff on the most recent row, PR and CI from a FAKE gh (no network) first on the dashboard's PATH, the
 * project icon, and the Schedules row listing alpd's job.
 *
 * Nothing touches the user's ~/.alp, alpd or dashboard: HOME, ALP_HOME and TMPDIR are under the test's
 * scratch directory, launchd is never asked (ALP_LAUNCHCTL=/usr/bin/false), and every Node process the
 * host starts is admitted by test/support/fixture-processes.js, which ends them before the directory
 * goes. Sessions run a fake Codex (apps/web/e2e/support/fake-codex.js); no model is called.
 *
 * Needs `node scripts/build-workspace.mjs cli` (alpd, alp-dashboard and the web app) and the root
 * npm install; `bun run e2e` in apps/desktop runs it with the other specs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { connect as hostConnect } from '@anhlp/alp-client';
import { fixtureProcesses } from '../../../test/support/fixture-processes.js';
import { APP, cleanEnv, connectedTo, freePort, launch, scratch, waitFor } from './support.mjs';

const ROOT = path.resolve(APP, '..', '..');
const CLI = path.join(ROOT, 'packages/cli/dist/cli.js');
const FAKE_CODEX = path.join(ROOT, 'apps/web/e2e/support/fake-codex.js');
const MODEL = 'codex:gpt-5.6-sol';
const run = promisify(execFile);
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#2563eb"/></svg>\n';
const ICON = `data:image/svg+xml;base64,${Buffer.from(LOGO).toString('base64')}`;

const git = (cwd, ...args) => run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args],
  { cwd, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
const lines = (count, word) => Array.from({ length: count }, (_, i) => `${word} ${i}`).join('\n') + '\n';

/** A repository on `branch`, `change` committed over `base`, origin/main at the base: the facts handler diffs against it and asks gh. */
async function repository(directory, { branch, base, change }) {
  await writeFile(path.join(directory, '.gitignore'), '.alp/\nALP.md\n');
  for (const [name, content] of Object.entries(base)) await writeFile(path.join(directory, name), content);
  await git(directory, 'init', '-q');
  await git(directory, 'add', '.');
  await git(directory, 'commit', '-qm', 'base');
  await git(directory, 'remote', 'add', 'origin', 'https://example.invalid/desktop.git');
  await git(directory, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await git(directory, 'checkout', '-qb', branch);
  for (const [name, content] of Object.entries(change)) await writeFile(path.join(directory, name), content);
  await git(directory, 'add', '.');
  await git(directory, 'commit', '-qm', 'change');
}

/**
 * A scratch host: alpd started by this checkout's `alp daemon start`, three projects (shop: a Git
 * repository with a logo and an open PR whose CI failed; secret: a merged PR whose CI passed; plain: no
 * repository), two sessions in shop and one in secret, one schedule on shop's newest session, and the
 * `alp` wrapper the app runs. Each step is undone through the test's `defer`, in reverse order.
 */
async function ownerHost(context, { fileManager, editor } = {}) {
  const { dir, defer } = context;
  const home = path.join(dir, 'h', '.alp');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(path.join(dir, 'ht'), { recursive: true });
  const processes = await fixtureProcesses(home);
  // Before the directory goes: ends every Node process this host started (alpd, alp-dashboard, fake Codex).
  defer(() => processes.stop());
  const bin = path.join(dir, 'hb');
  await mkdir(bin, { recursive: true });
  const projects = Object.fromEntries(await Promise.all(['shop', 'secret', 'plain'].map(async name => {
    const directory = path.join(dir, 'projects', name);
    await mkdir(directory, { recursive: true });
    return [name, await realpath(directory)];
  })));
  // The fake gh: `gh pr view --json` for the repository it runs in; anything else fails. No network.
  const ghLog = path.join(bin, 'gh.log');
  const open = JSON.stringify({ number: 2, state: 'OPEN', isDraft: false, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }] });
  const merged = JSON.stringify({ number: 344, state: 'MERGED', isDraft: false, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  await writeFile(path.join(bin, 'gh'), `#!/bin/sh\necho "$PWD $*" >> '${ghLog}'\ncase "$PWD" in\n  '${projects.shop}') printf '%s\\n' '${open}' ;;\n  '${projects.secret}') printf '%s\\n' '${merged}' ;;\n  *) exit 1 ;;\nesac\n`);
  await chmod(path.join(bin, 'gh'), 0o755);
  // Every host process gets this environment explicitly (process.env is never changed): the scratch
  // HOME/ALP_HOME/TMPDIR, no launchd, the fixture admission, the fake gh first on PATH, the fake Codex.
  const env = {
    ...cleanEnv(), ...processes.env,
    HOME: path.dirname(home), TMPDIR: path.join(dir, 'ht'), ALP_LAUNCHCTL: '/usr/bin/false',
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
    ALP_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_JOURNAL: path.join(dir, 'codex.jsonl'), FAKE_CODEX_STATE: path.join(dir, 'codex-threads.json'),
    ALP_CLAUDE_BIN: path.join(dir, 'no-real-claude'), ALP_ANTIGRAVITY_BIN: path.join(dir, 'no-real-antigravity'),
    // Open in file manager's program (t-747e): a recorder in place of Finder, unless the run asks for the real one.
    ...(fileManager ? { ALP_DASHBOARD_FILE_MANAGER: fileManager } : {}),
    // Open in editor (t-a876): VS Code and Zed count as installed and a recorder stands in for them.
    ...(editor ? { ALP_DASHBOARD_EDITORS: 'vscode,zed', ALP_DASHBOARD_EDITOR_RUNNER: editor } : {}),
  };
  for (const value of [env.ALP_HOME, env.HOME, env.TMPDIR, env.ALP_SERVICE_DIR]) assert.ok(value.startsWith(`${dir}${path.sep}`), `${value} is outside the scratch directory`);
  const port = await freePort();
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ dashboard: { port }, web: { relay: { enabled: false } } }));
  const alp = (...args) => run(process.execPath, [CLI, ...args], { env, timeout: 60_000 });

  await repository(projects.shop, { branch: 'feat/desktop-sidebar', base: { 'README.md': '# shop\n', 'logo.svg': LOGO }, change: { 'catalog.txt': lines(120, 'item') } });
  await repository(projects.secret, { branch: 'fix/totals', base: { 'totals.txt': lines(10, 'total') }, change: { 'totals.txt': lines(4, 'fixed') + lines(10, 'total').split('\n').slice(4).join('\n') + lines(8, 'added') } });
  for (const directory of Object.values(projects)) await alp('init', directory);
  // shop and secret run Phở on the fake Codex (a session created there starts no real model).
  const team = { workflow: { mode: 'pho', supervisor: false }, team: { pho: { main: { profiles: [MODEL] } }, cafe: { main: { profiles: [MODEL] } } } };
  for (const name of ['shop', 'secret']) await writeFile(path.join(projects[name], '.alp/settings.json'), JSON.stringify(team));

  await alp('daemon', 'start');
  // Registered after alpd starts, so it runs before processes.stop(): a graceful stop first.
  defer(() => alp('daemon', 'stop').catch(() => {}));
  const lock = JSON.parse(await readFile(path.join(home, 'alpd.lock'), 'utf8'));
  assert.ok(lock.ready && lock.socket.startsWith(`${dir}${path.sep}`), `alpd's socket ${lock.socket} is not under the scratch directory`);
  const status = JSON.parse((await alp('daemon', 'status', '--json')).stdout);
  assert.equal(status.pid, lock.pid);
  assert.equal(status.sessions, 0, 'a fresh scratch alpd has no session');

  let jobId = '';
  const client = await hostConnect(lock.socket);
  try {
    for (const name of ['shop', 'secret', 'plain']) {
      const { revision } = await client.request('project.list', {});
      await client.request('project.register', { directory: projects[name], ifRevision: revision, requestId: `desktop-${name}` });
    }
    const { workspaces } = await client.request('workspace.list', {});
    const workspaceOf = Object.fromEntries(workspaces.filter(row => !row.archivedAt).map(row => [row.directory, row.id]));
    const session = async (name, id, title) => {
      await client.request('session.create', { sessionId: id, workspaceId: workspaceOf[projects[name]], spec: { workflow: 'pho', model: MODEL, persist: true } });
      await client.request('session.rename', { sessionId: id, title });
    };
    await session('shop', 'desktop-older', 'Older shop work');
    await new Promise(resolve => setTimeout(resolve, 30));
    await session('shop', 'desktop-newest', 'Newest shop work');
    await session('secret', 'desktop-secret', 'Secret project work');
    // While the session is open (a wake needs an open session).
    const { job } = await client.request('schedule.create', { projectRoot: projects.shop, sessionId: 'desktop-newest', dueAt: new Date(Date.now() + 86_400_000).toISOString(), prompt: 'Check the nightly build and report back' });
    jobId = job.id;
  } finally { client.close(); }
  /** The session of shop alpd updated last, now: the row that carries shop's facts (closing a session updates it too). */
  const latest = async () => {
    const reader = await hostConnect(lock.socket);
    try {
      const { sessions } = await reader.request('session.list', { projectRoot: projects.shop, rootsOnly: true, includeClosed: true });
      return [...sessions].sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)) || a.id.localeCompare(b.id))[0].id;
    } finally { reader.close(); }
  };

  // The `alp` the app runs (ALP_DESKTOP_ALP): this checkout's CLI with the host's environment, whatever
  // environment Electron passes. `alp dashboard --print` starts alp-dashboard, which supervises alpd.
  // Only the variables the host needs are written into it (never the caller's tokens).
  const wrapper = path.join(bin, 'alp');
  const exports = Object.entries(env).filter(([name]) => /^(ALP_[A-Z0-9_]+|FAKE_CODEX_[A-Z]+|PATH|HOME|TMPDIR|NODE_OPTIONS|USER|LOGNAME|LANG)$/.test(name)).map(([name, value]) => `${name}='${String(value).replaceAll("'", "'\\''")}'`);
  await writeFile(wrapper, `#!/bin/sh\nexec env -i ${exports.join(' ')} '${process.execPath}' '${CLI}' "$@"\n`);
  await chmod(wrapper, 0o755);
  // Undone before alpd stops: the dashboard the app started.
  defer(() => alp('dashboard', '--stop').catch(() => {}));
  return { home, projects, ghLog, jobId, latest, wrapper, port, alp };
}

test('owner: Settings › General sets the agents\' language, and the sidebar shows sessions, branch, diff, PR, CI, icon and Schedules', { timeout: 240_000 }, async t => {
  const context = await scratch(t);
  const host = await ownerHost(context);
  const app = await launch(t, context, host.wrapper);
  const info = await waitFor(async () => {
    const value = JSON.parse(await readFile(path.join(host.home, 'dashboard.json'), 'utf8'));
    return value?.port ? value : undefined;
  }, 'alp dashboard to write dashboard.json', 90_000);
  await connectedTo(app, `http://127.0.0.1:${info.port}`, 90_000);
  const page = app.windows()[0];
  await page.emulateMedia({ colorScheme: 'dark' });
  const text = locator => locator.innerText().then(value => value.trim(), () => undefined);
  const has = async (locator, expected, what) => waitFor(async () => (await text(locator)) === expected, `${what} to read ${JSON.stringify(expected)} (now ${JSON.stringify(await text(locator))})`, 30_000);
  const nav = page.getByRole('navigation', { name: 'Workspaces and sessions' });
  const project = name => page.locator(`[data-testid="sidebar-project"][data-path="${host.projects[name]}"]`);
  const row = id => page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);

  // (ii) The sidebar: the owner's top rows, every workspace's sessions, the facts on the most recent row.
  await has(nav.getByTestId('sidebar-new-workspace'), 'New workspace', 'the New workspace row');
  await has(nav.getByTestId('sidebar-schedules'), 'Schedules', 'the Schedules row');
  await waitFor(async () => (await text(row('desktop-newest')))?.includes('Newest shop work'), 'shop\'s newest session row');
  await waitFor(async () => (await text(row('desktop-older')))?.includes('Older shop work'), 'shop\'s older session row');
  await waitFor(async () => (await text(row('desktop-secret')))?.includes('Secret project work'), 'secret\'s session row');
  assert.equal(await project('shop').getByTestId('session-row').count(), 2);
  assert.equal(await project('plain').getByTestId('session-row').count(), 0);
  // The facts sit on the row of the session alpd updated last, read from alpd as the page shows it.
  let latest = '';
  await waitFor(async () => { latest = await host.latest(); return (await row(latest).getAttribute('data-facts')) === 'true'; }, 'the facts on shop\'s most recent row', 30_000);
  const newest = row(latest);
  const earlier = latest === 'desktop-newest' ? 'desktop-older' : 'desktop-newest';
  await has(newest.getByTestId('sidebar-row-diff'), '+120 -0', 'shop\'s diff');
  await has(newest.locator('[data-meta="branch"]'), 'feat/desktop-sidebar', 'shop\'s branch');
  await has(newest.locator('[data-meta="pr"]'), '2', 'shop\'s PR');
  await has(newest.locator('[data-meta="ci"]'), 'failed', 'shop\'s CI');
  assert.equal(await row(earlier).getByTestId('sidebar-row-diff').count(), 0, 'the facts are on the most recent row only');
  await has(row(earlier).locator('[data-meta="branch"]'), 'feat/desktop-sidebar', 'the earlier row\'s branch');
  const secret = row('desktop-secret');
  await has(secret.getByTestId('sidebar-row-diff'), '+12 -4', 'secret\'s diff');
  await has(secret.locator('[data-meta="branch"]'), 'fix/totals', 'secret\'s branch');
  await has(secret.locator('[data-meta="pr"]'), '344 Merged', 'secret\'s PR');
  await has(secret.locator('[data-meta="ci"]'), 'passed', 'secret\'s CI');
  // The project's logo as its icon; the letter tile without one.
  assert.equal(await project('shop').getByTestId('project-icon').getAttribute('src'), ICON);
  await has(project('secret').getByTestId('project-letter-tile'), 'S', 'secret\'s letter tile');
  await has(project('plain').getByTestId('project-letter-tile'), 'P', 'plain\'s letter tile');
  // The PR and CI came from the fake gh, run by alp dashboard in each repository.
  const ghCalls = (await readFile(host.ghLog, 'utf8')).trim().split('\n');
  assert.ok(ghCalls.some(line => line.startsWith(`${host.projects.shop} pr view feat/desktop-sidebar --json`)), ghCalls.join('\n'));
  assert.ok(!ghCalls.some(line => line.startsWith(`${host.projects.plain} `)), 'no gh where there is no repository');

  // Schedules lists the job alpd holds.
  await nav.getByTestId('sidebar-schedules').click();
  const job = page.getByTestId('schedules-screen').locator(`[data-testid="schedule-row"][data-schedule-id="${host.jobId}"]`);
  await has(job.getByTestId('schedule-status'), 'pending', 'the job\'s status');
  await has(job.getByTestId('schedule-prompt'), 'Check the nightly build and report back', 'the job\'s prompt');

  // (i) An owner Settings action: General › Agents' language, written to the host's settings.json.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  await settings.getByTestId('settings-general').click();
  await has(settings.getByTestId('agents-language'), 'Now: Vietnamese (default)', 'the agents\' language');
  await settings.getByLabel('Agents\' language').fill('English');
  await settings.getByRole('button', { name: 'Set', exact: true }).click();
  await has(settings.getByTestId('agents-language'), 'Now: English', 'the agents\' language');
  const stored = JSON.parse(await readFile(path.join(host.home, 'settings.json'), 'utf8'));
  assert.equal(stored.language, 'English');
  assert.equal(stored.dashboard?.port, host.port, 'the rest of settings.json is kept');
  assert.match((await host.alp('language')).stdout, /Language: English/);
  // Still English after the window reloads (read back from the host, not the page's state).
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings' }).getByTestId('settings-general').click();
  await has(page.getByRole('region', { name: 'Settings' }).getByTestId('agents-language'), 'Now: English', 'the agents\' language after a reload');
});

/**
 * A session row's ⋮ menu in ALP.app as the host owner (t-747e; Paseo's workspace menu): Copy path,
 * Copy branch name, Rename, Mark as unread, Open in file manager, Archive, in that order; Open in file
 * manager has alp dashboard open the workspace's directory on the host. A recording program stands in
 * for Finder unless ALP_DESKTOP_REAL_FILE_MANAGER=1, which opens a real Finder window on the scratch
 * project. With ALP_DESKTOP_SHOTS=<dir> it saves a screenshot of the open menu there.
 */
test('owner: a session row\'s ⋮ menu has Paseo\'s items, and Open in file manager opens the workspace on the host', { timeout: 240_000 }, async t => {
  const context = await scratch(t);
  const real = process.env.ALP_DESKTOP_REAL_FILE_MANAGER === '1';
  const opened = path.join(context.dir, 'opened.txt');
  const recorder = path.join(context.dir, 'file-manager.sh');
  await writeFile(recorder, `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`);
  await chmod(recorder, 0o755);
  const host = await ownerHost(context, { fileManager: real ? undefined : recorder });
  const app = await launch(t, context, host.wrapper);
  const info = await waitFor(async () => {
    const value = JSON.parse(await readFile(path.join(host.home, 'dashboard.json'), 'utf8'));
    return value?.port ? value : undefined;
  }, 'alp dashboard to write dashboard.json', 90_000);
  await connectedTo(app, `http://127.0.0.1:${info.port}`, 90_000);
  const page = app.windows()[0];
  const row = page.locator('[data-testid="session-row"][data-session-id="desktop-older"]');
  await waitFor(async () => (await row.innerText().catch(() => ''))?.includes('Older shop work'), 'shop\'s older session row');
  // The branch is known once alp dashboard read the checkout's facts.
  await waitFor(async () => (await row.locator('[data-meta="branch"]').innerText().catch(() => '')) === 'feat/desktop-sidebar', 'shop\'s branch');
  const menu = page.getByRole('menu', { name: 'Actions for Older shop work' });
  const labels = () => menu.getByRole('menuitem').evaluateAll(items => items.map(item => item.querySelector('span')?.textContent?.trim()));
  await row.hover();
  await page.getByRole('button', { name: 'Actions for Older shop work' }).click();
  await waitFor(async () => JSON.stringify(await labels().catch(() => [])) === JSON.stringify(['Copy path', 'Copy branch name', 'Rename', 'Pin to top', 'Labels', 'Mark as unread', 'Open in file manager', 'Archive']),
    `the menu's items (now ${JSON.stringify(await labels().catch(() => []))})`, 30_000);
  assert.match(await menu.getByTestId('sidebar-workspace-menu-archive').innerText(), /⇧⌘⌫/);
  const shots = process.env.ALP_DESKTOP_SHOTS;
  if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'session-menu.png') }); }
  await menu.getByRole('menuitem', { name: 'Open in file manager' }).click();
  if (!real) await waitFor(async () => (await readFile(opened, 'utf8').catch(() => '')) === host.projects.shop, 'the file manager to be asked for shop\'s directory', 30_000);
  // No error notice: alp dashboard answered { opened: true }.
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await page.getByText("Couldn't open folder").count(), 0);
  if (shots) await page.screenshot({ path: path.join(shots, 'session-menu-after-open.png') });
});

/**
 * Paseo parity batch 2 in ALP.app as the host owner (t-a876): the session row's ⋮ Pin to top moves the
 * row to Pinned and alpd keeps it; Labels shows the host's catalog and alpd keeps the check; the
 * project's ⋮ › Open in editor lists the host's editors and has one open the workspace (a recorder
 * stands in for the editor); the header's ⋯ has Copy path, Copy branch name, New terminal and New
 * browser tab; Archive goes at once and Undo brings the session back. With ALP_DESKTOP_SHOTS=<dir>
 * it saves screenshots of the app's own window there.
 */
test('owner: batch 2 menus in ALP.app: pin and labels, Open in editor, the header menu, Archive with Undo', { timeout: 240_000 }, async t => {
  const context = await scratch(t);
  const edited = path.join(context.dir, 'edited.txt');
  const editor = path.join(context.dir, 'editor.sh');
  await writeFile(editor, `#!/bin/sh\nprintf '%s|%s' "$1" "$2" > '${edited}'\n`);
  await chmod(editor, 0o755);
  const host = await ownerHost(context, { editor });
  // A label in the host's catalog (Settings › Workspaces makes them), taken off the workspace again.
  const lock = JSON.parse(await readFile(path.join(host.home, 'alpd.lock'), 'utf8'));
  const client = await hostConnect(lock.socket);
  try {
    const { workspaces, revision } = await client.request('workspace.list', {});
    const workspaceId = workspaces.find(row => row.directory === host.projects.shop && !row.archivedAt).id;
    let at = revision;
    for (const assigned of [true, false]) at = (await client.request('registry.owner', { operation: 'label.assign', args: { workspaceId, label: { name: 'urgent', color: 'red' }, assigned }, ifRevision: at, requestId: `desktop-label-${assigned}` })).registry.revision;
  } finally { client.close(); }
  const app = await launch(t, context, host.wrapper);
  const info = await waitFor(async () => {
    const value = JSON.parse(await readFile(path.join(host.home, 'dashboard.json'), 'utf8'));
    return value?.port ? value : undefined;
  }, 'alp dashboard to write dashboard.json', 90_000);
  await connectedTo(app, `http://127.0.0.1:${info.port}`, 90_000);
  const page = app.windows()[0];
  const shots = process.env.ALP_DESKTOP_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, name) }); };
  const read = async id => {
    const reader = await hostConnect(lock.socket);
    try { return (await reader.request('session.get', { sessionId: id })).session; } finally { reader.close(); }
  };
  const row = page.locator('[data-testid="session-row"][data-session-id="desktop-older"]');
  await waitFor(async () => (await row.innerText().catch(() => ''))?.includes('Older shop work'), 'shop\'s older session row');
  const rowMenu = async () => {
    await row.hover();
    await page.getByRole('button', { name: 'Actions for Older shop work' }).click();
    const menu = page.getByRole('menu', { name: 'Actions for Older shop work' });
    await menu.waitFor();
    return menu;
  };

  // Pin to top: alpd keeps pinnedAt; the row sits in Pinned.
  let menu = await rowMenu();
  await menu.getByRole('menuitem', { name: 'Pin to top' }).click();
  await waitFor(async () => typeof (await read('desktop-older'))?.pinnedAt === 'string', 'alpd to keep the pin');
  await waitFor(async () => await page.getByTestId('sidebar-pinned-sessions').locator('[data-session-id="desktop-older"]').count() === 1, 'the row in Pinned');
  // Labels: the catalog's label, checked, kept by alpd.
  menu = await rowMenu();
  await menu.getByRole('menuitem', { name: 'Labels' }).click();
  const labelsPage = page.getByRole('menu', { name: 'Labels' });
  await labelsPage.getByRole('menuitemcheckbox', { name: 'urgent' }).click();
  await waitFor(async () => JSON.stringify((await read('desktop-older'))?.labels) === '["urgent"]', 'alpd to keep the label');
  await shot('batch2-session-labels.png');
  await page.keyboard.press('Escape');

  // Open in editor from the project's ⋮: the host's editors; Zed opens shop's directory.
  const project = page.locator(`[data-testid="sidebar-project"][data-path="${host.projects.shop}"]`).getByTestId('project-row');
  await project.hover();
  await page.getByRole('button', { name: /^Project actions for / }).first().click();
  await page.getByRole('menu', { name: /^Project actions for / }).getByRole('menuitem', { name: 'Open in editor' }).click();
  const editors = page.getByRole('menu', { name: 'Open in editor' });
  await waitFor(async () => JSON.stringify(await editors.getByTestId('project-open-editor-item').allInnerTexts().catch(() => [])) === '["Visual Studio Code","Zed"]', 'the host\'s editors');
  await shot('batch2-open-in-editor.png');
  await editors.getByRole('menuitem', { name: 'Zed' }).click();
  await waitFor(async () => (await readFile(edited, 'utf8').catch(() => '')) === `zed|${host.projects.shop}`, 'the editor to be asked for shop\'s directory', 30_000);
  assert.equal(await page.getByText("Couldn't open").count(), 0);

  // The header's ⋯ on the open session: Paseo's items; New browser tab only in ALP.app, New terminal only with terminal.exec (not in the dashboard's default grant).
  await row.click();
  await page.locator('main header').getByRole('button', { name: 'Session actions' }).click();
  const header = page.getByRole('menu', { name: 'Session actions' });
  const items = await header.getByRole('menuitem').evaluateAll(entries => entries.map(entry => entry.querySelector('span')?.textContent?.trim()));
  assert.deepEqual(items, ['Copy path', 'Copy branch name', 'New browser tab', 'Rename', 'Copy session ID', 'Archive']);
  await shot('batch2-header-menu.png');
  await header.getByRole('menuitem', { name: 'New browser tab' }).click();
  await waitFor(async () => await page.locator('[data-testid="workspace-tab"][data-tab^="browser:"]').count() === 1, 'a Browser tab');

  // Archive from the header: the row goes at once; Undo brings it back on the host.
  await page.locator('main header').getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('menu', { name: 'Session actions' }).getByRole('menuitem', { name: 'Archive' }).click();
  await waitFor(async () => (await read('desktop-older'))?.archived === true, 'alpd to archive it');
  await shot('batch2-archive-undo.png');
  await page.getByTestId('notice-undo-archive').click();
  await waitFor(async () => !(await read('desktop-older'))?.archived, 'Undo to unarchive it');
  await waitFor(async () => await row.count() === 1, 'the row back');
});
