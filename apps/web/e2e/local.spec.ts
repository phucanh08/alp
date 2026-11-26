// `alp dashboard` end to end (docs/alp/dashboard.md §4.2): a real alpd with the fake Codex in a temporary home,
// the built CLI's `alp dashboard --print` starting the alp-dashboard service (dist/alp-dashboard.js serving
// dist/alp-dashboard) on a free loopback port, and `alp run` making a session. The browser opens the
// printed address, whose fragment carries the token: the app connects by itself (no form), takes the
// token out of the address, keeps it in this tab's sessionStorage only, connects again after a
// reload, reconnects by itself when alp-dashboard changes the grant (4403), and after `alp dashboard rotate`
// shows the connect form with a message to run `alp dashboard` again. No fixed waits: every step waits
// for what it needs, in the page or on the host.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { connect as hostConnect } from '@anhlp/alp-client';
import type { SessionSummary } from '@anhlp/alp-protocol';
import { freePort, startWorld } from './support/world.ts';
import type { World } from './support/world.ts';
import { closeWorldAfter } from './support/cleanup.ts';

const run = promisify(execFile);
const LINK = /^http:\/\/127\.0\.0\.1:(\d+)\/#token=(alpgw1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43})$/m;

let world: World;
let env: NodeJS.ProcessEnv;
// The page global the init script below sets.
declare global {
  interface Window { __alp: { hashAtLoad: boolean, formSeen: boolean } }
}
test.beforeAll(async () => {
  const port = await freePort();
  world = await startWorld({ serveWeb: false, gateway: false, settings: { dashboard: { port }, web: { relay: { enabled: false } } } });
  // The alp-dashboard service: this test's alpd (no supervision of its own) and a fast registry refresh,
  // so a new project changes the grant within a moment.
  env = { ...world.env, ALP_SUPERVISE: '0', ALP_DASHBOARD_GRANT_REFRESH_MS: '200' };
  delete env.ALP_DASHBOARD_APP;
});
test.afterAll(async () => {
  if (!world) return;
  await closeWorldAfter(world, async () => {
    // alp-dashboard before alpd: it holds a socket to alpd and the browser's connections.
    const info = await readFile(path.join(world.home, 'dashboard.json'), 'utf8').then(JSON.parse, () => undefined);
    if (info?.pid) {
      try { process.kill(info.pid, 'SIGTERM'); } catch {}
      await expect.poll(() => { try { process.kill(info.pid, 0); return true; } catch { return false; } }, { timeout: 15_000 }).toBe(false);
    }
  });
});

/** The CLI on the host, in the main project, as its owner runs it. */
const alp = async (...args: string[]) => (await run(process.execPath, [world.cli, ...args], { env, cwd: world.projects.main, timeout: 120_000 })).stdout;

async function host(method: string, params: unknown) {
  const owner = await hostConnect(world.socket);
  try { return await owner.request(method, params); } finally { owner.close(); }
}

/** Everything that could carry the token out of the page: console, errors, request URLs and Referer. */
function watchLeaks(page: Page, leaks: string[]) {
  page.on('console', message => leaks.push(`console: ${message.text()}`));
  page.on('pageerror', error => leaks.push(`pageerror: ${error.message}`));
  page.on('request', request => leaks.push(`request: ${request.url()} referer=${request.headers().referer ?? ''}`));
}

/** Records whether the connect form ever showed in this document, and what the address held at load. */
const observeForm = () => {
  window.__alp = { hashAtLoad: location.hash.length > 0, formSeen: false };
  const check = () => { if (document.querySelector('input#token')) window.__alp.formSeen = true; };
  new MutationObserver(check).observe(document, { childList: true, subtree: true });
};

const tokenInput = (page: Page) => page.getByLabel('Access token');
const sessionRow = (page: Page, title: string) => page.getByRole('navigation', { name: 'Workspaces and sessions' }).getByTestId('session-row').filter({ hasText: title });

/** What the page stores: every localStorage entry, and this tab's sessionStorage. */
const storage = (page: Page) => page.evaluate(() => ({
  local: Object.keys(localStorage).map(key => `${key}=${localStorage.getItem(key)}`).join('\n'),
  session: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
}));

