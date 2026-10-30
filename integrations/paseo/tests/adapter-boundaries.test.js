import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaces } from '../server/dist/paseo/workspaces.js';
import { directorySuggestions, fileExplorer } from '../server/dist/paseo/files.js';

const registry = { projects: [{ id: 'p', root: '/registered', addedAt: 'old' }], workspaces: [{ id: 'w', projectId: 'p', directory: '/registered', labels: [], createdAt: 'old' }], sessions: {}, labels: { generation: 'g', seq: 0, catalog: [] } };
const state = { state: 'repository', branch: 'from-daemon', remoteUrl: 'https://host/repo', dirty: true };
function facade(t, status) {
  const calls = [];
  const workspaces = createWorkspaces({ rpc: async (method, params) => {
    calls.push([method, params]);
    if (method === 'registry.owner') return { registry: structuredClone(registry) };
    if (method === 'workspace.git.status') return status();
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

test('normal search ranks every page alpd answers; a refusal never reads local files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'local-secret.txt'), 'local');
  const request = { type: 'directory_suggestions_request', requestId: 'f', cwd: root, query: 'intro', includeFiles: true, includeDirectories: false };
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    return params.cursor ? { entries: [{ path: 'intro.md', kind: 'file' }] } : { entries: [{ path: 'docs/intro.md', kind: 'file' }], nextCursor: 'c1' };
  };
  const result = await directorySuggestions(request, rpc);
  assert.deepEqual(result.payload.entries, [{ path: 'intro.md', kind: 'file' }, { path: 'docs/intro.md', kind: 'file' }], 'the best match came on the last page');
  assert.deepEqual(calls, [
    ['workspace.files.find', { projectRoot: root, query: 'intro', kinds: ['file'], matchMode: 'subsequence' }],
    ['workspace.files.find', { projectRoot: root, query: 'intro', kinds: ['file'], matchMode: 'subsequence', cursor: 'c1' }],
  ]);
  const denied = await directorySuggestions({ ...request, query: 'secret' }, async () => { throw Object.assign(new Error('grant denied'), { code: 1003 }); });
  assert.deepEqual(denied.payload.entries, []);
  assert.equal(denied.payload.error, 'grant denied');
});

test('truncated answers, suffix, directory and empty-query modes are alpd\'s only: no local fallback', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-adapter-large-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'intro.md'), 'legacy');
  const request = { type: 'directory_suggestions_request', requestId: 'f', cwd: root, query: 'intro', includeFiles: true, includeDirectories: false };
  const calls = [];
  const rpc = async (method, params) => { calls.push([method, params]); return { entries: [], truncated: true }; };
  assert.deepEqual((await directorySuggestions(request, rpc)).payload, { requestId: 'f', directories: [], entries: [], error: null }, 'what alpd did not answer is not looked for on disk');
  assert.deepEqual((await directorySuggestions({ ...request, query: 'docs/intro.md', matchMode: 'suffix' }, rpc)).payload.entries, []);
  assert.deepEqual((await directorySuggestions({ ...request, query: 'docs', includeFiles: false, includeDirectories: true }, rpc)).payload.entries, []);
  assert.deepEqual((await directorySuggestions({ ...request, query: '' }, rpc)).payload.entries, []);
  assert.deepEqual((await directorySuggestions({ ...request, query: 'x'.repeat(250), matchMode: 'suffix' }, rpc)).payload.entries, []);
  assert.deepEqual(calls, [
    ['workspace.files.find', { projectRoot: root, query: 'intro', kinds: ['file'], matchMode: 'subsequence' }],
    ['workspace.files.find', { projectRoot: root, query: 'docs/intro.md', kinds: ['file'], matchMode: 'suffix' }],
    ['workspace.files.find', { projectRoot: root, query: 'docs', kinds: ['directory'], matchMode: 'subsequence' }],
    ['workspace.files.list', { projectRoot: root, includeIgnored: true, internalLinks: true }],
    // A query longer than alpd takes: its first 200 characters in order, which every match holds.
    ['workspace.files.find', { projectRoot: root, query: 'x'.repeat(200), kinds: ['file'], matchMode: 'subsequence' }],
  ]);
  // The host's folders: alpd's answer, or its error.
  const host = [];
  const found = await directorySuggestions({ type: 'directory_suggestions_request', requestId: 'h', query: '~/Co', limit: 5 }, async (method, params) => { host.push([method, params]); return { entries: [{ path: '/home/u/Code' }] }; });
  assert.deepEqual([found.payload.entries, found.payload.directories, host], [[{ path: '/home/u/Code', kind: 'directory' }], ['/home/u/Code'], [['host.directories.search', { query: '~/Co', limit: 5 }]]]);
  const lost = await directorySuggestions({ type: 'directory_suggestions_request', requestId: 'h', query: 'Code' }, async () => { throw new Error('ALP daemon is not connected'); });
  assert.deepEqual([lost.payload.entries, lost.payload.error], [[], 'ALP daemon is not connected']);
});

