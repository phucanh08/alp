import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access, rename, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createRegistry } from '@anhlp/alp-daemon/registry';
import { createWorkspaceWorktrees } from '@anhlp/alp-daemon/worktrees';

// t-c1ba: owner-audited adoption of managed worktrees made before birth certification existed.
const git = (cwd, ...args) =>
  execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  }).trim();

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-adopt-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'),
    source = path.join(root, 'repo'),
    parent = path.join(root, 'dest');
  await mkdir(path.join(home, 'state'), { recursive: true, mode: 0o700 });
  await mkdir(source);
  await mkdir(parent, { mode: 0o700 });
  git(source, 'init', '-q');
  await writeFile(path.join(source, 'file'), 'one\n');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'initial');
  await writeFile(
    path.join(home, 'worktree-destinations.json'),
    JSON.stringify({ version: 1, mappings: [{ id: 'approved', source, parent, commonDir: path.join(source, '.git') }] }),
    { mode: 0o600 }
  );
  const registry = createRegistry(home);
  await registry.mutate('project.register', { directory: source }, { requestId: 'register' });
  const origin = (await registry.snapshot()).workspaces[0];
  // Made the way a release before birth certification made it: nothing registered the new checkout.
  const created = (
    await createWorkspaceWorktrees(home, registry, async (_dir, run) => run(), async () => {}).mutate('create', {
      workspaceId: origin.id,
      mappingId: 'approved',
      ifRevision: 1,
      requestId: 'legacy'
    })
  ).workspace;
  const ledgerFile = path.join(home, 'state', 'assignment-results.json');
  // A ledger in use for other work (or left by a restore) that does not certify the old checkout.
  await writeFile(ledgerFile, JSON.stringify({ version: 1, workspaces: [], results: [] }));
  await writeFile(ledgerFile + '.initialized', '1\n');
  const runtime = createAlpRuntime({ assignmentResultFile: ledgerFile, liveFile: path.join(home, 'state', 'live.json'), recallFile: path.join(home, 'state', 'recall.json') });
  t.after(() => runtime.shutdown());
  const service = createWorkspaceWorktrees(
    home,
    registry,
    (dir, run) => runtime.withWorkspaceMutation(dir, run),
    (dir) => runtime.registerWorkspace(dir),
    (dir, verify) => runtime.adoptWorkspace(dir, verify)
  );
  const auditFile = path.join(home, 'state', 'workspace-adoptions.jsonl');
  const audit = async () => (await readFile(auditFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { root, home, source, parent, registry, runtime, service, created, ledgerFile, audit };
}
const remove = async (f) => f.service.mutate('remove', { workspaceId: f.created.id, ifRevision: (await f.registry.snapshot()).revision, requestId: 'remove-' + Math.random() });
const stillRefused = async (f) => {
  await assert.rejects(remove(f), (e) => e.data?.reason === 'workspace_assignment_result');
  await access(path.join(f.created.directory, 'file'));
};

test('the owner adopts a verified legacy worktree after confirming its facts; removal then runs its own checks', async (t) => {
  const f = await fixture(t);
  // Without adoption the old registry row is never permission to delete.
  await stillRefused(f);
  const facts = await f.service.adoption(f.created.id);
  assert.deepEqual(facts, {
    workspaceId: f.created.id,
    directory: f.created.directory,
    source: f.source,
    commonDir: path.join(f.source, '.git'),
    gitDir: path.join(f.source, '.git', 'worktrees', f.created.id),
    branch: `alp/workspace/${f.created.id}`,
    head: git(f.source, 'rev-parse', 'HEAD')
  });
  // Previewing changes nothing, and neither does a request without the owner's confirmation.
  assert.deepEqual(await f.audit(), []);
  await stillRefused(f);
  await assert.rejects(f.service.adopt({ workspaceId: f.created.id }), (e) => e.data?.reason === 'confirmation_mismatch');
  await assert.rejects(f.service.adopt({ workspaceId: f.created.id, confirm: { ...facts, extra: true } }), (e) => e.data?.reason === 'confirmation_mismatch');
  await stillRefused(f);
  assert.deepEqual(await f.service.adopt({ workspaceId: f.created.id, confirm: facts }), { adopted: facts });
  assert.deepEqual(
    (await f.audit()).map(({ at, ...entry }) => (assert.ok(at), entry)),
    [
      { event: 'adoption.requested', actor: 'owner', ...facts },
      { event: 'adoption.certified', actor: 'owner', workspaceId: f.created.id, directory: f.created.directory }
    ]
  );
  assert.deepEqual(JSON.parse(await readFile(f.ledgerFile, 'utf8')).workspaces, [f.created.directory]);
  // Removal keeps its own refusals: dirty files still stop it.
  await writeFile(path.join(f.created.directory, 'notes'), 'keep\n');
  await assert.rejects(remove(f), (e) => e.data?.reason === 'workspace_dirty');
  await rm(path.join(f.created.directory, 'notes'));
  const removed = await remove(f);
  assert.equal(removed.filesRemoved, true);
  await assert.rejects(access(f.created.directory), { code: 'ENOENT' });
  assert.equal(git(f.source, 'rev-parse', '--verify', `refs/heads/alp/workspace/${f.created.id}`), facts.head);
});

test('only the host owner adopts, and only facts that still hold', async (t) => {
  const f = await fixture(t);
  const facts = await f.service.adoption(f.created.id);
  for (const context of [{ principalId: 'token' }, { principalEpoch: 'credential' }, { mappingIds: ['approved'] }, { authorizedRoots: [f.source] }]) {
    await assert.rejects(f.service.adoption(f.created.id, context), (e) => e.data?.reason === 'owner_only');
    await assert.rejects(f.service.adopt({ workspaceId: f.created.id, confirm: facts }, context), (e) => e.data?.reason === 'owner_only');
  }
  // A commit after the owner looked: the confirmation no longer describes the checkout.
  await writeFile(path.join(f.created.directory, 'file'), 'two\n');
  git(f.created.directory, 'commit', '-qam', 'later');
  await assert.rejects(f.service.adopt({ workspaceId: f.created.id, confirm: facts }), (e) => e.data?.reason === 'confirmation_mismatch');
  await stillRefused(f);
  assert.deepEqual(await f.audit(), []);
  // A change after the first check but before the runtime's reservation is caught by the check under it.
  const racing = createWorkspaceWorktrees(f.home, f.registry, (dir, run) => f.runtime.withWorkspaceMutation(dir, run), (dir) => f.runtime.registerWorkspace(dir), async (dir, verify) => {
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'raced');
    return f.runtime.adoptWorkspace(dir, verify);
  });
  await assert.rejects(racing.adopt({ workspaceId: f.created.id, confirm: await racing.adoption(f.created.id) }), (e) => e.data?.reason === 'confirmation_mismatch');
  assert.deepEqual((await f.audit()).map(({ event, reason }) => ({ event, reason })), [{ event: 'adoption.requested', reason: undefined }, { event: 'adoption.refused', reason: 'confirmation_mismatch' }]);
  await stillRefused(f);
  await assert.rejects(f.service.adopt({ workspaceId: 'wks_0000000000000000', confirm: facts }), (e) => e.data?.reason === 'not_found');
  const service = createWorkspaceWorktrees(f.home, f.registry, (dir, run) => f.runtime.withWorkspaceMutation(dir, run), (dir) => f.runtime.registerWorkspace(dir));
  await assert.rejects(service.adopt({ workspaceId: f.created.id, confirm: await service.adoption(f.created.id) }), (e) => e.data?.reason === 'guard_unavailable');
  await stillRefused(f);
});

