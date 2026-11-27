// Pins what alpd answers for the RPC methods no other daemon test calls (t-8cd6.5): session.log,
// session.preview, assignment.recall, registry.worktree, project.list, workspace.get,
// workspace.worktree.options/create/remove and terminal.watch/unwatch, with and without a home.
// It guards the split of server.ts into <domain>/rpc/handlers.ts: each method keeps its answer,
// its refusal and the wrapper (registryCall, terminalCall) that words that refusal.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { initProject } from '@anhlp/alp-core/init';
import { seedLibrary } from '@anhlp/alp-core/library';
import { fakeTransport } from '../../../test/support/fake-agent.ts';

// `any`: alpd's answers and JSON-RPC errors are JSON; the test reads the fields it asserts on.
type Json = any;

/** A refusal as the client sees it: code, message and reason. */
const refusal = async (request: Promise<unknown>) => {
  try { await request; } catch (error) { const e = error as Json; return { code: e.code, message: e.message, reason: e.data?.reason }; }
  assert.fail('expected a refusal');
};

async function fixture(t: TestContext, withHome: boolean) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-rpc-wiring-')));
  const home = path.join(root, 'home');
  await seedLibrary(home);
  const project = path.join(root, 'project');
  await initProject(project, { library: home });
  const runLogDir = path.join(root, 'runs');
  await mkdir(runLogDir);
  // The run log of tree r1, with a line that is not JSON: session.log skips it.
  await writeFile(path.join(runLogDir, 'r1.jsonl'), '{"event":"a"}\nnot json\n{"event":"b"}\n');
  const runtime = createAlpRuntime({ libraryDir: home, supervisor: false, transport: fakeTransport([]) });
  const daemon = createDaemonServer({ runtime, socketPath: '', version: 'test', runLogDir, ...(withHome ? { home } : {}) });
  const client = daemon.local();
  // Reverse order of setup; the directory goes last (ALP.md, node:test teardown order).
  t.after(async () => {
    const errors: unknown[] = [];
    for (const step of [() => client.close(), () => daemon.close(), () => runtime.shutdown(), () => rm(root, { recursive: true, force: true })]) {
      try { await step(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  });
  return { client, project };
}

test('session.log, session.preview and assignment.recall answer as before', async t => {
  const { client, project } = await fixture(t, false);
  assert.deepEqual(await client.request('session.log', { sessionId: 'r1' }), { rootId: 'r1', entries: [{ event: 'a' }, { event: 'b' }] });
  assert.deepEqual(await client.request('session.log', { sessionId: 'none' }), { rootId: 'none', entries: [] });
  const { preview } = await client.request('session.preview', { spec: { cwd: project, workflow: 'pho' } });
  assert.deepEqual(Object.keys(preview).sort(), ['agent', 'mode', 'model', 'runtime', 'team', 'teamLabel', 'teams', 'thinking']);
  assert.deepEqual(await refusal(client.request('assignment.recall', { assignmentId: 'x', projectRoot: 'relative', question: 'q?' })), { code: -32602, message: 'projectRoot must be absolute', reason: undefined });
  assert.deepEqual(await refusal(client.request('assignment.recall', { assignmentId: 'nope', question: 'q?' })), { code: 1000, message: 'No recallable assignment nope; assignments stay recallable for 14 days', reason: undefined });
});

test('without a home, the registry and terminal methods refuse through their wrappers', async t => {
  const { client } = await fixture(t, false);
  const noRegistry = { code: 1005, message: 'Registry needs ALP_HOME', reason: undefined };
  assert.deepEqual(await refusal(client.request('registry.worktree', {})), noRegistry);
  assert.deepEqual(await refusal(client.request('project.list', {})), noRegistry);
  assert.deepEqual(await refusal(client.request('workspace.get', { workspaceId: 'w_missing' })), noRegistry);
  assert.deepEqual(await refusal(client.request('workspace.worktree.options', { workspaceId: 'w_missing' })), noRegistry);
  assert.deepEqual(await refusal(client.request('workspace.worktree.create', { workspaceId: 'w_missing', mappingId: 'none', ifRevision: 0, requestId: 'c' })), noRegistry);
  assert.deepEqual(await refusal(client.request('workspace.worktree.remove', { workspaceId: 'w_missing', ifRevision: 0, requestId: 'r' })), noRegistry);
  const noTerminals = { code: 1005, message: 'This alpd has no home: it serves no terminals', reason: 'terminal_unsupported' };
  assert.deepEqual(await refusal(client.request('terminal.watch', { workspaceId: 'w_missing' })), noTerminals);
  assert.deepEqual(await refusal(client.request('terminal.unwatch', {})), noTerminals);
});

test('with a home, the registry, worktree and terminal methods answer as before', async t => {
  const { client, project } = await fixture(t, true);
  assert.deepEqual(await client.request('registry.worktree', {}), { mappings: [], workspaces: [] });
  await client.request('project.register', { directory: project, ifRevision: 0, requestId: 'a' });
  const listed = await client.request('project.list', {});
  assert.deepEqual({ count: listed.projects.length, root: listed.projects[0].root, total: listed.total, nextCursor: listed.nextCursor, revision: listed.revision }, { count: 1, root: project, total: 1, nextCursor: null, revision: 1 });
  const workspaceId = (await client.request('workspace.list', {})).workspaces[0].id;
  const got = await client.request('workspace.get', { workspaceId });
  assert.deepEqual({ directory: got.workspace.directory, revision: got.revision, rowRevision: got.workspace.revision }, { directory: project, revision: 1, rowRevision: 1 });
  const missing = { code: 1001, message: 'No workspace', reason: 'not_found' };
  assert.deepEqual(await refusal(client.request('workspace.get', { workspaceId: 'w_missing' })), missing);
  assert.deepEqual(await client.request('workspace.worktree.options', { workspaceId }), { mappingIds: [] });
  assert.deepEqual(await refusal(client.request('workspace.worktree.options', { workspaceId: 'w_missing' })), missing);
  if (process.platform !== 'win32') {
    assert.deepEqual(await refusal(client.request('workspace.worktree.create', { workspaceId, mappingId: 'none', ifRevision: 1, requestId: 'c' })), { code: 1003, message: 'Mapping unavailable', reason: 'outside_workspace' });
    assert.deepEqual(await refusal(client.request('workspace.worktree.remove', { workspaceId, ifRevision: 1, requestId: 'r' })), { code: 1003, message: 'Only your managed user worktrees can be removed', reason: 'not_managed' });
  }
  assert.deepEqual(await refusal(client.request('terminal.watch', { workspaceId })), { code: 1005, message: 'The host has not allowed remote terminals (alp terminal allow)', reason: 'terminal_disabled' });
  assert.deepEqual(await client.request('terminal.unwatch', {}), { closed: true });
});
