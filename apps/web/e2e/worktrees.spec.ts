import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect } from './support/app.js';
import { connect as hostConnect } from '@anhlp/alp-client';
import { execFileSync } from 'node:child_process';
let world;
test.beforeAll(async () => {
  world = await startWorld({ worktrees: true });
});
test.afterAll(async () => {
  await world?.close();
});
test('gateway browser creates approved worktree, shows branch after restart, deletes files and retains branch; defaults have no control', async ({
  page,
  browser
}) => {
  // The host owner registers the project by its path as given: on macOS the temp dir is
  // /var/..., really /private/var/..., so the record's directory is not its canonical path.
  const local = await hostConnect(world.socket);
  try {
    const { revision } = await local.request('workspace.list', {});
    await local.request('project.register', { directory: world.projects.main, requestId: 'lexical', ifRevision: revision });
  } finally {
    local.close();
  }
  await connect(page, world, world.tokens.worktreeWriter);
  const source = page.locator(`[data-testid="sidebar-project"][data-path="${world.projects.main}"]`);
  await expect(source).toHaveAttribute('data-workspace-id', /.+/);
  // The project carries the checkout's branch, not "Detached HEAD", for that non-canonical record.
  const sourceBranch = execFileSync('/usr/bin/git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: world.projects.main,
    encoding: 'utf8'
  }).trim();
  await expect(source).toHaveAttribute('data-branch', sourceBranch);
  // Paseo's project actions hold the worktree commands.
  const actions = project => project.getByTestId('project-actions');
  await source.getByTestId('project-row').hover();
  await actions(source).click();
  await page.getByTestId('project-create-worktree').click();
  await page
    .getByRole('dialog', { name: 'Create managed worktree' })
    .getByRole('button', { name: 'Create checkout', exact: true })
    .click();
  const generated = page.locator('[data-testid="sidebar-project"][data-worktree="true"]');
  await expect(generated).toHaveCount(1);
  await expect(generated).toHaveAttribute('data-branch', /alp\/workspace\/wks_/);
  const id = await generated.getAttribute('data-workspace-id');
  const owner = await hostConnect(world.socket);
  let directory, branch;
  try {
    const row = (await owner.request('workspace.get', { workspaceId: id })).workspace;
    directory = row.directory;
    branch = row.branch;
  } finally {
    owner.close();
  }
  await page.screenshot({ path: test.info().outputPath('worktree-created-through-gateway.png') });
  await world.restartDaemon();
  await connect(page, world, world.tokens.worktreeWriter);
  await expect(generated).toHaveCount(1);
  await expect(generated).toHaveAttribute('data-branch', branch);
  await generated.getByTestId('project-row').hover();
  await actions(generated).click();
  await page.getByTestId('project-remove-worktree').click();
  await page
    .getByRole('dialog', { name: 'Remove managed worktree' })
    .getByRole('button', { name: 'Delete checkout files', exact: true })
    .click();
  await expect(generated).toHaveCount(0);
  const { access } = await import('node:fs/promises');
  await expect(access(directory)).rejects.toThrow();
  expect(
    execFileSync('/usr/bin/git', ['rev-parse', `refs/heads/${branch}`], {
      cwd: world.projects.main,
      encoding: 'utf8'
    }).trim()
  ).toMatch(/^[0-9a-f]{40}$/);
  const other = await browser.newContext();
  try {
    const read = await other.newPage();
    await connect(read, world);
    // Without workspace.manage the project actions offer no worktree command.
    const project = read.getByTestId('sidebar-project').first();
    await project.getByTestId('project-row').hover();
    await project.getByTestId('project-actions').click();
    await expect(read.getByTestId('project-copy-path')).toBeVisible();
    await expect(read.getByTestId('project-create-worktree')).toHaveCount(0);
    await expect(read.getByTestId('project-remove-worktree')).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('real gateway refuses missing mapping, dirty, active and saved-session removal without deleting data', async () => {
  const { AlpRpcClient, hello } = await import('@anhlp/alp-client/portable');
  const { connectWebSocket } = await import('@anhlp/alp-client/websocket');
  const { readFile, writeFile, access } = await import('node:fs/promises');
  const ticket = await fetch(world.gatewayUrl + '/v1/tickets', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + world.tokens.worktreeWriter }
  });
  const body = await ticket.json();
  const client = new AlpRpcClient(
    await connectWebSocket(world.gatewayUrl.replace('http:', 'ws:') + '/v1/ws', { protocols: body.subprotocols })
  );
  await hello(client);
  try {
    const rows = await client.request('workspace.list', {});
    const source = rows.workspaces.find((w) => !w.managedWorktree);
    expect(source).toBeTruthy();
    const file = world.home + '/state/web-workspaces.json';
    const before = await readFile(file, 'utf8');
    await expect(
      client.request('workspace.worktree.create', {
        workspaceId: source.id,
        mappingId: 'outside',
        requestId: 'outside',
        ifRevision: rows.revision
      })
    ).rejects.toMatchObject({ code: 1003 });
    expect(await readFile(file, 'utf8')).toBe(before);
    const made = await client.request('workspace.worktree.create', {
      workspaceId: source.id,
      mappingId: 'browser',
      requestId: 'guards',
      ifRevision: rows.revision
    });
    const directory = made.workspace.directory;
    await writeFile(directory + '/untracked', 'keep');
    await expect(
      client.request('workspace.worktree.remove', {
        workspaceId: made.workspace.id,
        requestId: 'dirty',
        ifRevision: made.revision
      })
    ).rejects.toMatchObject({ data: { reason: 'workspace_dirty' } });
    await access(directory + '/untracked');
    const { rm } = await import('node:fs/promises');
    await rm(directory + '/untracked');
    await client.request('session.create', {
      sessionId: 'worktree-active',
      workspaceId: made.workspace.id,
      spec: { workflow: 'pho', model: 'codex:gpt-5.6-sol' }
    });
    const active = await client.request('workspace.list', {});
    await expect(
      client.request('workspace.worktree.remove', {
        workspaceId: made.workspace.id,
        requestId: 'active',
        ifRevision: active.revision
      })
    ).rejects.toMatchObject({ data: { reason: 'workspace_busy' } });
    await access(directory);
    await client.request('session.close', { sessionId: 'worktree-active' });
    const closed = await client.request('workspace.list', {});
    await expect(
      client.request('workspace.worktree.remove', {
        workspaceId: made.workspace.id,
        requestId: 'history',
        ifRevision: closed.revision
      })
    ).rejects.toMatchObject({ data: { reason: 'workspace_history' } });
    await access(directory);
  } finally {
    client.close();
  }
});
