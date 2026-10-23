import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRegistry } from '@anhlp/alp-daemon/registry';
import { createWorkspaceWorktrees } from '@anhlp/alp-daemon/worktrees';
const git = (cwd, ...args) =>
  execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  }).trim();
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-managed-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'),
    source = path.join(root, 'repo'),
    parent = path.join(root, 'dest');
  await mkdir(home, { mode: 0o700 });
  await mkdir(source);
  await mkdir(parent, { mode: 0o700 });
  git(source, 'init', '-q');
  await writeFile(path.join(source, 'file'), 'one\n');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'initial');
  await writeFile(
    path.join(home, 'worktree-destinations.json'),
    JSON.stringify({
      version: 1,
      mappings: [{ id: 'approved', source, parent, commonDir: path.join(source, '.git') }]
    }),
    { mode: 0o600 }
  );
  return { root, home, source, parent };
}
test('prepared create survives registry commit failure and restart once; remove failure reconciles absent target; no false success', async (t) => {
  const f = await fixture(t);
  let writes = 0;
  let failAt = 3;
  const registry = createRegistry(f.home, {
    write: async (...args) => {
      writes++;
      if (writes === failAt) throw new Error('disk rejected');
      return writeFile(...args);
    }
  });
  await registry.mutate('project.register', { directory: f.source }, { requestId: 'register' });
  const source = (await registry.snapshot()).workspaces[0];
  const context = {
    principalId: 'principal',
    principalEpoch: 'epoch',
    mappingIds: ['approved'],
    authorizedRoots: [f.source]
  };
  const guard = async (_dir, run) => run();
  const register = async () => {};
  let service = createWorkspaceWorktrees(f.home, registry, guard, register);
  const request = { workspaceId: source.id, mappingId: 'approved', ifRevision: 1, requestId: 'once' };
  await assert.rejects(service.mutate('create', request, context), /disk rejected/);
  const prepared = await registry.snapshot();
  assert.equal(prepared.revision, 1);
  assert.equal(prepared.workspaces.length, 1);
  const intent = Object.values(prepared.worktreeJournal)[0].intent;
  await access(path.join(intent.directory, 'file'));
  await assert.rejects(service.assertAvailable(intent.directory), (e) => e.data?.reason === 'reconciliation_required');
  assert.equal(git(f.source, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 2);
  const restarted = createRegistry(f.home);
  service = createWorkspaceWorktrees(f.home, restarted, guard, register);
  const created = await service.mutate('create', request, context);
  assert.equal(created.workspace.id, intent.id);
  assert.equal(created.revision, 2);
  assert.deepEqual(await service.mutate('create', request, context), created);
  assert.equal((await restarted.snapshot()).workspaces.length, 2);
  await assert.rejects(
    service.mutate('create', { ...request, requestId: 'other' }, context),
    (e) => e.data?.reason === 'stale_revision'
  );
  const before = await readFile(path.join(f.home, 'state', 'web-workspaces.json'), 'utf8');
  await assert.rejects(
    service.mutate('create', { ...request, requestId: 'denied', ifRevision: 2 }, { ...context, authorizedRoots: [] }),
    (e) => e.code === 1003
  );
  assert.equal(await readFile(path.join(f.home, 'state', 'web-workspaces.json'), 'utf8'), before);
  await writeFile(path.join(intent.directory, 'dirty'), 'retain');
  await assert.rejects(
    service.mutate('remove', { workspaceId: intent.id, ifRevision: 2, requestId: 'dirty' }, context)
  );
  assert.equal(Object.keys((await restarted.snapshot()).worktreeJournal).length, 0);
  await rm(path.join(intent.directory, 'dirty'));
  const denied = createWorkspaceWorktrees(
    f.home,
    restarted,
    async () => {
      throw new Error('workspace leased');
    },
    register
  );
  await assert.rejects(
    denied.mutate('remove', { workspaceId: intent.id, ifRevision: 2, requestId: 'leased' }, context),
    /leased/
  );
  await access(intent.directory);
  // Fail only the post-native tombstone save.
  let removeWrites = 0;
  const failing = createRegistry(f.home, {
    write: async (...args) => {
      if (++removeWrites === 2) throw new Error('remove save failed');
      return writeFile(...args);
    }
  });
  service = createWorkspaceWorktrees(f.home, failing, guard, register);
  const remove = { workspaceId: intent.id, ifRevision: 2, requestId: 'remove' };
  await assert.rejects(service.mutate('remove', remove, context), /remove save failed/);
  await assert.rejects(access(intent.directory));
  assert.equal((await failing.snapshot()).revision, 2);
  const finalRegistry = createRegistry(f.home);
  service = createWorkspaceWorktrees(f.home, finalRegistry, guard, register);
  const removed = await service.mutate('remove', remove, context);
  assert.equal(removed.filesRemoved, true);
  assert.equal(removed.branchRetained, true);
  assert.deepEqual(await service.mutate('remove', remove, context), removed);
  assert.ok(git(f.source, 'rev-parse', `refs/heads/${intent.branch}`));
  assert.equal(Object.keys((await finalRegistry.snapshot()).worktreeJournal).length, 0);
});
test('owner requires host destination configuration; no managed deletion for registered/assignment paths', async (t) => {
  const f = await fixture(t);
  const registry = createRegistry(f.home);
  await registry.mutate('project.register', { directory: f.source }, { requestId: 'register' });
  const w = (await registry.snapshot()).workspaces[0];
  const service = createWorkspaceWorktrees(
    f.home,
    registry,
    async (_d, run) => run(),
    async () => {}
  );
  await assert.rejects(
    service.mutate('create', { workspaceId: w.id, mappingId: 'outside', requestId: 'no', ifRevision: 1 }),
    (e) => e.code === 1003
  );
  await assert.rejects(
    service.mutate('remove', { workspaceId: w.id, requestId: 'no', ifRevision: 1 }),
    (e) => e.data?.reason === 'not_managed'
  );
  assert.equal(git(f.source, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
});

test('actual subprocess crash after Git but before registry publication is reconciled to one checkout', async (t) => {
  const f = await fixture(t);
  const registry = createRegistry(f.home);
  await registry.mutate('project.register', { directory: f.source }, { requestId: 'source' });
  const source = (await registry.snapshot()).workspaces[0];
  const request = { workspaceId: source.id, mappingId: 'approved', requestId: 'process-crash', ifRevision: 1 };
  const code = `import {writeFile} from 'node:fs/promises';import {createRegistry} from ${JSON.stringify(import.meta.resolve('@anhlp/alp-daemon/registry'))};import {createWorkspaceWorktrees} from ${JSON.stringify(import.meta.resolve('@anhlp/alp-daemon/worktrees'))};let count=0;const r=createRegistry(${JSON.stringify(f.home)},{write:async(...a)=>{if(++count===2)process.exit(86);return writeFile(...a);}});const s=createWorkspaceWorktrees(${JSON.stringify(f.home)},r,async(_d,run)=>run(),async()=>{});await s.mutate('create',${JSON.stringify(request)});process.exit(1);`;
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: f.root,
    env: { ALP_HOME: f.home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 20000
  });
  assert.equal(child.status, 86, child.stderr);
  const recovered = createRegistry(f.home);
  const before = await recovered.snapshot();
  assert.equal(before.workspaces.length, 1);
  assert.equal(before.revision, 1);
  assert.equal(git(f.source, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 2);
  const service = createWorkspaceWorktrees(
    f.home,
    recovered,
    async (_d, run) => run(),
    async () => {}
  );
  const result = await service.mutate('create', request);
  assert.equal(result.workspace.id, Object.values(before.worktreeJournal)[0].intent.id);
  assert.equal((await recovered.snapshot()).workspaces.length, 2);
  assert.equal(git(f.source, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 2);
});

test('failure to save prepared intent runs no Git mutation and publishes no grant', async (t) => {
  const f = await fixture(t);
  let writes = 0;
  const registry = createRegistry(f.home, {
    write: async (...args) => {
      if (++writes === 2) throw new Error('prepare save failed');
      return writeFile(...args);
    }
  });
  await registry.mutate('project.register', { directory: f.source }, { requestId: 'source' });
  const w = (await registry.snapshot()).workspaces[0];
  const service = createWorkspaceWorktrees(
    f.home,
    registry,
    async (_d, run) => run(),
    async () => {}
  );
  await assert.rejects(
    service.mutate('create', { workspaceId: w.id, mappingId: 'approved', requestId: 'prepare-fail', ifRevision: 1 }),
    /prepare save failed/
  );
  assert.equal((await registry.snapshot()).revision, 1);
  assert.equal((await service.grants()).workspaces.length, 0);
  assert.equal(git(f.source, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
});

test('committed derived grant refresh spawns no Git and rejects changed administrative backlinks and branch', async (t) => {
  const f = await fixture(t);
  const registry = createRegistry(f.home);
  await registry.mutate('project.register', { directory: f.source }, { requestId: 'source' });
  const source = (await registry.snapshot()).workspaces[0];
  const service = createWorkspaceWorktrees(
    f.home,
    registry,
    async (_d, run) => run(),
    async () => {}
  );
  const context = { principalId: 'p', principalEpoch: 'scope', mappingIds: ['approved'], authorizedRoots: [f.source] };
  const made = await service.mutate(
    'create',
    { workspaceId: source.id, mappingId: 'approved', requestId: 'grant', ifRevision: 1 },
    context
  );
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const original = childProcess.spawn;
  let spawns = 0;
  childProcess.spawn = (...args) => {
    spawns++;
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await service.grants(context)).workspaces.length, 1);
    assert.equal(spawns, 0, 'event authority refresh must not spawn a Git process');
    const admin = made.workspace.worktree.gitDir;
    const backlink = path.join(admin, 'gitdir'),
      previous = await readFile(backlink, 'utf8');
    await writeFile(backlink, path.join(f.source, '.git') + '\n');
    assert.equal((await service.grants(context)).workspaces.length, 0);
    await writeFile(backlink, previous);
    const head = path.join(admin, 'HEAD'),
      headBefore = await readFile(head, 'utf8');
    await writeFile(head, 'ref: refs/heads/other\n');
    assert.equal((await service.grants(context)).workspaces.length, 0);
    await writeFile(head, headBefore);
    assert.equal((await service.grants(context)).workspaces.length, 1);
    assert.equal((await service.grants({ ...context, principalEpoch: 'changed' })).workspaces.length, 0);
    assert.equal((await service.grants({ ...context, principalId: 'other' })).workspaces.length, 0);
    assert.equal(spawns, 0);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
});

test('restore quarantines host mappings and cannot revive derived grants after same-ID reapproval', async t => {
  const { backup } = await import('@anhlp/alp-core');
  const { createAlpRuntime } = await import('@anhlp/alp-runtime');
  const f = await fixture(t);
  const mapping = await readFile(path.join(f.home, 'worktree-destinations.json'));
  const ledgerFile = home => path.join(home, 'state', 'assignment-results.json');
  const runtime = createAlpRuntime({ assignmentResultFile: ledgerFile(f.home) });
  const registry = createRegistry(f.home);
  await registry.mutate('project.register', { directory: f.source }, { requestId: 'register' });
  const source = (await registry.snapshot()).workspaces[0];
  const context = { principalId: 'token-owner', principalEpoch: 'credential-epoch', mappingIds: ['approved'], authorizedRoots: [f.source] };
  const service = createWorkspaceWorktrees(f.home, registry, (dir, run) => runtime.withWorkspaceMutation(dir, run), dir => runtime.registerWorkspace(dir));
  const created = await service.mutate('create', { workspaceId: source.id, mappingId: 'approved', ifRevision: 1, requestId: 'create' }, context);
  assert.equal((await service.grants(context)).workspaces.length, 1);
  const ledger = JSON.parse(await readFile(ledgerFile(f.home), 'utf8'));
  ledger.results.push({ assignmentId: 'retained', checkout: created.workspace.directory });
  await writeFile(ledgerFile(f.home), JSON.stringify(ledger));
  await runtime.shutdown();
  const archive = path.join(f.root, 'restore.alpbackup');
  await backup.createBackup({ home: f.home, out: archive });
  for (const home of [f.home, path.join(f.root, 'fresh')]) {
    await mkdir(home, { recursive: true });
    await backup.restoreBackup({ home, file: archive, safety: false });
    const restarted = createAlpRuntime({ assignmentResultFile: ledgerFile(home) });
    const restoredRegistry = createRegistry(home);
    const restoredService = createWorkspaceWorktrees(home, restoredRegistry, (dir, run) => restarted.withWorkspaceMutation(dir, run), dir => restarted.registerWorkspace(dir));
    try {
      assert.deepEqual(await restoredService.grants(context), { mappings: [], workspaces: [] });
      // Explicit host approval of the same mapping permits new work, but cannot restore old grants.
      await writeFile(path.join(home, 'worktree-destinations.json'), mapping, { mode: 0o600 });
      assert.equal((await restoredService.grants(context)).workspaces.length, 0);
      await assert.rejects(restoredService.mutate('remove', { workspaceId: created.workspace.id, ifRevision: 2, requestId: 'remove' }, context), e => e.data.reason === 'not_managed');
      await assert.rejects(restarted.withWorkspaceMutation(created.workspace.directory, async () => assert.fail('restored ownership allowed removal')), e => e.data.reason === 'workspace_assignment_result');
      await access(path.join(created.workspace.directory, 'file'));
    } finally { await restarted.shutdown(); }
  }
});

test('restored pending native create remains unreconciled by its historical credential', async t => {
  const { backup } = await import('@anhlp/alp-core');
  const f = await fixture(t);
  const mapping = await readFile(path.join(f.home, 'worktree-destinations.json'));
  let writes = 0;
  const registry = createRegistry(f.home, { write: async (...args) => {
    if (++writes === 3) throw new Error('stop commit');
    return writeFile(...args);
  } });
  await registry.mutate('project.register', { directory: f.source }, { requestId: 'register' });
  const source = (await registry.snapshot()).workspaces[0];
  const context = { principalId: 'token', principalEpoch: 'epoch', mappingIds: ['approved'], authorizedRoots: [f.source] };
  const request = { workspaceId: source.id, mappingId: 'approved', ifRevision: 1, requestId: 'pending' };
  await assert.rejects(createWorkspaceWorktrees(f.home, registry, (_dir, run) => run(), async () => {}).mutate('create', request, context), /stop commit/);
  const pending = Object.values((await registry.snapshot()).worktreeJournal)[0].intent;
  const archive = path.join(f.root, 'pending.alpbackup');
  await backup.createBackup({ home: f.home, out: archive });
  await backup.restoreBackup({ home: f.home, file: archive, safety: false });
  await writeFile(path.join(f.home, 'worktree-destinations.json'), mapping, { mode: 0o600 });
  const restoredRegistry = createRegistry(f.home);
  const service = createWorkspaceWorktrees(f.home, restoredRegistry, (_dir, run) => run(), async () => assert.fail('restored intent registered a target'));
  await assert.rejects(service.mutate('create', request, context), e => e.data?.reason === 'identity_changed');
  assert.equal((await restoredRegistry.snapshot()).workspaces.length, 1);
  await access(path.join(pending.directory, 'file'));
});

test('describe reports the branch of a workspace registered through a symlinked path, and none once its identity moves', async t => {
  const f = await fixture(t);
  // A /var -> /private/var style alias: the registry keeps the path as given and its realpath as canonical.
  const alias = path.join(f.root, 'alias');
  const moved = path.join(f.root, 'moved');
  await symlink(f.root, alias);
  const registry = createRegistry(f.home);
  await registry.mutate('project.register', { directory: path.join(alias, 'repo') }, { requestId: 'register' });
  const w = (await registry.snapshot()).workspaces[0];
  assert.equal(w.directory, path.join(alias, 'repo'));
  assert.equal(w.canonical, f.source);
  const service = createWorkspaceWorktrees(f.home, registry, async (_d, run) => run(), async () => {});
  const branch = git(f.source, 'symbolic-ref', '--short', 'HEAD');
  assert.equal((await service.describe(w)).branch, branch);
  // A record with no recorded canonical identity is read only at a path that is canonical itself.
  const { canonical: _, ...legacy } = w;
  assert.equal((await service.describe(legacy)).branch, null);
  assert.equal((await service.describe({ ...legacy, directory: f.source })).branch, branch);
  // A detached checkout still reports no branch.
  git(f.source, 'checkout', '-q', '--detach');
  assert.equal((await service.describe(w)).branch, null);
  git(f.source, 'checkout', '-q', branch);
  // Retargeting the alias to another repository must not show that repository's branch.
  await mkdir(path.join(moved, 'repo'), { recursive: true });
  git(path.join(moved, 'repo'), 'init', '-q', '-b', 'elsewhere');
  await rm(alias);
  await symlink(moved, alias);
  assert.equal((await service.describe(w)).branch, null);
});
