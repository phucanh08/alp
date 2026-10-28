// Issue #121 G1, through the real UI, gateway and alpd (fake Codex): Paseo's Changes and Diff
// panels, read only. A registered Git workspace with a modified, an untracked, a binary and a
// renamed file (and a secret that never shows): with files.read the panel lists them with their
// counts and opens hunks; Diff shows one file Changes sent it; a token without files.read (project.read
// only) sees the status list but no content. Needs alpd's workspace.git (the daemon slice).
import { execFile } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect } from './support/app.js';

const run = promisify(execFile);
/** Git as world.js runs it for worktrees: no system or global configuration, no hooks. */
const gitEnv = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...args) => run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd, env: gitEnv });

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => {
  world = await startWorld();
  const root = world.projects.main;
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'src', 'cart.ts'), 'export const total = 0;\nexport const tax = 0.1;\n');
  await writeFile(path.join(root, 'docs', 'old-name.md'), '# Guide\n\nUnchanged content.\n');
  await writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'initial');
  // The working tree: modified, untracked, binary changed, renamed (staged), and a secret.
  await writeFile(path.join(root, 'src', 'cart.ts'), 'export const total = 0;\nexport const tax = 0.2;\nexport const sum = total + tax;\n');
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await writeFile(path.join(root, 'notes', 'todo.md'), 'ship the cart\n');
  await writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0e, 0x00]));
  await rename(path.join(root, 'docs', 'old-name.md'), path.join(root, 'docs', 'new-name.md'));
  await git(root, 'add', '-A', 'docs');
  await writeFile(path.join(root, '.env'), 'API_KEY=never-shown\n');
  // The host owner registers the workspace: Git is asked for by registry workspace id.
  const { connect: hostConnect } = await import('@anhlp/alp-client');
  const owner = await hostConnect(world.socket);
  try {
    const { revision } = await owner.request('project.list', {});
    await owner.request('project.register', { directory: root, ifRevision: revision, requestId: 'changes-e2e' });
  } finally { owner.close(); }
});
test.afterAll(async () => { await world?.close(); });

const dock = page => page.getByRole('complementary', { name: 'Explorer' });
const file = (scope, name) => scope.locator(`[data-testid="git-file"][data-path="${name}"]`);

async function openChanges(page) {
  await dock(page).getByRole('tab', { name: 'Changes' }).click();
  await expect(dock(page).getByTestId('changes-panel')).toBeVisible();
}

