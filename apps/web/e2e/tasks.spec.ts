// ALP's task board with the alp-provider plugin's views (t-7679.17, docs/paseo-parity.md): the
// List / Board / Epics views, the Open / Ready / Closed / All filters with their counts and the
// search, in the Tasks tab and on the full-screen Tasks screen, through the real UI, gateway and
// alpd; tasks seeded and changed with the alp CLI on the host, as main and its agents would.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect, openTasks } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
/** @type {Record<string, string>} */
const ids = {};

/** Adds a task with the CLI and returns its id. */
async function add(...args) {
  const out = await world.alp('task', 'add', ...args);
  const id = /tasks\/(t-[\w.]+)\.json/.exec(out)?.[1];
  if (!id) throw new Error(`no task id in: ${out}`);
  return id;
}

test.beforeAll(async () => {
  world = await startWorld();
  ids.epic = await add('Ship v2', '-t', 'epic');
  ids.login = await add('Fix login', '-t', 'bug', '-p', '0', '--parent', ids.epic);
  ids.deploy = await add('Deploy', '--parent', ids.epic, '--after', ids.login, '-l', 'release');
  ids.docs = await add('Write docs', '-l', 'docs', '-p', '3');
  ids.legal = await add('Legal check', '-p', '1');
  await world.alp('task', 'gate', 'add', ids.legal, '--human', 'Sign the contract');
});
test.afterAll(async () => { await world?.close(); });

const filter = (scope, key) => scope.getByTestId(`tasks-filter-${key}`);
const view = (scope, name) => scope.getByRole('group', { name: 'Task view' }).getByRole('button', { name });

