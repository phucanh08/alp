// t-a35b (Paseo parity batch 4), through the real UI, gateway and alpd (fake Codex): the New
// session screen's "Where it runs" control starts the session in a NEW managed worktree (made
// first with workspace.worktree.create, then session.create with its workspaceId), and the app
// opens that worktree. A token without workspace.manage is not offered the choice.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect as hostConnect } from '@anhlp/alp-client';
import type { SessionSummary } from '@anhlp/alp-protocol';
import { startWorld } from './support/world.ts';
import type { World } from './support/world.ts';
import { assistant, connect, idle, users } from './support/app.ts';

let world: World;
test.beforeAll(async () => {
  world = await startWorld({ worktrees: true });
  const local = await hostConnect(world.socket);
  try {
    const { revision } = await local.request('workspace.list', {});
    await local.request('project.register', { directory: world.projects.main, requestId: 'new-session-worktree', ifRevision: revision });
  } finally { local.close(); }
});
test.afterAll(async () => { await world?.close(); });

const screen = (page: Page) => page.getByTestId('new-session-screen');

test('New worktree: the worktree is made first, the session starts there, and the app opens it', async ({ page }) => {
  await connect(page, world, world.tokens.worktreeWriter);
  await page.getByRole('navigation').getByRole('button', { name: 'New session' }).click();
  await expect(screen(page)).toBeVisible();
  await expect(screen(page).getByTestId('new-session-where-label')).toHaveText('Local');
  await screen(page).getByTestId('new-session-where').click();
  await page.getByTestId('new-session-where-worktree').click();
  await expect(screen(page).getByTestId('new-session-where-label')).toHaveText('New worktree');
  await expect(screen(page).getByTestId('new-session-runs-in')).toContainText('in a new worktree of');
  await page.screenshot({ path: test.info().outputPath('new-session-worktree.png') });
  // Back to Local and again: only the chosen place counts.
  await screen(page).getByTestId('new-session-where').click();
  await page.getByTestId('new-session-where-local').click();
  await expect(screen(page).getByTestId('new-session-where-label')).toHaveText('Local');
  await screen(page).getByTestId('new-session-where').click();
  await page.getByTestId('new-session-where-worktree').click();

  // As a person waits for "This session will run" before starting (new-session.spec.ts).
  await expect(screen(page).getByTestId('session-preview')).toHaveAttribute('aria-busy', 'false');
  const composer = screen(page).getByLabel('Message', { exact: true });
  await composer.fill('Work in isolation');
  await composer.press('Enter');
  await expect(users(page)).toHaveText(['Work in isolation']);
  await expect(assistant(page).last()).toContainText('Echo: Work in isolation');
  await idle(page);

  // One managed worktree in the sidebar, current; the session runs in its directory.
  const generated = page.locator('[data-testid="sidebar-project"][data-worktree="true"]');
  await expect(generated).toHaveCount(1);
  await expect(generated).toHaveAttribute('data-current', 'true');
  const id = await generated.getAttribute('data-workspace-id');
  const owner = await hostConnect(world.socket);
  try {
    const row = (await owner.request('workspace.get', { workspaceId: id })).workspace;
    expect(row.managedWorktree).toBeTruthy();
    const { sessions } = await owner.request('session.list', {});
    const started = sessions.filter((session: SessionSummary) => session.title === 'Work in isolation');
    expect(started).toHaveLength(1);
    expect(started[0].projectRoot).toBe(row.directory);
    expect(started[0].projectRoot).not.toBe(world.projects.main);
  } finally { owner.close(); }
});

test('a token without workspace.manage is not offered a worktree', async ({ page }) => {
  await connect(page, world, world.tokens.filesReader);
  await page.getByRole('navigation').getByRole('button', { name: 'New session' }).click();
  await expect(screen(page)).toBeVisible();
  await expect(screen(page).getByLabel('Message', { exact: true })).toBeVisible();
  await expect(screen(page).getByTestId('new-session-where')).toHaveCount(0);
});