test('alp dashboard opens the app connected by its link token, kept in the tab only; rotate ends it', async ({ page, browser }) => {
  test.setTimeout(240_000);
  // A session made from the CLI, before the browser opens.
  // Run in the project, as `alp dashboard` is: both name it by its real path (the temporary directory may
  // be reached through a symbolic link, /var -> /private/var on macOS). `alp run` ends its session
  // when the turn is over: the sidebar lists closed sessions too.
  const project = await realpath(world.projects.main);
  const ran = await alp('run', '--json', 'hello from the cli');
  const sessionId = JSON.parse(ran.split('\n')[0]).sessionId;
  const { sessions } = await host('session.list', { projectRoot: project, rootsOnly: true, includeClosed: true });
  expect(sessions.map((row: SessionSummary) => row.id)).toEqual([sessionId]);
  const session = sessions[0];
  const title = session.title || session.id;

  const printed = await alp('dashboard', '--print');
  const link = LINK.exec(printed.trim());
  expect(link, printed).not.toBeNull();
  const [url, , token] = link!;
  const origin = new URL(url).origin;

  const leaks: string[] = [];
  watchLeaks(page, leaks);
  const tickets = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/tickets') tickets.push(request.url()); });
  await page.addInitScript(observeForm);
  await page.goto(url);

  // Connected by itself: the session from the CLI is in the sidebar; the form never showed.
  await expect(sessionRow(page, title)).toBeVisible();
  await expect(tokenInput(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__alp)).toEqual({ hashAtLoad: true, formSeen: false });
  // The token left the address and stays in this tab only.
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(page.url()).toBe(`${origin}/`);
  let stored = await storage(page);
  expect(stored.local).not.toContain('alpgw1');
  expect(stored.session).toEqual({ ...stored.session, 'alp-web:link-token': token });
  expect(await page.title()).not.toContain('alpgw1');

  // A reload of the tab connects again with the kept token, the address already clean.
  await page.reload();
  await expect(sessionRow(page, title)).toBeVisible();
  expect(await page.evaluate(() => window.__alp)).toEqual({ hashAtLoad: false, formSeen: false });
  expect((await storage(page)).local).not.toContain('alpgw1');

  // alp-dashboard follows alpd's registry: a new project changes the grant, the gateway closes the page's
  // socket with 4403, and the page reconnects with the same token, the new project now granted.
  await mkdir(path.join(world.directory, 'projects', 'added'), { recursive: true });
  const added = await realpath(path.join(world.directory, 'projects', 'added'));
  const before = tickets.length;
  const { revision } = await host('project.list', {});
  await host('project.register', { directory: added, ifRevision: revision, requestId: 'local-e2e-added' });
  await expect(page.locator(`[data-testid="project-row"][data-workspace="${added}"]`)).toBeVisible({ timeout: 30_000 });
  expect(tickets.length).toBeGreaterThan(before);
  await expect(sessionRow(page, title)).toBeVisible();
  expect(await page.evaluate(() => window.__alp.formSeen)).toBe(false);

  // alp dashboard rotate: the old tab's token is refused once the service is back, so the page forgets it
  // and shows the connect form saying why.
  await alp('dashboard', 'rotate');
  await expect(page.getByRole('alert')).toHaveText(/no longer valid.*alp dashboard/, { timeout: 60_000 });
  await expect(tokenInput(page)).toBeVisible();
  await expect(page.getByLabel('Gateway address')).toHaveValue(origin);
  stored = await storage(page);
  expect(stored.session['alp-web:link-token']).toBeUndefined();
  expect(stored.local).not.toContain('alpgw1');
  // Reloading does not try the old token again; the form still names alp dashboard's own address, and
  // its help points to alp dashboard.
  await page.reload();
  await expect(tokenInput(page)).toBeVisible();
  await expect(page.getByLabel('Gateway address')).toHaveValue(origin);
  await page.getByText('Getting a token').click();
  await expect(page.getByText(/run alp dashboard: it opens this page/)).toBeVisible();

  // The new link works in a new tab.
  const fresh = LINK.exec((await alp('dashboard', '--print')).trim());
  expect(fresh?.[2]).toBeTruthy();
  expect(fresh![2]).not.toBe(token);
  const other = await browser.newPage();
  watchLeaks(other, leaks);
  await other.goto(fresh![0]);
  await expect(sessionRow(other, title)).toBeVisible();
  expect(await other.evaluate(() => location.hash)).toBe('');
  await other.close();

  // Nothing carried either token out: console, page errors, request URLs, Referer; nor alp-dashboard's log.
  for (const secret of [token, fresh![2], 'alpgw1.']) expect(leaks.filter(entry => entry.includes(secret))).toEqual([]);
  const log = await readFile(path.join(world.home, 'logs', 'integrations', 'alp-dashboard.log'), 'utf8').catch(() => '');
  expect(log).not.toContain(token);
  expect(log).not.toContain(fresh![2]);
});
