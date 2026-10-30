import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaces } from '../server/dist/paseo/workspaces.js';
import { directorySuggestions } from '../server/dist/paseo/files.js';

const registry = { projects: [{ id: 'p', root: '/registered', addedAt: 'old' }], workspaces: [{ id: 'w', projectId: 'p', directory: '/registered', labels: [], createdAt: 'old' }], sessions: {}, labels: { generation: 'g', seq: 0, catalog: [] } };
const state = { state: 'repository', branch: 'from-daemon', remoteUrl: 'https://host/repo', dirty: true };
function facade(t, status, { facts = () => { throw new Error('unexpected workspace.git.facts'); }, owned = registry } = {}) {
  const calls = [];
  const workspaces = createWorkspaces({ rpc: async (method, params) => {
    calls.push([method, params]);
    if (method === 'registry.owner') return { registry: structuredClone(owned) };
    if (method === 'workspace.git.status') return status();
    if (method === 'workspace.git.facts') return facts(params);
    throw new Error(`unexpected ${method}`);
  }, broadcast() {}, agents: () => ({ roots: () => [] }), inDevelopment: async () => 'unsupported' });
  t.after(() => workspaces.close());
  return { workspaces, calls };
}

test('registered checkout metadata comes from alpd, with repository-root identity', async t => {
  const { workspaces, calls } = facade(t, () => state);
  await workspaces.start();
  const result = await workspaces.handlers.fetch_workspaces_request({ type: 'fetch_workspaces_request', requestId: 'list' });
  const row = result.payload.entries[0];
  assert.equal(row.gitRuntime?.currentBranch, 'from-daemon');
  assert.equal(row.gitRuntime?.isDirty, true);
  assert.equal(row.project.checkout.worktreeRoot, '/registered');
  assert.deepEqual(calls.filter(([method]) => method === 'workspace.git.status'), [['workspace.git.status', { workspaceId: 'w' }]]);
});

test('registered checkout denial is propagated, never replaced by bridge Git or non_git', async t => {
  const denied = Object.assign(new Error('grant denied'), { code: 1003 });
  const { workspaces } = facade(t, () => { throw denied; });
  await assert.rejects(workspaces.start(), error => error === denied);
});

test('unknown unsupported metadata is refused, never fabricated as a repository root', async t => {
  const { workspaces } = facade(t, () => ({ state: 'unsupported', reason: 'unknown' }));
  await assert.rejects(workspaces.start(), /repository root/);
});

const facts = (extra = {}) => ({ kind: 'ok', repoRoot: '/project', branch: 'from-facts', detached: false, head: 'a'.repeat(40), hasRemote: true, remoteUrl: 'https://host/project', dirty: false, ...extra });
/** A project with no workspace (project-only): its root is read by workspace.git.facts. */
const projectOnly = root => ({ projects: [{ id: 'p', root, addedAt: 'old' }], workspaces: [], sessions: {}, labels: { generation: 'g', seq: 0, catalog: [] } });
const emptyProject = async workspaces => (await workspaces.handlers.fetch_workspaces_request({ type: 'fetch_workspaces_request', requestId: 'list' })).payload.emptyProjects[0];

test('a project-only root is read by alpd\'s workspace.git.facts, each kind as it answers, never by the bridge', async t => {
  // A real repository: a bridge Git read would call it git; alpd's answer is what counts.
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-adapter-facts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  for (const [answer, kind] of [[facts({ repoRoot: root }), 'git'], [facts({ kind: 'not_repository_root', repoRoot: path.dirname(root) }), 'git'], [{ kind: 'unknown' }, 'non_git']]) {
    const { workspaces, calls } = facade(t, () => assert.fail('no registered workspace'), { owned: projectOnly(root), facts: () => answer });
    await workspaces.start();
    assert.equal((await emptyProject(workspaces)).projectKind, kind, answer.kind);
    assert.deepEqual(calls.filter(([method]) => method.startsWith('workspace.git.')), [['workspace.git.facts', { directory: root }]]);
  }
  const { workspaces } = facade(t, () => assert.fail('no registered workspace'), { owned: projectOnly(root), facts: () => ({ kind: 'unsupported', reason: 'worktree_elsewhere' }) });
  await assert.rejects(workspaces.start(), /supported repository/, 'unsupported is refused, not shown as non-git');
});

test('a facts refusal propagates; only -32601 (an older alpd) falls back to the bridge\'s own read', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-adapter-facts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  for (const refusal of [Object.assign(new Error('git_failed'), { code: 1000 }), Object.assign(new Error('user_only'), { code: 1003 }), Object.assign(new Error('git_unavailable'), { code: 1005 })]) {
    const { workspaces } = facade(t, () => assert.fail('no registered workspace'), { owned: projectOnly(root), facts: () => { throw refusal; } });
    await assert.rejects(workspaces.start(), error => error === refusal);
  }
  const { workspaces } = facade(t, () => assert.fail('no registered workspace'), { owned: projectOnly(root), facts: () => { throw Object.assign(new Error('Method not found'), { code: -32601 }); } });
  await workspaces.start();
  assert.equal((await emptyProject(workspaces)).projectKind, 'git', 'the legacy read, for an older alpd only');
});