test('Tasks tab: List groups, filters with counts, search, Board columns, Epics progress', async ({ page }) => {
  await connect(page, world);
  await openTasks(page);
  const board = page.getByTestId('task-board');
  await expect(board).toHaveAttribute('data-view', 'list');
  await expect(board.getByTestId('tasks-open-count')).toHaveText('5 open');
  await expect(filter(board, 'open')).toHaveText('Open 5');
  await expect(filter(board, 'open')).toHaveAttribute('aria-pressed', 'true');
  await expect(filter(board, 'ready')).toHaveText('Ready 2');
  await expect(filter(board, 'closed')).toHaveText('Closed 0');
  await expect(filter(board, 'all')).toHaveText('All 5');

  // List: what waits for the user first, each task once.
  const sections = board.getByTestId(/^tasks-section-/);
  await expect(sections).toHaveCount(4);
  await expect(board.getByTestId('tasks-section-approve').getByTestId('task-row')).toHaveText([/Legal check/]);
  await expect(board.getByTestId('tasks-section-ready').getByTestId('task-row')).toHaveText([/Fix login/, /Write docs/]);
  await expect(board.getByTestId('tasks-section-waiting').getByTestId('task-row')).toHaveText([/Deploy.*after/]);
  await expect(board.getByTestId('tasks-section-epics').getByTestId('task-row')).toHaveText([/Ship v2/]);
  await expect(board.getByTestId('task-row').filter({ hasText: 'Deploy' })).toContainText('#release');
  // A group folds.
  await board.getByTestId('tasks-section-ready').getByRole('button', { name: 'Ready 2', exact: true }).click();
  await expect(board.getByTestId('tasks-section-ready').getByTestId('task-row')).toHaveCount(0);
  await board.getByTestId('tasks-section-ready').getByRole('button', { name: 'Ready 2', exact: true }).click();
  await expect(board.getByTestId('tasks-section-ready').getByTestId('task-row')).toHaveCount(2);

  // Ready keeps the ready tasks; the search every word in id, title, type, assignee, labels.
  await filter(board, 'ready').click();
  await expect(board.getByTestId('task-row')).toHaveText([/Fix login/, /Write docs/]);
  await filter(board, 'all').click();
  const search = board.getByRole('searchbox', { name: 'Filter tasks' });
  await expect(search).toHaveAttribute('placeholder', 'Filter by id, title, label, agent');
  await search.fill('RELEASE');
  await expect(board.getByTestId('task-row')).toHaveText([/Deploy/]);
  await search.fill('bug login');
  await expect(board.getByTestId('task-row')).toHaveText([/Fix login/]);
  await search.fill('nothing like this');
  await expect(board.getByText('No tasks match.')).toBeVisible();
  await search.fill('');
  await filter(board, 'open').click();

  // Board: a column per state, epics left out; a card opens the task's tab.
  await view(board, 'Board').click();
  await expect(board).toHaveAttribute('data-view', 'board');
  await expect(view(board, 'Board')).toHaveAttribute('aria-pressed', 'true');
  const columns = board.getByTestId(/^tasks-column-/);
  await expect(columns.locator('h3')).toHaveText([/Needs approval\s*1/, /Blocked\s*1/, /Ready\s*2/, /In progress\s*0/]);
  await expect(board.getByTestId('tasks-column-blocked').getByTestId('task-card')).toHaveText([/Deploy/]);
  await expect(board.getByTestId('tasks-column-ready').getByTestId('task-card')).toHaveText([/P0.*Fix login/, /P3.*Write docs/]);
  await expect(board.getByTestId('task-card').filter({ hasText: 'Ship v2' })).toHaveCount(0);
  await expect(board.getByTestId('tasks-column-progress')).toContainText('Nothing here');
  await board.getByTestId('task-card').filter({ hasText: 'Write docs' }).click();
  await expect(page.getByRole('tab', { name: 'Write docs' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('task-detail').getByRole('heading', { name: 'Write docs' })).toBeVisible();

  // Epics: progress and the epic's tasks, folding; the host's changes come in by polling.
  await view(board, 'Epics').click();
  const epic = board.getByTestId('epic');
  await expect(epic).toHaveCount(1);
  await expect(epic.getByTestId('epic-progress')).toHaveText('0/2');
  await expect(epic.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await expect(epic.getByTestId('epic-task')).toHaveText([/Fix login/, /Deploy/]);
  await epic.getByRole('button', { name: '2 tasks' }).click();
  await expect(epic.getByTestId('epic-task')).toHaveCount(0);
  await epic.getByRole('button', { name: '2 tasks' }).click();
  await world.alp('task', 'close', ids.login, '-m', 'fixed');
  await expect(epic.getByTestId('epic-progress')).toHaveText('1/2', { timeout: 15_000 });
  await expect(epic.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  await expect(filter(board, 'closed')).toHaveText('Closed 1');
  // A closed child stays under its open epic; the Closed filter has no epic.
  await expect(epic.getByTestId('epic-task').filter({ hasText: 'Fix login' })).toContainText('closed');
  await filter(board, 'closed').click();
  await expect(board.getByText(/^No epics here/)).toBeVisible();

  // Back in the List, Closed shows the closed task; the human gate is approved from its row.
  await view(board, 'List').click();
  await expect(board.getByTestId('tasks-section-closed').getByTestId('task-row')).toHaveText([/Fix login/]);
  await filter(board, 'open').click();
  await board.getByRole('button', { name: `Approve ${ids.legal}` }).click();
  await expect(board.getByTestId('tasks-section-approve')).toHaveCount(0);
  await expect(board.getByTestId('tasks-section-ready').getByTestId('task-row')).toHaveText([/Legal check/, /Deploy/, /Write docs/]);
});

test('Tasks screen: the board over the whole width; a card shows its task beside it', async ({ page }) => {
  await connect(page, world);
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.press('ControlOrMeta+K');
  const center = page.getByRole('dialog', { name: 'Command center' });
  await center.getByRole('combobox').fill('full screen');
  await center.getByTestId('command-center-action-alp-open-tasks-screen').click();
  const screen = page.getByRole('region', { name: 'ALP tasks' });
  const board = screen.getByTestId('task-board');
  await expect(board).toBeVisible();
  // Nothing picked: the board takes the screen (no empty detail beside it).
  const full = (await screen.boundingBox()).width;
  expect((await board.boundingBox()).width).toBeGreaterThan(full - 40);
  await view(board, 'Board').click();
  await expect(board.getByTestId(/^tasks-column-/)).toHaveCount(3);
  await board.getByRole('searchbox', { name: 'Filter tasks' }).fill('deploy');
  await expect(board.getByTestId('task-card')).toHaveText([/Deploy/]);
  // Escape in the search with text keeps the screen.
  await page.keyboard.press('Escape');
  await expect(screen).toBeVisible();
  await board.getByTestId('task-card').click();
  await expect(screen.getByTestId('task-detail').getByRole('heading', { name: 'Deploy' })).toBeVisible();
  await expect(board.getByTestId('task-card')).toHaveAttribute('aria-current', 'true');
  expect((await board.boundingBox()).width).toBeLessThan(full / 2);
  await expect(page.getByRole('tab', { name: 'Deploy' })).toHaveCount(0);
  // The detail's parent link opens the epic beside the board.
  await screen.getByTestId('task-detail').getByRole('button', { name: ids.epic }).click();
  await expect(screen.getByTestId('task-detail').getByRole('heading', { name: 'Ship v2' })).toBeVisible();
  await screen.getByRole('button', { name: 'Close tasks' }).click();
  await expect(screen).toBeHidden();
});

test('a human gate with options: Reject keeps it open once, then an option approves it and records the choice (t-ccac)', async ({ page }) => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const id = await add('Pick a region', '-p', '1');
  await world.alp('task', 'gate', 'add', id, '--human', 'Where to deploy?', '--option', 'EU', '--option', 'US');
  const gate = async () => JSON.parse(await readFile(path.join(world.projects.main, '.alp/tasks', `${id}.json`), 'utf8')).gates[0];
  await connect(page, world);
  await openTasks(page);
  const board = page.getByTestId('task-board');
  const approve = board.getByTestId('tasks-section-approve');
  await expect(approve.getByRole('button', { name: `Approve ${id}: EU` })).toBeVisible();
  await approve.getByRole('button', { name: `Reject ${id}` }).click();
  await expect.poll(async () => (await gate()).rejected?.channel).toBe('web');
  expect((await gate()).resolved).toBeUndefined();
  // Still open, and once rejected it offers no second Reject.
  await expect(approve.getByRole('button', { name: `Reject ${id}` })).toHaveCount(0);
  await approve.getByRole('button', { name: `Approve ${id}: US` }).click();
  await expect.poll(async () => (await gate()).resolved?.choice).toBe('US');
  expect((await gate()).resolved.channel).toBe('web');
  await expect(approve.getByRole('button', { name: `Approve ${id}: US` })).toHaveCount(0);
});
