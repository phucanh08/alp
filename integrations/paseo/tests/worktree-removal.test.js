import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { createWorkspaces } from '@anhlp/alp-paseo/paseo/workspaces';
import { initProject } from '@anhlp/alp-core/init';
import { seedLibrary } from '@anhlp/alp-core/library';
import { fakeTransport } from '../../../test/support/fake-agent.js';
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from '@getpaseo/protocol/messages';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-facade-remove-')));
  const home = path.join(directory, 'home'), source = path.join(directory, 'repo'), parent = path.join(directory, 'dest');
  await mkdir(home, { mode: 0o700 }); await mkdir(source); await mkdir(parent, { mode: 0o700 });
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: source, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ALP_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git('init', '-q'); await writeFile(path.join(source, 'tracked'), 'keep'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'initial');
  await writeFile(path.join(home, 'worktree-destinations.json'), JSON.stringify({ version: 1, mappings: [{ id: 'approved', source, commonDir: path.join(source, '.git'), parent }] }), { mode: 0o600 });
  const agents = [];
  const runtime = createAlpRuntime({ supervisor: false, libraryDir: home, transport: fakeTransport(agents), assignmentResultFile: path.join(home, 'results.json'), liveFile: path.join(home, 'live.json'), recallFile: path.join(home, 'recall.json') });
  const daemon = createDaemonServer({ runtime, home, socketPath: '', version: 'test' });
  const client = daemon.local();
  const calls = [], events = [], failures = [];
  let unsupported = false;
  const facade = createWorkspaces({
    rpc: async (method, params) => {
      calls.push({ method, params });
      try {
        if (unsupported && method === 'workspace.worktree.remove') throw Object.assign(new Error('Method not found'), { code: -32601 });
        return await client.request(method, params);
      } catch (error) { failures.push(error); throw error; }
    },
    broadcast: event => events.push(event), agents: () => ({ roots: () => [], archive: async () => assert.fail('Removal must not archive sessions before daemon safety checks') }), inDevelopment: async () => 'unsupported',
  });
  t.after(async () => { await facade.close(); client.close(); await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const call = async request => {
    const parsed = SessionInboundMessageSchema.parse(request);
    assert.equal(typeof facade.handlers[parsed.type], 'function', 'native managed-worktree removal request must be implemented');
    const response = await facade.handlers[parsed.type](parsed, {});
    SessionOutboundMessageSchema.parse(response);
    return response.payload;
  };
  const opened = await call({ type: 'open_project_request', cwd: source, requestId: 'open' });
  const create = async (id, context = {}) => {
    const { registry } = await client.request('registry.owner', {});
    return (await client.request('workspace.worktree.create', { workspaceId: opened.workspace.id, mappingId: 'approved', ifRevision: registry.revision, requestId: id, ...context })).workspace;
  };
  const remove = (entry, requestId, extra = {}) => call({ type: 'paseo_worktree_archive_request', workspaceId: entry.id, worktreePath: entry.directory, scope: 'worktree', requestId, ...extra });
  const snapshot = () => readFile(path.join(home, 'state', 'web-workspaces.json'), 'utf8');
  return { home, source, runtime, client, git, create, remove, call, snapshot, calls, events, failures, agents, opened, unsupported: value => { unsupported = value; } };
}

test('native explicit worktree scope removes a disposable managed checkout; archive-only preserves it', async t => {
  const f = await fixture(t), made = await f.create('new');
  const mapping = await readFile(path.join(f.home, 'worktree-destinations.json'), 'utf8');
  const archived = await f.call({ type: 'archive_workspace_request', workspaceId: made.id, requestId: 'archive' });
  assert.equal(archived.error, null); await access(made.directory);
  const removed = await f.remove(made, 'remove');
  assert.equal(removed.success, true); assert.equal(removed.error, null);
  await assert.rejects(access(made.directory), { code: 'ENOENT' });
  assert.equal(f.git('worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
  assert.ok(f.git('branch', '--list', made.branch), 'branch is retained');
  assert.equal(await readFile(path.join(f.source, 'tracked'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(f.home, 'worktree-destinations.json'), 'utf8'), mapping);
  const registry = JSON.parse(await f.snapshot());
  assert.ok(registry.workspaces.find(entry => entry.id === made.id).worktree.removedAt);
  assert.deepEqual(registry.worktreeJournal, {});
  assert.equal(f.calls.filter(c => c.method === 'workspace.worktree.remove').length, 1);
  assert.deepEqual(Object.keys(f.calls.find(c => c.method === 'workspace.worktree.remove').params).sort(), ['ifRevision', 'requestId', 'workspaceId']);
});

test('native workspace scope and its legacy deletion flag remain archive-only; branch and path target resolution are explicit', async t => {
  const f = await fixture(t), made = await f.create('new');
  const archived = await f.call({ type: 'paseo_worktree_archive_request', worktreePath: made.directory, deleteWorktreeFromDisk: true, requestId: 'legacy' });
  assert.equal(archived.success, true); await access(made.directory);
  assert.equal(f.calls.some(c => c.method === 'workspace.worktree.remove'), false);
  const removed = await f.call({ type: 'paseo_worktree_archive_request', repoRoot: f.source, branchName: made.branch, scope: 'worktree', requestId: 'branch-remove' });
  assert.equal(removed.success, true); await assert.rejects(access(made.directory), { code: 'ENOENT' });
  const second = await f.create('second');
  assert.equal((await f.call({ type: 'paseo_worktree_archive_request', worktreePath: second.directory, scope: 'worktree', requestId: 'path-remove' })).success, true);
  await assert.rejects(access(second.directory), { code: 'ENOENT' });
});

test('a real runtime writer assignment prevents facade deletion and retains its checkout', async t => {
  const f = await fixture(t), made = await f.create('new');
  await seedLibrary(f.home); await initProject(f.source, { library: f.home });
  await f.runtime.open('root', { cwd: f.source, workflow: 'pho', mode: 'workspace-write', model: 'codex:gpt-5.6-sol' });
  await f.runtime.prompt('root', { clientMessageId: 'start', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
  const assignment = await f.agents[0].call('alp_delegate', { agent: 'peer', task: 'Keep this checkout', mode: 'workspace-write', writeRoot: made.directory, wait: false });
  assert.ok(assignment.assignmentId, JSON.stringify(assignment));
  assert.ok(f.runtime.status('root').leases.some(lease => lease.assignmentId === assignment.assignmentId && lease.checkout === made.directory), 'writer holds the real runtime checkout lease');
  const ledger = JSON.parse(await readFile(path.join(f.home, 'results.json'), 'utf8'));
  assert.ok(ledger.results.some(entry => entry.assignmentId === assignment.assignmentId && entry.checkout === made.directory));
  const before = await f.snapshot();
  const result = await f.remove(made, 'writer');
  assert.equal(result.success, false); assert.equal(f.failures.at(-1).data.reason, 'workspace_assignment_result');
  assert.equal(await f.snapshot(), before); await access(made.directory);
});

test('dirty, nonowner, external and unsupported removals preserve checkout and registry metadata', async t => {
  const f = await fixture(t), made = await f.create('new');
  const deny = async (entry, id, pattern, extra) => {
    const before = await f.snapshot();
    const result = await f.remove(entry, id, extra);
    assert.equal(result.success, false); assert.match(result.error.message, pattern);
    assert.equal(await f.snapshot(), before); await access(entry.directory);
    return result;
  };
  await writeFile(path.join(made.directory, 'dirty'), 'preserve');
  await deny(made, 'dirty', /in use|retained/i);
  assert.equal(f.failures.at(-1).data.reason, 'workspace_dirty');
  await rm(path.join(made.directory, 'dirty'));
  const other = await f.create('other', { principalId: 'other', principalEpoch: 'epoch' });
  assert.equal((await deny(other, 'owner', /Only your managed/)).error.code, 'NOT_ALLOWED');
  await deny({ id: f.opened.workspace.id, directory: f.source }, 'external', /managed/i);
  f.unsupported(true); await deny(made, 'unsupported', /upgrade|cannot remove/i); f.unsupported(false);
  await deny(made, 'mismatch', /match|target/i, { worktreePath: f.source });
});

test('runtime admission, retained assignments and saved sessions refuse removal without orphaning metadata', async t => {
  const f = await fixture(t), made = await f.create('new');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const holding = f.runtime.withWorkspaceMutation(made.directory, async () => { entered(); await gate; });
  await ready;
  const before = await f.snapshot();
  try {
    const busy = await f.remove(made, 'leased');
    assert.equal(busy.success, false); assert.match(busy.error.message, /in use|retained/i);
    assert.equal(f.failures.at(-1).data.reason, 'workspace_busy');
    assert.equal(await f.snapshot(), before); await access(made.directory);
  } finally { release(); await holding; }
  await writeFile(path.join(f.home, 'recall.json'), JSON.stringify([{ assignmentId: 'retained', cwd: made.directory }]));
  const retained = await f.remove(made, 'retained');
  assert.equal(f.failures.at(-1).data.reason, 'workspace_assignment_result');
  assert.equal(retained.success, false); assert.equal(await f.snapshot(), before); await access(made.directory);
  await writeFile(path.join(f.home, 'recall.json'), '[]');
  await f.client.request('registry.owner', { operation: 'placement.assign', args: { sessionId: 'saved-session', workspaceId: made.id }, requestId: 'saved-placement' });
  const historyBefore = await f.snapshot();
  const history = await f.remove(made, 'history');
  assert.equal(history.success, false); assert.equal(f.failures.at(-1).data.reason, 'workspace_history');
  assert.equal(await f.snapshot(), historyBefore); await access(made.directory);
});
