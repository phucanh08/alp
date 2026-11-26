// Changing a live session's model, thinking and team from its agent controls (docs/protocol/
// alp-json-rpc-v1.md §12.9, issue #121 D) through the real gateway and a real alpd with the fake Codex:
// the labels show what the host runs (never a choice before it took it); the agent restarts on the
// same thread and the next turn names the new model and effort; a team change needs
// session.team.write; a refusal while a turn runs says why and changes nothing; close/reopen and a
// page reload keep the configuration.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { connect as hostConnect } from '@anhlp/alp-client';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, newSession, send } from './support/app.js';

let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

async function ask(page, text) {
  const before = await assistant(page).count();
  await send(page, text);
  await expect(assistant(page)).toHaveCount(before + 1);
  await idle(page);
  return (await assistant(page).last().textContent())?.trim();
}

async function host(method, params) {
  const owner = await hostConnect(world.socket);
  try { return await owner.request(method, params); } finally { owner.close(); }
}

const journal = async () => (await readFile(world.journal, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const sessionNamed = async title => (await host('session.list', { rootsOnly: true })).sessions.find(row => row.title === title);
const status = page => page.getByRole('status').filter({ hasText: /^Changed:/ });
/** Checks the notice says `text`, then dismisses it before the next configuration assertion. */
async function noticed(locator, text) {
  await expect(locator).toContainText(text);
  await locator.getByRole('button', { name: 'Dismiss' }).click();
  await expect(locator).toBeHidden();
}
const alert = (page, text) => page.getByRole('alert').filter({ hasText: text });

/** Chooses `item` in the agent control menu `testId` (session-team, session-model, session-thinking). */
async function choose(page, testId, item) {
  await page.getByTestId(testId).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: item, exact: true }).click();
}

test('the model, thinking and team change on the live session; the next turn runs with them on the same thread', async ({ page }) => {
  test.setTimeout(180_000);
  await connect(page, world, world.tokens.teamWriter);
  await newSession(page, 'Configure me');
  expect(await ask(page, 'codeword ALPHA')).toBe('Echo: codeword ALPHA');
  const session = await sessionNamed('Configure me');
  expect(session.conversation).toEqual({ fork: true, rewind: true, reload: true, configure: true });
  expect([session.model, session.workflow.mode]).toEqual(['gpt-5.6-sol', 'pho']);
  // The labels are the host's (library.models' labels): model codex · GPT-5.6-Sol, its usual effort, team Phở.
  await expect(page.getByTestId('model-label')).toHaveText('codex · GPT-5.6-Sol');
  await expect(page.getByTestId('session-thinking-label')).toHaveText(session.thinking === 'xhigh' ? 'Extra high' : session.thinking.charAt(0).toUpperCase() + session.thinking.slice(1));
  await expect(page.getByTestId('team-label')).toHaveText('Phở');
  // Other runtimes' models are never offered: a session keeps its runtime.
  await page.getByTestId('session-model').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitemradio', { name: 'codex · GPT-5.6-Terra', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /Opus|Sonnet|Gemini/ })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Other runtimes: start a new session' })).toBeDisabled();
  await page.keyboard.press('Escape');

  // Model: the agent restarts on the same thread with it.
  const spawnsBefore = (await journal()).filter(entry => entry.method === 'spawn').length;
  await choose(page, 'session-model', 'codex · GPT-5.6-Terra');
  await noticed(status(page), 'main runs codex · GPT-5.6-Terra');
  await expect(page.getByTestId('model-label')).toHaveText('codex · GPT-5.6-Terra');
  let entries = await journal();
  expect(entries.filter(entry => entry.method === 'spawn').length).toBe(spawnsBefore + 1);
  const resumed = entries.filter(entry => entry.method === 'thread/resume' && entry.threadId === session.threadId).at(-1);
  expect(resumed.model).toBe('gpt-5.6-terra');

  // Thinking: another effort than the one it runs.
  const [effort, effortText] = session.thinking === 'medium' ? ['high', 'High'] : ['medium', 'Medium'];
  await choose(page, 'session-thinking', effortText);
  await noticed(status(page), `codex · GPT-5.6-Terra · ${effortText}`);
  await expect(page.getByTestId('session-thinking-label')).toHaveText(effortText);
  let { session: after } = await host('session.get', { sessionId: session.id });
  expect([after.id, after.threadId, after.model, after.thinking, after.workflow.mode]).toEqual([session.id, session.threadId, 'gpt-5.6-terra', effort, 'pho']);

  // The next turn names the new model and effort, on the same thread, and still sees the earlier turn.
  expect(await ask(page, '[codewords]')).toBe('Codewords: ALPHA');
  const turn = (await journal()).filter(entry => entry.method === 'turn/start').at(-1);
  expect([turn.threadId, turn.model, turn.effort]).toEqual([session.threadId, 'gpt-5.6-terra', effort]);

  // Team: Cafe (this credential has session.team.write).
  await choose(page, 'session-team', 'Cafe');
  await noticed(status(page), 'Cafe · main runs');
  await expect(page.getByTestId('team-label')).toHaveText('Cafe');
  ({ session: after } = await host('session.get', { sessionId: session.id }));
  expect([after.id, after.threadId, after.workflow.mode, after.teamLabel, after.model]).toEqual([session.id, session.threadId, 'cafe', 'Cafe', 'gpt-5.6-terra']);
  await expect(page.getByTestId('model-label')).toHaveText('codex · GPT-5.6-Terra');

  // Closed on the host, then reopened by a message: the labels and the next turn keep the configuration.
  await host('session.close', { sessionId: session.id });
  await expect(page.getByText('This session is closed on the host.')).toBeVisible();
  await expect(page.getByTestId('team-label')).toHaveText('Cafe');
  await expect(page.getByTestId('model-label')).toHaveText('codex · GPT-5.6-Terra');
  // A closed session is not changed: the menus say why.
  await expect(page.getByTestId('session-model')).toBeDisabled();
  expect(await ask(page, 'codeword BRAVO')).toBe('Echo: codeword BRAVO');
  entries = await journal();
  const reopened = entries.filter(entry => entry.method === 'turn/start').at(-1);
  expect([reopened.threadId, reopened.model, reopened.effort]).toEqual([session.threadId, 'gpt-5.6-terra', effort]);
  ({ session: after } = await host('session.get', { sessionId: session.id }));
  expect([after.model, after.thinking, after.workflow.mode]).toEqual(['gpt-5.6-terra', effort, 'cafe']);

  // A new page load (the token is kept in memory only: connect again) reads them from the host again.
  await connect(page, world, world.tokens.teamWriter);
  await page.getByTestId('session-row').filter({ hasText: 'Configure me' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Configure me' })).toBeVisible();
  await expect(page.getByTestId('team-label')).toHaveText('Cafe');
  await expect(page.getByTestId('model-label')).toHaveText('codex · GPT-5.6-Terra');
  await expect(page.getByTestId('session-thinking-label')).toHaveText(effortText);
});

