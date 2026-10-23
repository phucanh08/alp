// Conversation fork and rewind (docs/protocol/alp-json-rpc-v1.md §12.7) through the real gateway and
// a real alpd with the fake Codex: the fake answers "[codewords]" with the codewords of ITS thread's
// kept history, so what a fork or rewind cut away is shown to be invisible to the next reply. Files
// are never copied, restored or changed: a workspace file stays byte-identical throughout.
import { expect, test } from '@playwright/test';
import { readFile, readdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { connect as hostConnect } from '@anhlp/alp-client';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, newSession, send, users } from './support/app.js';

let world;
test.beforeAll(async () => { world = await startWorld({ worktrees: true }); });
test.afterAll(async () => { await world?.close(); });

const header = page => page.getByTestId('workspace-header-title');

/** Sends a message and waits for the reply count to grow by one and the turn to end; the reply's text. */
async function ask(page, text) {
  const before = await assistant(page).count();
  await send(page, text);
  await expect(assistant(page)).toHaveCount(before + 1);
  await idle(page);
  return (await assistant(page).last().textContent())?.trim();
}

/** The host's row of the root titled `title` (the owner's local connection). */
async function hostSession(title) {
  const owner = await hostConnect(world.socket);
  try {
    const { sessions } = await owner.request('session.list', { rootsOnly: true, includeClosed: true });
    return sessions.filter(session => session.title === title);
  } finally {
    owner.close();
  }
}