test('the Files panel reads only through alpd: a refusal or a lost daemon is the error, never a local read', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-adapter-explorer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'README.md'), 'LOCAL-ONLY');
  const explore = (message, rpc) => fileExplorer({ type: 'file_explorer_request', requestId: 'e', cwd: root, ...message }, rpc);
  for (const [error, shown] of [
    [Object.assign(new Error('grant denied'), { code: 1003, data: { reason: 'blocked_path' } }), 'grant denied'],
    [Object.assign(new Error('No readable file or directory at README.md'), { code: 1001, data: { reason: 'not_found' } }), 'No such file or directory'],
    [Object.assign(new Error('README.md is larger than 3 bytes'), { code: 1000, data: { reason: 'too_large' } }), 'File is too large to display'],
    [Object.assign(new Error('link leads outside'), { code: 1003, data: { reason: 'outside' } }), 'Access outside of workspace is not allowed'],
    [new Error('ALP daemon is not connected'), 'ALP daemon is not connected'],
  ]) {
    for (const mode of ['list', 'file']) {
      const { payload } = await explore({ path: 'README.md', mode }, async () => { throw error; });
      assert.deepEqual([payload.error, payload.file, payload.directory], [shown, null, null], `${mode}: ${shown}`);
    }
  }
  const calls = [];
  const outside = await explore({ path: '../elsewhere', mode: 'file' }, async (...call) => { calls.push(call); });
  assert.equal(outside.payload.error, 'Access outside of workspace is not allowed');
  assert.deepEqual(calls, [], 'a path that leaves the workspace is refused before alpd');
  // A chunked preview: every chunk of the first one's revision, then the app's one file.
  const chunks = [];
  const preview = await explore({ path: 'big.log', mode: 'file', maxBytes: 10 * 1024 * 1024 * 1024 }, async (method, params) => {
    chunks.push(params);
    return params.offset ? { path: 'big.log', kind: 'text', mimeType: 'text/plain', size: 4, modifiedAt: 'm', revision: 'r1', encoding: 'base64', content: Buffer.from('cd').toString('base64'), offset: 2 }
      : { path: 'big.log', kind: 'text', mimeType: 'text/plain', size: 4, modifiedAt: 'm', revision: 'r1', encoding: 'base64', content: Buffer.from('ab').toString('base64'), offset: 0, nextOffset: 2 };
  });
  assert.deepEqual(preview.payload.file, { path: 'big.log', size: 4, modifiedAt: 'm', revision: 'r1', kind: 'text', encoding: 'utf-8', content: 'abcd', mimeType: 'text/plain' });
  assert.deepEqual(chunks, [
    { projectRoot: root, includeIgnored: true, internalLinks: true, path: 'big.log', maxBytes: 50 * 1024 * 1024 },
    { projectRoot: root, includeIgnored: true, internalLinks: true, path: 'big.log', maxBytes: 50 * 1024 * 1024, offset: 2, revision: 'r1' },
  ], 'at most 50 MiB whatever the app asks');
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
