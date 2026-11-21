// Settings as the host owner (t-a95b group C; docs/alp/dashboard.md §4.8): through `alp dashboard`
// (its gateway has the owner option, its link token is the owner on a direct loopback socket) the
// owner edits, tests and removes MCP servers and hooks of this host's library with a review of what
// will run, keeps a hidden env value as stored, edits a workspace file (and is told, without a
// write, when the file changed under it), and sets the agents' language. The same world's standalone
// alp-gateway has no owner: its tokens still see the read-only pages and Unavailable notes. The
// dashboard credential holds no files.read: the owner reads files through host.files.*.
import { expect, test } from '@playwright/test';
import { readFile, realpath, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { connect as hostConnect } from '@anhlp/alp-client';
import { startWorld } from './support/world.js';
import { connect } from './support/app.js';
import { dashboardSettings, startDashboard } from './support/dashboard.js';
import { closeWorldAfter } from './support/cleanup.js';

const HIDDEN = '‹hidden on the host›';
const SECRET = 'SENTINEL-OWNER-ENV-VALUE';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
/** @type {Awaited<ReturnType<typeof startDashboard>>} */
let dashboard;
let project;

async function host(method, params) {
  const client = await hostConnect(world.socket);
  try { return await client.request(method, params); } finally { client.close(); }
}

test.beforeAll(async () => {
  world = await startWorld({ settings: await dashboardSettings() });
  project = await realpath(world.projects.main);
  // The project in alpd's registry, as `alp run` there would put it: the dashboard grants it.
  const { revision } = await host('project.list', {});
  await host('project.register', { directory: project, ifRevision: revision, requestId: 'settings-library-e2e' });
  // A library MCP server whose env holds a secret, and a library hook to try out.
  await world.alp('mcp', 'add', 'search', '--command', 'node', '--arg', 'server.js', '--env', `API_TOKEN=${SECRET}`);
  await world.alp('hook', 'add', 'notify', '--event', 'turn.end', '--command', 'echo notify-ran');
  await writeFile(path.join(project, 'notes.md'), '# Notes\n\nfirst line\n');
  dashboard = await startDashboard(world);
});
test.afterAll(async () => {
  if (!world) return;
  await closeWorldAfter(world, async () => { await dashboard?.stop(); });
});

const openSettings = async page => {
  await page.getByRole('button', { name: 'Settings' }).click();
  return page.getByRole('region', { name: 'Settings' });
};

/** Opens the dashboard's link: the app connects by itself as the host owner, on the project. */
async function asOwner(page) {
  await page.goto(dashboard.url);
  const row = page.locator(`[data-testid="project-row"][data-workspace="${project}"]`);
  await expect(row).toBeVisible();
  await expect(page.locator('main header')).toBeVisible();
}

const stored = async file => JSON.parse(await readFile(file, 'utf8'));

test('owner: an MCP server is edited with a review of what will run; the hidden env value is kept as stored, never written as the mask', async ({ page }) => {
  const frames = [];
  page.on('websocket', socket => socket.on('framereceived', frame => frames.push(String(frame.payload))));
  await asOwner(page);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-alp-mcp').click();
  await settings.getByTestId('library-row-search').click();
  const editor = settings.getByTestId('owner-library-editor');
  await expect(editor.getByLabel('Command')).toHaveValue('node');
  await expect(editor.getByLabel('Arguments')).toHaveValue('server.js');
  // The env value is hidden: its name shows, its value is the mask and never reaches the page.
  await expect(editor.getByLabel('Environment variables name 1')).toHaveValue('API_TOKEN');
  await expect(editor.getByTestId('secret-kept')).toHaveText(HIDDEN);

  await editor.getByLabel('Arguments').fill('server.js\n--verbose');
  await editor.getByRole('button', { name: 'Review and save…' }).click();
  const review = editor.getByTestId('owner-library-review');
  await expect(review).toContainText('node server.js --verbose');
  await expect(review).toContainText(`Env API_TOKEN${HIDDEN} (kept as stored)`);
  await expect(review).toContainText('This host (your library)');
  await editor.getByRole('button', { name: 'Confirm and save' }).click();
  await expect(editor.getByRole('status').first()).toContainText('Saved search');

  // On the host: the change saved, the secret intact, no mask anywhere.
  const file = path.join(world.home, 'mcp', 'search.json');
  const server = await stored(file);
  expect(server.args).toEqual(['server.js', '--verbose']);
  expect(server.env).toEqual({ API_TOKEN: SECRET });
  expect(await readFile(file, 'utf8')).not.toContain(HIDDEN);
  // Read again: still hidden in the page.
  await page.reload();
  const again = await openSettings(page);
  await again.getByTestId('settings-alp-mcp').click();
  await again.getByTestId('library-row-search').click();
  await expect(again.getByTestId('owner-library-editor').getByTestId('secret-kept')).toHaveText(HIDDEN);
  await expect(again.getByTestId('owner-library-editor').getByLabel('Arguments')).toHaveValue('server.js\n--verbose');

  // A replaced value is written as typed.
  const editor2 = again.getByTestId('owner-library-editor');
  await editor2.getByRole('button', { name: 'Replace' }).click();
  await editor2.getByLabel('Environment variables value 1').fill('NEW-TOKEN-VALUE');
  await editor2.getByRole('button', { name: 'Review and save…' }).click();
  await expect(editor2.getByTestId('owner-library-review')).toContainText('Env API_TOKEN•••••• (new value)');
  await editor2.getByRole('button', { name: 'Confirm and save' }).click();
  await expect(editor2.getByRole('status').first()).toContainText('Saved search');
  expect((await stored(file)).env).toEqual({ API_TOKEN: 'NEW-TOKEN-VALUE' });
  expect(frames.filter(frame => frame.includes(SECRET) || frame.includes('NEW-TOKEN-VALUE'))).toEqual([]);
});

test('owner: a hook is created with a review, tested, and deleted', async ({ page }) => {
  await asOwner(page);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-alp-hooks').click();
  // Test an existing hook: it runs once, as alp hook test does.
  await settings.getByTestId('library-row-notify').click();
  let editor = settings.getByTestId('owner-library-editor');
  await expect(editor.getByLabel('Hook command')).toHaveValue('echo notify-ran');
  await editor.getByRole('button', { name: 'Test saved entry' }).click();
  const result = editor.getByTestId('owner-library-test');
  await expect(result).toHaveAttribute('data-ok', 'true');
  await expect(result).toContainText('stdout: notify-ran');

  // A new hook.
  await settings.getByRole('button', { name: 'New', exact: true }).click();
  editor = settings.getByTestId('owner-library-editor');
  await editor.getByLabel('Entry name').fill('audit');
  await editor.getByLabel('Event').selectOption('handoff');
  await editor.getByLabel('Hook command').fill('echo audit-ok');
  await editor.getByLabel('Blocking').check();
  await editor.getByRole('button', { name: 'Review and save…' }).click();
  const review = editor.getByTestId('owner-library-review');
  await expect(review).toContainText('Runs (shell)echo audit-ok');
  await expect(review).toContainText('Onhandoff');
  await expect(review).toContainText('Blockingyes');
  await editor.getByRole('button', { name: 'Confirm and save' }).click();
  await expect(settings.getByTestId('library-row-audit')).toBeVisible();
  expect(await stored(path.join(world.home, 'hooks', 'audit.json'))).toMatchObject({ event: 'handoff', command: 'echo audit-ok', blocking: true });

  // Delete it.
  await settings.getByTestId('library-row-audit').click();
  editor = settings.getByTestId('owner-library-editor');
  await editor.getByRole('button', { name: 'Delete…' }).click();
  await editor.getByRole('button', { name: /^Delete audit from/ }).click();
  await expect(settings.getByTestId('library-row-audit')).toHaveCount(0);
  await expect(access(path.join(world.home, 'hooks', 'audit.json'))).rejects.toThrow();
});

test('owner: a workspace file is edited and saved; a file changed on the host is a conflict and nothing is written', async ({ page }) => {
  await asOwner(page);
  // The dashboard credential has no files.read: the owner still browses and reads (host.files.*).
  const dock = page.getByRole('complementary', { name: 'Explorer' });
  await dock.getByRole('tab', { name: 'Files' }).click();
  await expect(dock.getByTestId('files-panel')).toBeVisible();
  await dock.locator('[data-testid="files-entry"][data-path="notes.md"]').click();
  const view = page.getByRole('main').getByTestId('file-view');
  await expect(view.getByTestId('file-view-path')).toHaveText('notes.md');
  await view.getByTestId('file-view-edit').click();
  await view.getByTestId('file-view-editor').fill('# Notes\n\nedited in the app\n');
  await view.getByTestId('file-view-save').click();
  await expect(view.getByTestId('file-view-editor')).toHaveCount(0);
  expect(await readFile(path.join(project, 'notes.md'), 'utf8')).toBe('# Notes\n\nedited in the app\n');
  // Read again from the host.
  await view.getByTestId('file-view-refresh').click();
  await view.getByRole('button', { name: 'Source' }).click();
  await expect(view.getByTestId('file-view-content')).toContainText('edited in the app');

  // An agent changes the file while it is open in the editor: the save is refused, nothing written.
  await view.getByTestId('file-view-edit').click();
  await view.getByTestId('file-view-editor').fill('# Notes\n\nmy second edit\n');
  await writeFile(path.join(project, 'notes.md'), '# Notes\n\nan agent wrote this\n');
  await view.getByTestId('file-view-save').click();
  await expect(view.getByTestId('file-view-save-error')).toHaveAttribute('data-conflict', 'true');
  await expect(view.getByTestId('file-view-save-error')).toContainText('changed on the host since you opened it');
  await expect(view.getByTestId('file-view-editor')).toHaveValue('# Notes\n\nmy second edit\n');
  expect(await readFile(path.join(project, 'notes.md'), 'utf8')).toBe('# Notes\n\nan agent wrote this\n');

  // Settings › Editor and Files say what the owner may do.
  const settings = await openSettings(page);
  await settings.getByTestId('settings-editor').click();
  await expect(settings.getByTestId('editor-owner')).toHaveText('On, for you on this host');
  await settings.getByTestId('settings-files').click();
  await expect(settings.getByTestId('files-read-access')).toHaveText('Yes, as the owner of this host');
  await expect(settings.getByTestId('files-edit-access')).toHaveText('Yes');
});

test('owner: General › Agents\' language is set and reset on the host; Chat has no reasoning row', async ({ page }) => {
  await asOwner(page);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-general').click();
  await expect(settings.getByTestId('agents-language')).toHaveText('Now: Vietnamese (default)');
  await settings.getByLabel('Agents\' language').fill('English');
  await settings.getByRole('button', { name: 'Set', exact: true }).click();
  await expect(settings.getByTestId('agents-language')).toHaveText('Now: English');
  expect((await stored(path.join(world.home, 'settings.json'))).language).toBe('English');
  expect(await world.alp('language')).toContain('Language: English');
  // Host › Overview shows the same setting, read only, and says where it changes.
  await settings.getByTestId('settings-host').click();
  await expect(settings).toContainText('Changed in App › General');
  await expect(settings).toContainText('English');
  await settings.getByTestId('settings-general').click();
  await settings.getByRole('button', { name: 'Reset' }).first().click();
  await expect(settings.getByTestId('agents-language')).toHaveText('Now: Vietnamese (default)');
  expect((await stored(path.join(world.home, 'settings.json'))).language).toBeUndefined();

  await settings.getByTestId('settings-chat').click();
  await expect(settings.getByLabel('Chat display')).toBeVisible();
  await expect(settings).not.toContainText('reasoning');
});

test('a non-owner (the standalone gateway) keeps the read-only pages: language, library editing, editor, files', async ({ page }) => {
  await connect(page, world, world.tokens.filesReader);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-general').click();
  await expect(settings.getByLabel('Agents\' language')).toHaveCount(0);
  await expect(settings.getByTestId('agents-language')).toHaveText(/Vietnamese|English/);
  await settings.getByTestId('settings-alp-mcp').click();
  await expect(settings.getByTestId('owner-library-editor')).toHaveCount(0);
  await expect(settings).toContainText('Editing MCP servers is not available in this beta');
  await settings.getByTestId('library-row-search').click();
  await expect(settings.getByTestId('library-entry')).toContainText(`"API_TOKEN": "${HIDDEN}"`);
  await settings.getByTestId('settings-alp-hooks').click();
  await expect(settings).toContainText('Editing hooks is not available in this beta');
  await settings.getByTestId('settings-editor').click();
  await expect(settings).toContainText('Editor is not available in this beta');
  await settings.getByTestId('settings-files').click();
  await expect(settings.getByTestId('files-read-access')).toHaveText('Yes (files.read)');
  await expect(settings.getByTestId('files-edit-access')).toHaveText('No');
  await settings.getByRole('button', { name: 'Back' }).click();
  // A file opens read only: no Edit.
  const dock = page.getByRole('complementary', { name: 'Explorer' });
  await dock.getByRole('tab', { name: 'Files' }).click();
  await dock.locator('[data-testid="files-entry"][data-path="notes.md"]').click();
  const view = page.getByRole('main').getByTestId('file-view');
  await expect(view.getByTestId('file-view-path')).toHaveText('notes.md');
  await expect(view.getByTestId('file-view-meta')).toBeVisible();
  await expect(view.getByTestId('file-view-edit')).toHaveCount(0);
});

test('owner: Skills, Agents and Templates are edited in this host\'s library, not only the project', async ({ page }) => {
  await asOwner(page);
  const settings = await openSettings(page);
  // A new skill in the library (host scope).
  await settings.getByTestId('settings-alp-skills').click();
  let editor = settings.getByTestId('owner-library-editor');
  await expect(editor.getByLabel('Saved in')).toHaveValue('library');
  await editor.getByLabel('Entry name').fill('house-style');
  await editor.getByLabel('skills entry JSON').fill(JSON.stringify({ body: '---\nname: house-style\ndescription: "How this house writes. Use when writing docs."\n---\n\n# house-style\n' }));
  await editor.getByRole('button', { name: 'Review and save…' }).click();
  await expect(editor.getByTestId('owner-library-review')).toContainText('nothing by itself');
  await editor.getByRole('button', { name: 'Confirm and save' }).click();
  await expect(settings.getByTestId('library-row-house-style')).toBeVisible();
  expect(await readFile(path.join(world.home, 'skills', 'house-style', 'SKILL.md'), 'utf8')).toContain('How this house writes.');
  await settings.getByTestId('library-row-house-style').click();
  editor = settings.getByTestId('owner-library-editor');
  await editor.getByRole('button', { name: 'Delete…' }).click();
  await editor.getByRole('button', { name: /^Delete house-style from/ }).click();
  await expect(settings.getByTestId('library-row-house-style')).toHaveCount(0);

  // A built-in agent opened in the library scope: saving makes this host's copy of it.
  await settings.getByTestId('settings-alp-agents').click();
  await settings.getByTestId('library-row-oracle').click();
  editor = settings.getByTestId('owner-library-editor');
  await expect(editor.getByRole('status').first()).toContainText('Not in this host (your library) yet');
  const content = JSON.parse(await editor.getByLabel('agents entry JSON').inputValue());
  content.config = { ...content.config, description: 'Oracle, as this host has it' };
  await editor.getByLabel('agents entry JSON').fill(JSON.stringify(content));
  await editor.getByRole('button', { name: 'Review and save…' }).click();
  await editor.getByRole('button', { name: 'Confirm and save' }).click();
  await expect(editor.getByRole('status').first()).toContainText('Saved oracle');
  expect((await stored(path.join(world.home, 'agents', 'oracle', 'agent.json'))).description).toBe('Oracle, as this host has it');

  // Templates list and open in the owner's editor too.
  await settings.getByTestId('settings-alp-templates').click();
  await expect(settings.getByTestId('owner-library-editor')).toBeVisible();
});

test('audit: every other control on the owner\'s app and host tabs does what it says', async ({ page }) => {
  await asOwner(page);
  const settings = await openSettings(page);
  // Library pages: Refresh lists again; an opened entry shows its content and Close closes it.
  for (const [id, row] of [['settings-alp-templates', null], ['settings-alp-agents', 'main'], ['settings-alp-skills', null]]) {
    await settings.getByTestId(id).click();
    await settings.getByRole('button', { name: 'Refresh' }).click();
    await expect(settings.locator('[data-testid^="library-row-"]').first()).toBeVisible();
    const first = row ? settings.getByTestId(`library-row-${row}`) : settings.locator('[data-testid^="library-row-"]').first();
    await first.click();
    await expect(settings.getByTestId('library-entry')).toBeVisible();
    await settings.getByTestId('library-entry').locator('..').locator('..').getByRole('button', { name: 'Close' }).click();
    await expect(settings.getByTestId('library-entry')).toHaveCount(0);
  }
  // Overview: the host, the language and the models; no control that does nothing.
  await settings.getByTestId('settings-host').click();
  await expect(settings).toContainText('Agents\' language');
  await expect(settings.getByTestId('settings-models-refresh')).toHaveCount(0);
  // About: What's new links to the releases.
  await settings.getByTestId('settings-about').click();
  await expect(settings.getByTestId('settings-whats-new')).toHaveAttribute('href', 'https://github.com/phucanh08/alp/releases');
  // Connections: Disconnect forgets the token and shows the connect form.
  await settings.getByTestId('settings-connections').click();
  await expect(settings).toContainText('Loopback HTTP / WS');
  await settings.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByLabel('Access token')).toBeVisible();
});