test('a change the host refuses because a turn runs says why and changes nothing; the controls wait while working', async ({ page }) => {
  test.setTimeout(150_000);
  // Event frames can be held, so the page still thinks the session is idle when the host is not.
  let holding = false;
  const held = [];
  let release = () => {};
  await page.routeWebSocket('**/*', socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => server.send(message));
    server.onMessage(message => {
      let packet;
      try { packet = JSON.parse(String(message)); } catch { packet = undefined; }
      if (holding && packet?.method === 'event') held.push(message); else socket.send(message);
    });
    release = () => { holding = false; for (const message of held.splice(0)) socket.send(message); };
  });
  await connect(page, world, world.tokens.teamWriter);
  await newSession(page, 'Busy one');
  expect(await ask(page, 'codeword CHARLIE')).toBe('Echo: codeword CHARLIE');
  const session = await sessionNamed('Busy one');
  await expect(page.getByTestId('model-label')).toHaveText('codex · GPT-5.6-Sol');
  const spawnsBefore = (await journal()).filter(entry => entry.method === 'spawn').length;

  // Another client starts a turn the page does not hear about yet.
  holding = true;
  await host('session.prompt', { sessionId: session.id, clientMessageId: 'other-client-hold', delivery: 'auto', content: [{ type: 'text', text: '[hold]' }] });
  await choose(page, 'session-model', 'codex · GPT-5.6-Terra');
  await noticed(alert(page, 'The session or one of its agents is working'), 'Wait until everything is idle');
  await expect(page.getByTestId('model-label')).toHaveText('codex · GPT-5.6-Sol');
  release();

  // Now the page sees the turn: the menus are disabled, their tooltip says why.
  await expect(page.getByTestId('session-model')).toBeDisabled();
  await expect(page.getByTestId('session-model').locator('..')).toHaveAttribute('title', /Wait until main and its agents are idle/);
  await expect(page.getByTestId('session-team')).toBeDisabled();
  await host('session.interrupt', { sessionId: session.id });
  await idle(page);
  await expect(page.getByTestId('session-model')).toBeEnabled();

  // Nothing changed: no restart, the same model on the host and in the labels.
  expect((await journal()).filter(entry => entry.method === 'spawn').length).toBe(spawnsBefore);
  const { session: after } = await host('session.get', { sessionId: session.id });
  expect([after.model, after.thinking, after.workflow.mode]).toEqual([session.model, session.thinking, session.workflow.mode]);
  await expect(page.getByTestId('model-label')).toHaveText('codex · GPT-5.6-Sol');
});

test('without session.team.write the team cannot be changed; the model still can', async ({ page }) => {
  test.setTimeout(120_000);
  await connect(page, world);
  await newSession(page, 'No team writes');
  expect(await ask(page, 'codeword DELTA')).toBe('Echo: codeword DELTA');
  await expect(page.getByTestId('session-team')).toBeDisabled();
  await expect(page.getByTestId('session-team').locator('..')).toHaveAttribute('title', /session\.team\.write/);
  await expect(page.getByTestId('session-model')).toBeEnabled();
  await choose(page, 'session-model', 'codex · GPT-5.6-Luna');
  await noticed(status(page), 'main runs codex · GPT-5.6-Luna');
  await expect(page.getByTestId('model-label')).toHaveText('codex · GPT-5.6-Luna');
  const session = await sessionNamed('No team writes');
  expect([session.model, session.workflow.mode]).toEqual(['gpt-5.6-luna', 'pho']);
});