test('fork through a turn, rewind before one, reload, restore the branch, fork into a worktree; files never change', async ({ page }, info) => {
  test.setTimeout(240_000);
  const token = world.tokens.worktreeWriter;
  await connect(page, world, token);
  // The registry row of the project, which Create worktree (and a fork into a worktree) needs.
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByLabel('Existing granted directory').selectOption(world.projects.main);
  await page.getByRole('button', { name: 'Register project', exact: true }).click();
  await expect(page.getByTestId('shared-workspace-row').filter({ hasText: 'shop' })).toHaveCount(1);

  // A workspace file made before any conversation: it must stay byte-identical.
  const fixture = path.join(world.projects.main, 'conversation-fixture.txt');
  await writeFile(fixture, 'files are not part of a conversation\n');
  const fixtureBytes = await readFile(fixture);
  const topLevel = async () => (await readdir(world.projects.main)).filter(name => name !== '.alp').sort();
  const namesBefore = await topLevel();

  await newSession(page, 'Codes');
  expect(await ask(page, 'codeword ALPHA')).toBe('Echo: codeword ALPHA');
  expect(await ask(page, 'codeword BRAVO')).toBe('Echo: codeword BRAVO');
  const [source] = await hostSession('Codes');
  expect(source?.conversation).toEqual({ fork: true, rewind: true, reload: true, configure: true });

  await test.step('fork through the first turn opens a new session that does not see BRAVO', async () => {
    // The first turn's footer: Fork from here…
    await page.getByTestId('fork-action').first().click();
    const dialog = page.getByTestId('fork-dialog');
    await expect(dialog).toContainText('Files are not copied');
    await expect(dialog.getByRole('radio', { name: 'In a new tab' })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: 'In a new worktree' })).toBeVisible();
    await page.getByTestId('fork-confirm').click();
    await expect(dialog).toBeHidden();
    await expect(header(page)).toHaveText('Codes (fork)');
    await expect(page.getByTestId('fork-marker')).toContainText('Forked from a turn of');
    await expect(page.getByTestId('fork-marker')).toContainText('Files were not copied');
    await expect(users(page)).toHaveText(['codeword ALPHA']);
    expect(await ask(page, '[codewords]')).toBe('Codewords: ALPHA');
    const [fork] = await hostSession('Codes (fork)');
    expect(fork.forkedFrom).toMatchObject({ sessionId: source.id, boundary: 'through' });
    expect(fork.projectRoot).toBe(source.projectRoot);
  });

  await test.step('the source still holds both turns', async () => {
    await page.getByTestId('fork-source').click();
    await expect(header(page)).toHaveText('Codes');
    // The source's timeline is read again when it opens: wait for it before counting replies.
    await expect(users(page)).toHaveText(['codeword ALPHA', 'codeword BRAVO']);
    await expect(assistant(page)).toHaveCount(2);
    expect(await ask(page, '[codewords]')).toBe('Codewords: ALPHA BRAVO');
  });

  await test.step('rewind to before BRAVO: same session, the later turns gone, the message back in the composer', async () => {
    const bravo = page.locator('[data-entry-key]').filter({ has: users(page).filter({ hasText: /^codeword BRAVO$/ }) });
    await bravo.hover();
    // The first message offers no rewind (nothing comes before it).
    await expect(page.locator('[data-entry-key]').filter({ has: users(page).filter({ hasText: /^codeword ALPHA$/ }) }).getByTestId('rewind-action')).toHaveCount(0);
    await bravo.getByTestId('rewind-action').click();
    const dialog = page.getByTestId('rewind-dialog');
    await expect(dialog).toContainText('before this message');
    await expect(dialog).toContainText('under the same session');
    await expect(dialog).toContainText('This message and what came after it (2 turns) move to a branch');
    await expect(page.getByTestId('rewind-files-note')).toContainText('Files in the workspace are not changed or restored');
    await page.screenshot({ path: info.outputPath('rewind-dialog.png') });
    await page.getByTestId('rewind-confirm').click();
    await expect(dialog).toBeHidden();
    await expect(header(page)).toHaveText('Codes');
    await expect(users(page)).toHaveText(['codeword ALPHA']);
    await expect(page.getByTestId('rewind-marker')).toContainText('Conversation rewound here — 2 later turns kept in a branch. Files were not changed.');
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('codeword BRAVO');
    await page.screenshot({ path: info.outputPath('rewound-timeline.png') });
    const after = await hostSession('Codes');
    expect(after.map(session => session.id)).toEqual([source.id]);
    expect(after[0].branches).toHaveLength(1);
    expect(after[0].branches[0]).toMatchObject({ turns: 2 });
    expect(await ask(page, '[codewords]')).toBe('Codewords: ALPHA');
  });

  await test.step('a reload shows the rewound conversation', async () => {
    await page.reload();
    await connect(page, world, token);
    await page.getByTestId('session-row').filter({ has: page.getByText('Codes', { exact: true }) }).click();
    await expect(header(page)).toHaveText('Codes');
    await expect(page.getByTestId('rewind-marker')).toBeVisible();
    await expect(users(page)).toHaveText(['codeword ALPHA', '[codewords]']);
    await expect(assistant(page)).toHaveText(['Echo: codeword ALPHA', 'Codewords: ALPHA']);
  });

  await test.step('Restore as new session: the restored branch sees ALPHA and BRAVO', async () => {
    await page.getByTestId('restore-branch').click();
    await expect(header(page)).toHaveText('Codes (restored)');
    await expect(users(page)).toHaveText(['codeword ALPHA', 'codeword BRAVO', '[codewords]']);
    await expect(assistant(page)).toHaveCount(3);
    expect(await ask(page, '[codewords]')).toBe('Codewords: ALPHA BRAVO');
    const [restored] = await hostSession('Codes (restored)');
    expect(restored.forkedFrom).toMatchObject({ sessionId: source.id, branchId: expect.any(String) });
  });

  await test.step('fork into a new worktree: the fork runs there, on the checkout\'s own files', async () => {
    await page.getByTestId('session-row').filter({ has: page.getByText('Codes', { exact: true }) }).click();
    await expect(header(page)).toHaveText('Codes');
    await expect(users(page)).toHaveText(['codeword ALPHA', '[codewords]']);
    await page.getByTestId('fork-action').first().click();
    const dialog = page.getByTestId('fork-dialog');
    await dialog.getByRole('radio', { name: 'In a new worktree' }).check();
    await expect(dialog.getByLabel('Worktree destination')).toHaveValue('browser');
    await page.getByTestId('fork-confirm').click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    // In another workspace the host names the fork without the source's title.
    await expect(header(page)).toHaveText('Fork of a session');
    await expect(users(page)).toHaveText(['codeword ALPHA']);
    await expect(assistant(page)).toHaveCount(1);
    expect(await ask(page, '[codewords]')).toBe('Codewords: ALPHA');
    const forks = await hostSession('Fork of a session');
    const moved = forks.find(fork => fork.projectRoot !== source.projectRoot);
    expect(moved, 'a fork in another directory').toBeTruthy();
    expect(moved.forkedFrom).toMatchObject({ sessionId: source.id, boundary: 'through' });
    // A clean checkout of the commit: the untracked fixture was not copied into it.
    await expect(access(path.join(moved.projectRoot, 'conversation-fixture.txt'))).rejects.toThrow();
  });

  // Nothing above touched the workspace's files.
  expect(Buffer.compare(await readFile(fixture), fixtureBytes)).toBe(0);
  expect(await topLevel()).toEqual(namesBefore);
});