test('a registered nested folder takes its enclosing repository\'s facts from alpd', async t => {
  const nested = { ...registry, workspaces: [{ ...registry.workspaces[0], directory: '/project/src' }], projects: [{ ...registry.projects[0], root: '/project/src' }] };
  const { workspaces, calls } = facade(t, () => ({ state: 'unsupported', reason: 'not_repository_root' }), { owned: nested, facts: () => facts({ kind: 'not_repository_root' }) });
  await workspaces.start();
  const row = (await workspaces.handlers.fetch_workspaces_request({ type: 'fetch_workspaces_request', requestId: 'list' })).payload.entries[0];
  assert.equal(row.project.checkout.worktreeRoot, '/project', 'the ancestor root, never the folder');
  assert.equal(row.gitRuntime?.currentBranch, 'from-facts');
  assert.deepEqual(calls.filter(([method]) => method === 'workspace.git.facts'), [['workspace.git.facts', { directory: '/project/src' }]]);
});

test('file-only normal search ranks a complete daemon list; denial never reads local files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'local-secret.txt'), 'local');
  const request = { type: 'directory_suggestions_request', requestId: 'f', cwd: root, query: 'intro', includeFiles: true, includeDirectories: false };
  const calls = [];
  const rpc = async (method, params) => { calls.push([method, params]); return { files: [{ path: 'docs/intro.md' }, { path: 'intro.md' }] }; };
  const result = await directorySuggestions(request, rpc);
  assert.deepEqual(result.payload.entries, [{ path: 'intro.md', kind: 'file' }, { path: 'docs/intro.md', kind: 'file' }]);
  assert.deepEqual(calls, [['workspace.files.search', { projectRoot: root, query: '', limit: 100 }]]);
  const denied = await directorySuggestions({ ...request, query: 'secret' }, async () => { throw Object.assign(new Error('grant denied'), { code: 1003 }); });
  assert.deepEqual(denied.payload.entries, []);
  assert.equal(denied.payload.error, 'grant denied');
});

test('daemon search truncation preserves complete legacy ranking; suffix/directory modes stay isolated', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-adapter-large-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'intro.md'), 'legacy');
  const request = { type: 'directory_suggestions_request', requestId: 'f', cwd: root, query: 'intro', includeFiles: true, includeDirectories: false };
  let calls = 0;
  const rpc = async () => { calls++; return { files: [], truncated: true }; };
  assert.deepEqual((await directorySuggestions(request, rpc)).payload.entries, [{ path: 'docs/intro.md', kind: 'file' }]);
  assert.equal(calls, 1);
  assert.deepEqual((await directorySuggestions({ ...request, query: 'docs/intro.md', matchMode: 'suffix' }, rpc)).payload.entries, [{ path: 'docs/intro.md', kind: 'file' }]);
  assert.deepEqual((await directorySuggestions({ ...request, query: 'docs', includeFiles: false, includeDirectories: true }, rpc)).payload.entries, [{ path: 'docs', kind: 'directory' }]);
  assert.equal(calls, 1, 'unsupported search shapes never invoke the file-only API');
});

test('checkout cache changes source on registration, coalesces refresh and drops denied facts', async () => {
  const { checkoutCache } = await import('../server/dist/paseo/git.js');
  let source = 'project-only';
  let calls = 0;
  let deny = false;
  const cache = checkoutCache(10_000, async () => {
    calls++;
    if (deny) throw new Error('unavailable');
    return source === 'project-only' ? { isGit: false } : { isGit: true, repoRoot: '/repo', currentBranch: 'main', remoteUrl: null, isDirty: false };
  }, directory => `${source}:${directory}`);
  assert.deepEqual(await cache.read('/repo'), { isGit: false });
  source = 'wks_registered';
  assert.equal(cache.peek('/repo'), undefined, 'legacy facts are not reused after registration');
  await Promise.all([cache.read('/repo'), cache.read('/repo')]);
  assert.equal(calls, 2);
  assert.equal(cache.peek('/repo').isGit, true);
  deny = true;
  await assert.rejects(cache.read('/repo', true), /unavailable/);
  assert.equal(cache.peek('/repo'), undefined, 'denial removes previously trusted metadata');
  deny = false;
  assert.equal((await cache.read('/repo')).isGit, true);
  assert.equal(calls, 4, 'failed reads are retryable');
});

test('missing Git method preserves owner metadata compatibility; file search refuses without fallback', async t => {
  const unavailable = Object.assign(new Error('Method not found'), { code: -32601 });
  const { workspaces } = facade(t, () => { throw unavailable; });
  await workspaces.start();
  const result = await directorySuggestions({ type: 'directory_suggestions_request', requestId: 'f', cwd: '/registered', query: 'file', includeFiles: true, includeDirectories: false }, async () => { throw unavailable; });
  assert.deepEqual(result.payload.entries, []);
  assert.equal(result.payload.error, 'Method not found');
});
