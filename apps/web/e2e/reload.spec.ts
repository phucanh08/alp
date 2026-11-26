// Copy resume command and Reload agent from the tab menu (docs/protocol/alp-json-rpc-v1.md §12.8, issue
// #121 G2) through the real gateway and a real alpd with the fake Codex: the copied command is the
// host's `alp attach <id>` (clipboard only, never run); a reload restarts the agent's native process on
// the same thread, keeping the session id and history, and the next reply still sees the earlier turns
// (the fake answers "[codewords]" from its thread's kept history, across processes).
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { connect as hostConnect } from '@anhlp/alp-client';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, newSession, send } from './support/app.js';

let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const tabMenu = page => page.getByRole('menu');

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

test('Copy resume command copies the host\'s ALP command; Reload agent restarts the agent on the same conversation', async ({ page, context }) => {
  test.setTimeout(150_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await connect(page, world);
  await newSession(page, 'Reload me');
  expect(await ask(page, 'codeword DELTA')).toBe('Echo: codeword DELTA');
  const { sessions } = await host('session.list', { rootsOnly: true });
  const session = sessions.find(row => row.title === 'Reload me');
  expect(session.conversation).toEqual({ fork: true, rewind: true, reload: true, configure: true });
  const historyBefore = await host('session.history', { sessionId: session.id, limit: 200 });

  // Paseo's menu order: Copy resume command first, Reload agent just above Close.
  await page.getByRole('tab', { name: 'Reload me' }).click({ button: 'right' });
  await expect(tabMenu(page).getByRole('menuitem')).toHaveText(['Copy resume command', /^Copy agent id\s*\w{7}$/, 'Rename', 'Close to the left', 'Close to the right', 'Close other tabs', 'Reload agent', 'Compact context', 'Close']);
  await expect(tabMenu(page).getByRole('menuitem', { name: 'Reload agent' })).toHaveAttribute('title', /same conversation/);
  await tabMenu(page).getByRole('menuitem', { name: 'Copy resume command' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Copied the resume command' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`alp attach ${session.id}`);

  // Reload: a new native process resumes the same thread.
  const spawnsBefore = (await journal()).filter(entry => entry.method === 'spawn').length;
  await page.getByRole('tab', { name: 'Reload me' }).click({ button: 'right' });
  await tabMenu(page).getByRole('menuitem', { name: 'Reload agent' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reloaded the agent' })).toBeVisible();
  const entries = await journal();
  expect(entries.filter(entry => entry.method === 'spawn').length).toBe(spawnsBefore + 1);
  const resumed = entries.filter(entry => entry.method === 'thread/resume' && entry.threadId === session.threadId);
  expect(resumed.length).toBeGreaterThan(0);
  const newPid = resumed.at(-1).pid;
  expect(entries.filter(entry => entry.pid === newPid && entry.method === 'thread/start')).toHaveLength(0);

  // Same id, thread and history; the next reply, in the new process, still sees the earlier turn.
  const { session: after } = await host('session.get', { sessionId: session.id });
  expect([after.id, after.threadId, after.model, after.mode]).toEqual([session.id, session.threadId, session.model, session.mode]);
  const historyAfter = await host('session.history', { sessionId: session.id, limit: 200 });
  expect(historyAfter.generation).toBe(historyBefore.generation);
  expect(historyAfter.items.slice(0, historyBefore.items.length)).toEqual(historyBefore.items);
  expect(await ask(page, '[codewords]')).toBe('Codewords: DELTA');
  const turn = (await journal()).filter(entry => entry.method === 'turn/start').at(-1);
  expect([turn.pid, turn.threadId]).toEqual([newPid, session.threadId]);
  await expect(page.getByRole('heading', { level: 1, name: 'Reload me' })).toBeVisible();
});

test('a token that may only view, or only drive read-only sessions, is offered no reload', async ({ browser }) => {
  test.setTimeout(90_000);
  const owner = await browser.newPage();
  await connect(owner, world);
  await newSession(owner, 'Look only');
  expect(await ask(owner, 'codeword ECHO')).toBe('Echo: codeword ECHO');
  const spawnsBefore = (await journal()).filter(entry => entry.method === 'spawn').length;
  for (const token of [world.tokens.viewer, world.tokens.readOnlyMode]) {
    const context = await browser.newContext();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const page = await context.newPage();
      await connect(page, world, token);
      await page.getByTestId('session-row').filter({ hasText: 'Look only' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Look only' })).toBeVisible();
      await expect(page.getByTestId('assistant-message').last()).toContainText('Echo: codeword ECHO');
      await page.getByRole('tab', { name: 'Look only' }).click({ button: 'right' });
      await expect(tabMenu(page).getByRole('menuitem', { name: 'Reload agent' })).toBeDisabled();
      // Copying needs session.read only.
      await tabMenu(page).getByRole('menuitem', { name: 'Copy resume command' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Copied the resume command' })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^alp attach [\w.:-]+$/);
    } finally { await context.close(); }
  }
  expect((await journal()).filter(entry => entry.method === 'spawn').length).toBe(spawnsBefore);
  await owner.close();
});