test('with files.read: the branch, the changed files with counts, hunks on demand, binary and renamed files labelled, the secret never shown', async ({ page }) => {
  await connect(page, world, world.tokens.filesReader);
  await openChanges(page);
  const panel = dock(page).getByTestId('changes-panel');
  await expect(panel).toHaveAttribute('data-content', 'diff');
  await expect(panel.getByTestId('git-branch-name')).toHaveText('main');
  await expect(panel.getByTestId('git-read-only')).toBeVisible();
  await expect(file(panel, 'src/cart.ts')).toHaveAttribute('data-change', 'modified');
  await expect(file(panel, 'src/cart.ts')).toContainText('+2');
  await expect(file(panel, 'src/cart.ts')).toContainText('-1');
  await expect(file(panel, 'notes/todo.md')).toHaveAttribute('data-change', 'untracked');
  await expect(file(panel, 'logo.png')).toHaveAttribute('data-kind', 'binary');
  await expect(file(panel, 'docs/new-name.md')).toHaveAttribute('data-change', 'renamed');
  await expect(file(panel, 'docs/new-name.md')).toContainText('docs/old-name.md');
  await expect(panel.locator('[data-testid="git-file"][data-path=".env"]')).toHaveCount(0);
  await expect(panel).not.toContainText('never-shown');
  await expect(panel.getByTestId('git-hidden')).toBeVisible();

  // Hunks open one file at a time, numbered, added and removed lines marked.
  await expect(panel.getByTestId('git-hunks')).toHaveCount(0);
  await file(panel, 'src/cart.ts').getByTestId('git-file-toggle').click();
  const hunks = file(panel, 'src/cart.ts').getByTestId('git-hunks');
  await expect(hunks.locator('[data-diff="hunk"]').first()).toContainText('@@ -1,2 +1,3 @@');
  await expect(hunks.locator('[data-diff="remove"]')).toContainText(['export const tax = 0.1;']);
  await expect(hunks.locator('[data-diff="add"]')).toContainText(['export const tax = 0.2;', 'export const sum = total + tax;']);
  await file(panel, 'docs/new-name.md').getByTestId('git-file-toggle').click();
  await expect(file(panel, 'docs/new-name.md').getByTestId('git-file-rename')).toHaveText('Renamed docs/old-name.md → docs/new-name.md');
  await expect(file(panel, 'docs/new-name.md')).not.toContainText('No changes to display');
  await file(panel, 'logo.png').getByTestId('git-file-toggle').click();
  await expect(file(panel, 'logo.png').getByTestId('git-file-kind')).toHaveText('Binary file');
  await file(panel, 'notes/todo.md').getByTestId('git-file-toggle').click();
  await expect(file(panel, 'notes/todo.md').locator('[data-diff="add"]')).toContainText(['ship the cart']);

  // Hide whitespace and Refresh ask again; a change on the host shows after Refresh.
  await panel.getByTestId('git-whitespace').click();
  await expect(panel.getByTestId('git-whitespace')).toHaveAttribute('aria-pressed', 'true');
  await expect(file(panel, 'src/cart.ts')).toBeVisible();
  await writeFile(path.join(world.projects.main, 'notes', 'later.md'), 'one more\n');
  await panel.getByTestId('git-refresh').click();
  await expect(file(panel, 'notes/later.md')).toBeVisible();

  // Whitespace shown again (the empty state offers the other mode only then, as Paseo's).
  await panel.getByTestId('git-whitespace').click();
  await expect(panel.getByTestId('git-whitespace')).toHaveAttribute('aria-pressed', 'false');

  // Committed (against the base branch): nothing committed beyond main here.
  await panel.getByTestId('git-mode').selectOption('base');
  await expect(panel.getByTestId('git-empty')).toContainText('No changes to display');
  await panel.getByTestId('changes-empty-switch-mode').click();
  await expect(file(panel, 'src/cart.ts')).toBeVisible();

  // Open in Diff: the Diff panel shows that file, opened.
  await file(panel, 'src/cart.ts').getByTestId('git-file-open-diff').click();
  const diff = page.getByTestId('diff-panel');
  await expect(diff.getByTestId('git-focus')).toContainText('src/cart.ts');
  await expect(diff.getByTestId('git-file')).toHaveCount(1);
  await expect(file(diff, 'src/cart.ts').getByTestId('git-hunks')).toBeVisible();
  await diff.getByTestId('git-focus-clear').click();
  await expect(file(diff, 'notes/todo.md').getByTestId('git-hunks')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('changes-with-files-read.png') });
});

test('without files.read: the status list, no content, and the token is told what it needs', async ({ page }) => {
  await connect(page, world, world.tokens.viewer);
  await openChanges(page);
  const panel = dock(page).getByTestId('changes-panel');
  await expect(panel).toHaveAttribute('data-content', 'none');
  await expect(panel.getByTestId('git-content-forbidden')).toContainText('needs files.read');
  await expect(panel.locator('[data-testid="git-status-file"][data-path="src/cart.ts"]')).toHaveAttribute('data-change', 'modified');
  await expect(panel.locator('[data-testid="git-status-file"][data-path="docs/new-name.md"]')).toContainText('docs/old-name.md');
  await expect(panel.locator('[data-testid="git-status-file"][data-path=".env"]')).toHaveCount(0);
  await expect(panel.getByTestId('git-hunks')).toHaveCount(0);
  await expect(panel.getByTestId('git-mode')).toHaveCount(0);
  await expect(panel).not.toContainText('export const');
});

test('a token without project.read is told so, and nothing reaches Git', async ({ page }) => {
  await connect(page, world, world.tokens.sessionsOnly);
  await dock(page).getByRole('tab', { name: 'Changes' }).click();
  await expect(dock(page).getByTestId('panel-unavailable-changes')).toHaveAttribute('data-reason', 'projectRead');
  await expect(dock(page).getByTestId('panel-unavailable-changes')).toContainText('needs project.read');
});
