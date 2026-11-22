// t-a35b (Paseo parity batch 4), through the real UI, gateway and alpd (fake Codex): the Changes
// and Diff panels' side-by-side layout (remembered across a reload) and review comments on diff
// lines, sent together as one message to the open session's agent. A token that cannot send
// messages sees no comment control; without a session the review cannot be sent.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, newSession, users } from './support/app.js';

const run = promisify(execFile);
const gitEnv = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...args) => run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd, env: gitEnv });

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => {
  world = await startWorld();
  const root = world.projects.main;
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'cart.ts'), 'export const total = 0;\nexport const tax = 0.1;\n');
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'initial');
  await writeFile(path.join(root, 'src', 'cart.ts'), 'export const total = 0;\nexport const tax = 0.2;\nexport const sum = total + tax;\n');
  const { connect: hostConnect } = await import('@anhlp/alp-client');
  const owner = await hostConnect(world.socket);
  try {
    const { revision } = await owner.request('project.list', {});
    await owner.request('project.register', { directory: root, ifRevision: revision, requestId: 'diff-review-e2e' });
  } finally { owner.close(); }
});
test.afterAll(async () => { await world?.close(); });

const dock = page => page.getByRole('complementary', { name: 'Explorer' });
const file = (scope, name) => scope.locator(`[data-testid="git-file"][data-path="${name}"]`);

async function openCart(page) {
  await dock(page).getByRole('tab', { name: 'Changes' }).click();
  const panel = dock(page).getByTestId('changes-panel');
  await expect(panel).toHaveAttribute('data-content', 'diff');
  await file(panel, 'src/cart.ts').getByTestId('git-file-toggle').click();
  await expect(file(panel, 'src/cart.ts').getByTestId('git-hunks')).toBeVisible();
  return panel;
}

test('side by side: removed and added lines pair across two columns, and the choice survives a reload', async ({ page }) => {
  await connect(page, world, world.tokens.filesReader);
  let panel = await openCart(page);
  const hunks = () => file(panel, 'src/cart.ts').getByTestId('git-hunks');
  await expect(hunks()).toHaveAttribute('data-layout', 'unified');
  await expect(panel.getByTestId('git-layout')).toHaveAttribute('aria-pressed', 'false');
  await panel.getByTestId('git-layout').click();
  await expect(panel.getByTestId('git-layout')).toHaveAttribute('aria-pressed', 'true');
  await expect(hunks()).toHaveAttribute('data-layout', 'split');
  const rows = hunks().getByTestId('git-split-row');
  // keep | keep, then tax 0.1 | tax 0.2, then (empty) | sum.
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator('div[data-side="old"]')).toContainText('export const total = 0;');
  await expect(rows.nth(0).locator('div[data-side="new"]')).toContainText('export const total = 0;');
  await expect(rows.nth(1).locator('div[data-side="old"]')).toHaveAttribute('data-diff', 'remove');
  await expect(rows.nth(1).locator('div[data-side="old"]')).toContainText('export const tax = 0.1;');
  await expect(rows.nth(1).locator('div[data-side="new"]')).toHaveAttribute('data-diff', 'add');
  await expect(rows.nth(1).locator('div[data-side="new"]')).toContainText('export const tax = 0.2;');
  await expect(rows.nth(2).locator('div[data-side="old"]')).toHaveAttribute('data-diff', 'empty');
  await expect(rows.nth(2).locator('div[data-side="new"]')).toContainText('export const sum = total + tax;');
  await page.screenshot({ path: test.info().outputPath('diff-side-by-side.png') });

  // A new load of the app in this browser (the token is not kept, so it connects again).
  await connect(page, world, world.tokens.filesReader);
  panel = await openCart(page);
  await expect(hunks()).toHaveAttribute('data-layout', 'split');
  await panel.getByTestId('git-layout').click();
  await expect(hunks()).toHaveAttribute('data-layout', 'unified');
});

test('review comments: written on lines in either layout, sent as one message to the session, then cleared', async ({ page }) => {
  await connect(page, world, world.tokens.filesReader);
  const panel = await openCart(page);
  const cart = file(panel, 'src/cart.ts');

  // No session open yet: comments can be written, not sent.
  const added = cart.locator('[data-testid="git-line-comment"][data-side="new"][data-line="3"]');
  await cart.locator('[data-diff="add"]').last().hover();
  await added.click();
  await cart.getByTestId('git-comment-input').fill('Name this subtotal');
  await cart.getByTestId('git-comment-add').click();
  await expect(cart.getByTestId('git-comment')).toHaveCount(1);
  await expect(panel.getByTestId('git-review-count')).toContainText('1 review comment');
  await expect(panel.getByTestId('git-review-blocked')).toHaveText('Open a session to send the review to its agent.');
  await expect(panel.getByTestId('git-review-send')).toBeDisabled();

  await newSession(page, 'Review target');
  // The comment is still there; one more on the removed line, written in the split layout.
  await expect(panel.getByTestId('git-review-count')).toContainText('1 review comment');
  await panel.getByTestId('git-layout').click();
  await expect(cart.getByTestId('git-hunks')).toHaveAttribute('data-layout', 'split');
  await expect(cart.getByTestId('git-comment')).toHaveCount(1);
  await cart.locator('[data-testid="git-line-comment"][data-side="old"][data-line="2"]').click();
  await cart.getByTestId('git-comment-input').fill('Why 0.2?');
  await cart.getByTestId('git-comment-input').press('ControlOrMeta+Enter');
  await expect(cart.getByTestId('git-comment')).toHaveCount(2);
  // Escape drops a comment being written; Delete removes a saved one.
  await cart.locator('[data-testid="git-line-comment"][data-side="new"][data-line="1"]').click();
  await cart.getByTestId('git-comment-input').fill('dropped');
  await cart.getByTestId('git-comment-input').press('Escape');
  await expect(cart.getByTestId('git-comment-editor')).toHaveCount(0);
  await expect(panel.getByTestId('git-review-count')).toContainText('2 review comments');
  await page.screenshot({ path: test.info().outputPath('diff-review-comments.png') });

  await expect(panel.getByTestId('git-review-send')).toBeEnabled();
  await panel.getByTestId('git-review-send').click();
  await expect(panel.getByTestId('git-review-bar')).toHaveCount(0);
  await expect(cart.getByTestId('git-comment')).toHaveCount(0);
  const sent = users(page).last();
  await expect(sent).toContainText('Review comments on the diff (Uncommitted)');
  await expect(sent).toContainText('src/cart.ts');
  await expect(sent).toContainText('Line 2 (removed line, old numbering):');
  await expect(sent).toContainText('Why 0.2?');
  await expect(sent).toContainText('Line 3:');
  await expect(sent).toContainText('Name this subtotal');
  // The fake agent echoes the message's last line: it got the whole review.
  await expect(assistant(page).last()).toContainText('Name this subtotal');
  await idle(page);
  await panel.getByTestId('git-layout').click();
});

test('a token that cannot send messages sees no comment control', async ({ page }) => {
  await connect(page, world, world.tokens.filesViewer);
  const panel = await openCart(page);
  await expect(file(panel, 'src/cart.ts').locator('[data-diff="add"]').first()).toBeVisible();
  await expect(panel.getByTestId('git-line-comment')).toHaveCount(0);
  await expect(panel.getByTestId('git-review-bar')).toHaveCount(0);
});
