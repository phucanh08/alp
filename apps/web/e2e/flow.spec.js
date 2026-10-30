// The main flow through the real UI, a real gateway and a real alpd (fake Codex): connect, create a
// session, stream a reply with a tool call, answer and decline questions, stop a running turn,
// tasks with a human gate, rename; the token never lands in storage, the URL or the gateway log.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { assistant, connect, fullChat, idle, newSession, openDockPanel, openTasks, send, users } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

test('create, stream, tool call, questions, stop, rename', async ({ page }) => {
  await fullChat(page);
  await connect(page, world);
  const project = page.getByTestId('project-row');
  await expect(project).toHaveAttribute('data-workspace', world.projects.main);
  await expect(project).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('This workspace has no sessions yet.')).toBeVisible();

  await newSession(page, 'Release prep');
  await send(page, 'What is in src? [tool]');
  const tool = page.getByTestId('tool-call');
  await expect(tool).toContainText('ls -1 src');
  await expect(tool).toContainText('exit 0');
  await expect(assistant(page).last()).toContainText('The src folder has three files');
  await tool.getByRole('button').click();
  await expect(tool).toContainText('util.ts');
  await idle(page);

  // A question, as Paseo's question card: pick an option, then Submit.
  await send(page, 'Ship it? [ask]');
  const question = page.getByTestId('question');
  await expect(question).toContainText('Deploy to staging now?');
  await expect(page.getByTestId('working')).toBeVisible();
  await question.getByRole('radio', { name: 'yes' }).click();
  await expect(question.getByRole('radio', { name: 'yes' })).toHaveAttribute('aria-checked', 'true');
  await question.getByRole('button', { name: 'Submit' }).click();
  await expect(question).toBeHidden();
  await expect(assistant(page).last()).toContainText('you said "yes"');
  await idle(page);

  // Dismissed.
  await send(page, 'Again? [ask]');
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Dismiss' }).click();
  await expect(question).toBeHidden();
  await expect(assistant(page).last()).toContainText('you declined');
  await idle(page);

  // A message while a turn runs steers it.
  await send(page, 'Long job [hold]');
  await expect(page.getByRole('button', { name: 'Interrupt agent' })).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Also check the tests [finish]');
  await expect(page.getByRole('button', { name: 'Send and steer' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(assistant(page).last()).toContainText('Steered: Also check the tests');
  await idle(page);

  // Stop a turn that never ends by itself.
  await send(page, 'Another long job [hold]');
  await expect(page.getByRole('button', { name: 'Interrupt agent' })).toBeVisible();
  await page.getByRole('button', { name: 'Interrupt agent' }).click();
  await expect(page.getByText('Stopped.')).toBeVisible();
  await idle(page);

  // Cmd/Ctrl+Enter while the agent works queues; the queue sends itself once the agent is idle.
  await send(page, 'Third long job [hold]');
  await expect(page.getByTestId('working')).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Queued note');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('queued-message')).toContainText('Queued note');
  await page.getByRole('button', { name: 'Interrupt agent' }).click();
  await expect(page.getByTestId('queued-message')).toBeHidden();
  await expect(assistant(page).last()).toContainText('Echo: Queued note');
  await idle(page);

  // Each message reached the provider exactly once.
  const prompts = (await world.turnStarts()).map(entry => entry.text);
  for (const text of ['What is in src? [tool]', 'Ship it? [ask]', 'Again? [ask]', 'Long job [hold]', 'Another long job [hold]', 'Third long job [hold]', 'Queued note']) {
    expect(prompts.filter(prompt => prompt.includes(text)), text).toHaveLength(1);
  }
  await expect(users(page)).toHaveCount(8);

  // Rename from the row's menu in the list.
  await page.getByRole('button', { name: 'Actions for Release prep' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename session' });
  await rename.getByLabel('Title').fill('Release 1.0');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Release 1.0' })).toBeVisible();
  await expect(page.getByTestId('session-row')).toContainText('Release 1.0');

  // The dock opens on Paseo's Changes (this workspace is no Git repository, so it says so) and Files; + adds Agents, which lists main.
  const dock = page.getByRole('complementary', { name: 'Explorer' });
  await expect(dock.getByRole('tab')).toHaveText(['Changes', 'Files']);
  await expect(dock.getByTestId('changes-not-git')).toHaveAttribute('data-reason', 'not_repository');
  await openDockPanel(page, 'agents', 'Agents');
  await expect(page.getByTestId('agent-row').first()).toContainText('main');

  // The center + menu: Agent, Paseo's Terminal and Diff, then ALP's panels; Terminal opens a tab,
  // which this host (terminals not allowed) and token (no terminal.exec) refuse: no terminal at all.
  await page.getByRole('button', { name: 'New tab' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Agent', 'Terminal', 'Diff', 'Tasks', 'Agents']);
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('main').getByTestId('terminal-refused')).toContainText('The host has not allowed remote terminals (its owner runs: alp terminal allow --yes)');
  await expect(page.getByRole('main').getByTestId('terminal-refused')).toContainText('Your access token cannot open terminals (it needs terminal.exec)');
  await expect(page.getByTestId('terminal-screen')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Terminal' }).press('Delete');

  // The token is in no storage, URL or gateway log line.
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href, cookies: document.cookie }));
  expect(stored).not.toContain(world.tokens.owner);
  expect(stored).not.toContain(world.tokens.owner.split('.')[2]);
  expect(await world.gatewayLog()).not.toContain(world.tokens.owner.split('.')[2]);

  // Paseo's footer line: Add project, Usage, Hosts, Help, Settings; Usage opens Settings › Usage.
  const footer = page.getByTestId('sidebar-footer-bottom-line');
  expect(await footer.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['Add project', 'Usage', 'Hosts', 'Help and support', 'Settings']);
  await footer.getByTestId('sidebar-usage-icon').click();
  const settings = page.getByRole('region', { name: 'Settings' });
  await expect(settings.getByTestId('settings-detail-header-title')).toHaveText('Usage');
  await settings.getByRole('button', { name: 'Back', exact: true }).click();

  // Disconnect (the footer's Hosts menu, as Paseo's host picker) forgets it.
  await page.getByTestId('sidebar-hosts-trigger').click();
  await page.getByTestId('sidebar-disconnect').click();
  await expect(page.getByLabel('Access token')).toHaveValue('');
});

test('tasks: add, approve a human gate, close and reopen', async ({ page }) => {
  await connect(page, world);
  await openTasks(page);
  await page.getByPlaceholder('New task…').fill('Write release notes');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText(/Created task/)).toBeVisible();
  const row = page.getByTestId('task-row').filter({ hasText: 'Write release notes' });
  await expect(row).toBeVisible();
  const id = (await row.locator('.font-mono').innerText()).trim();

  // Picking it opens the task in a tab of its own.
  await row.click();
  const detail = page.getByTestId('task-detail');
  await expect(detail.getByRole('heading', { name: 'Write release notes' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Write release notes' })).toHaveAttribute('aria-selected', 'true');

  // The host owner puts a human gate on it; polling shows it in the list and the tab.
  await world.alp('task', 'gate', 'add', id, '--human', 'Legal sign-off');
  await expect(row).toContainText('needs approval', { timeout: 15_000 });
  await expect(detail).toContainText('Needs your approval: Legal sign-off');
  await detail.getByRole('button', { name: 'Approve' }).click();
  await expect(detail).not.toContainText('Needs your approval');

  await detail.getByRole('button', { name: 'Close task' }).click();
  await expect(row).toBeHidden();
  await expect(detail).toContainText('Closed');
  // The All filter (the board's Open / Ready / Closed / All) shows it again.
  await page.getByTestId('tasks-filter-all').click();
  await expect(row).toContainText('closed');
  await detail.getByRole('button', { name: 'Reopen' }).click();
  await expect(row).toContainText('open');
  await expect(detail.getByRole('button', { name: 'Close task' })).toBeVisible();
  const listed = JSON.parse(await world.alp('task', 'show', id, '--json'));
  expect(listed.status).toBe('open');
  expect(listed.gates.every(gate => gate.resolved)).toBe(true);
});

test('settings: the old app\'s layout, what the token allows, names from the library, what this beta cannot do', async ({ page }) => {
  await connect(page, world);
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  await expect(settings.getByTestId('settings-detail-header-title')).toHaveText('General');

  // Paseo 0.14's App pages on the web, in its order.
  for (const name of ['General', 'Appearance', 'Sidebar', 'Chat', 'Terminal', 'Editor', 'Files', 'Diagnostics', 'About']) await expect(settings.getByRole('button', { name, exact: true })).toBeVisible();

  // General: what Enter does while the agent works.
  await settings.getByLabel('Default send').selectOption('queue');
  await expect(settings.getByLabel('Default send')).toHaveValue('queue');
  await expect(settings).toContainText('Enter queues. Command/Ctrl+Enter submits.');
  await settings.getByLabel('Default send').selectOption('steer');
  await expect(settings.getByLabel('Default send')).toHaveValue('steer');

  await settings.getByTestId('settings-host').click();
  await expect(settings).toContainText('web-e2e');
  await expect(settings).toContainText('session.write');
  await expect(settings).toContainText('Vietnamese');

  await settings.getByTestId('settings-alp-agents').click();
  await expect(settings).toContainText('main');
  await expect(settings).toContainText('Editing agents is not available in this beta');

  await settings.getByTestId('settings-usage').click();
  await expect(settings).toContainText('Usage and limits is not available in this beta');

  await settings.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Workspaces and sessions' })).toBeVisible();
});