test('each failed verification refuses adoption and leaves removal refused', async (t) => {
  const f = await fixture(t);
  const id = f.created.id;
  const directory = f.created.directory;
  const mappings = path.join(f.home, 'worktree-destinations.json');
  const approved = await readFile(mappings, 'utf8');
  const refusedWith = async (reason, setup, restore) => {
    await setup();
    try {
      await assert.rejects(f.service.adoption(id), (e) => e.data?.reason === reason, reason);
    } finally {
      await restore();
    }
    await stillRefused(f);
  };
  // Source repository: the host no longer approves it, or approves another repository under the same mapping.
  await refusedWith('outside_workspace', () => writeFile(mappings, JSON.stringify({ version: 1, mappings: [] }), { mode: 0o600 }), () => writeFile(mappings, approved, { mode: 0o600 }));
  const other = path.join(f.root, 'other');
  await mkdir(other);
  git(other, 'init', '-q');
  const remapped = JSON.parse(approved);
  remapped.mappings[0].commonDir = path.join(other, '.git');
  await refusedWith('outside_workspace', () => writeFile(mappings, JSON.stringify(remapped), { mode: 0o600 }), () => writeFile(mappings, approved, { mode: 0o600 }));
  // commonDir: the worktree's administrative files now point it into another repository.
  const admin = path.join(f.source, '.git', 'worktrees', id);
  const commondir = await readFile(path.join(admin, 'commondir'), 'utf8');
  await refusedWith('identity_changed', () => writeFile(path.join(admin, 'commondir'), path.join(other, '.git') + '\n'), () => writeFile(path.join(admin, 'commondir'), commondir));
  // Real path: a symlink in place of the checkout names whatever it points at.
  const moved = path.join(f.root, 'moved');
  await refusedWith('identity_changed', async () => { await rename(directory, moved); await symlink(moved, directory); }, async () => { await rm(directory); await rename(moved, directory); });
  // Worktree identity: another branch, a lock, or a checkout Git no longer lists.
  await refusedWith('identity_changed', () => git(directory, 'checkout', '-qb', 'elsewhere'), () => git(directory, 'checkout', '-q', `alp/workspace/${id}`));
  await refusedWith('identity_changed', () => git(f.source, 'worktree', 'lock', directory), () => git(f.source, 'worktree', 'unlock', directory));
  const gitfile = await readFile(path.join(directory, '.git'), 'utf8');
  await refusedWith('identity_changed', () => rm(path.join(directory, '.git')), () => writeFile(path.join(directory, '.git'), gitfile));
  // A pending native intent for it needs reconciliation first.
  const registryFile = path.join(f.home, 'state', 'web-workspaces.json');
  const saved = await readFile(registryFile, 'utf8');
  const pending = JSON.parse(saved);
  pending.worktreeJournal = { stuck: { fingerprint: 'x', intent: { method: 'remove', id, branch: `alp/workspace/${id}`, directory, source: f.source, commonDir: path.join(f.source, '.git'), head: git(f.source, 'rev-parse', 'HEAD') } } };
  await writeFile(registryFile, JSON.stringify(pending));
  const reloaded = createWorkspaceWorktrees(f.home, createRegistry(f.home), async () => assert.fail('guarded'), async () => {}, async () => assert.fail('adopted'));
  await assert.rejects(reloaded.adoption(id), (e) => e.data?.reason === 'reconciliation_required');
  await writeFile(registryFile, saved);
  // Not a managed worktree at all: the source checkout itself.
  await assert.rejects(f.service.adoption((await f.registry.snapshot()).workspaces[0].id), (e) => e.data?.reason === 'not_managed');
  // Every refusal above left the facts provable again, and nothing was certified.
  await f.service.adoption(id);
  assert.deepEqual(JSON.parse(await readFile(f.ledgerFile, 'utf8')).workspaces, []);
});

test('a checkout an assignment still owns is never adopted; the refusal is logged', async (t) => {
  const f = await fixture(t);
  const facts = await f.service.adoption(f.created.id);
  const ledger = JSON.parse(await readFile(f.ledgerFile, 'utf8'));
  await writeFile(f.ledgerFile, JSON.stringify({ ...ledger, results: [{ assignmentId: 'retained', checkout: f.created.directory }] }));
  await assert.rejects(f.service.adopt({ workspaceId: f.created.id, confirm: facts }), (e) => e.data?.reason === 'workspace_assignment_result');
  assert.deepEqual(
    (await f.audit()).map(({ event, reason }) => ({ event, reason })),
    [{ event: 'adoption.requested', reason: undefined }, { event: 'adoption.refused', reason: 'workspace_assignment_result' }]
  );
  await writeFile(f.ledgerFile, JSON.stringify(ledger));
  await stillRefused(f);
  assert.deepEqual(JSON.parse(await readFile(f.ledgerFile, 'utf8')).workspaces, []);
});
