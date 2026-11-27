// Pins what alpd answers for the RPC methods no other daemon test calls (t-8cd6.5): session.log,
// session.preview, assignment.recall, registry.worktree, project.list, workspace.get,
// workspace.worktree.options/create/remove and terminal.watch/unwatch, with and without a home, and
// the user-only refusals of an agent's connection (terminal.create/attach/input, session.fork/rewind/
// reload, question.answer) over the socket.
// It guards the split of server.ts into <domain>/rpc/handlers.ts: each method keeps its answer,
// its refusal and the wrapper (registryCall, terminalCall) that words that refusal.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { initProject } from '@anhlp/alp-core/init';
import { seedLibrary } from '@anhlp/alp-core/library';
import { fakeTransport } from '../../../test/support/fake-agent.ts';
import { teardown } from '../../../test/support/teardown.ts';

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

// A connection an ALP agent opened (ALP_AGENT_SESSION at connect) is refused what only the user may
// do, before anything else is checked: alpd here has no home and no store, so the owner meets the
// next check instead (no terminals, no conversations), while the agent meets user_only first.
async function connectAs(socket: string, agent: boolean) {
  const saved = process.env.ALP_AGENT_SESSION;
  if (agent) process.env.ALP_AGENT_SESSION = '1'; else delete process.env.ALP_AGENT_SESSION;
  try { return await connect(socket, { name: 'rpc-wiring-test', version: '0' }); }
  finally { if (saved === undefined) delete process.env.ALP_AGENT_SESSION; else process.env.ALP_AGENT_SESSION = saved; }
}

test('an agent connection is refused the user-only methods before their other checks', { skip: process.platform === 'win32' ? 'unix socket path' : false }, async t => {
  const defer = teardown(t);
  const base = await mkdtemp(path.join(tmpdir(), 'alp-rpc-agent-'));
  defer(() => rm(base, { recursive: true, force: true }));
  const library = path.join(base, 'library');
  await mkdir(library, { recursive: true, mode: 0o700 });
  const runtime = createAlpRuntime({ libraryDir: library, supervisor: false, transport: fakeTransport([]) });
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(base).socket, version: 'test' });
  await server.listen();
  defer(async () => { await server.close(); await runtime.shutdown(); });
  const owner = await connectAs(daemonPaths(base).socket, false);
  defer(() => owner.close());
  await owner.request('daemon.hello', { protocolVersion: 1 });
  const agent = await connectAs(daemonPaths(base).socket, true);
  defer(() => agent.close());
  await agent.request('daemon.hello', { protocolVersion: 1 });
  const userOnly = (method: string) => ({ code: 1003, message: `${method} is the user's; this connection was opened by an ALP agent`, reason: 'user_only' });
  const noTerminals = { code: 1005, message: 'This alpd has no home: it serves no terminals', reason: 'terminal_unsupported' };
  for (const [method, params] of [['terminal.create', { workspaceId: 'w', cols: 80, rows: 24, requestId: 'c' }], ['terminal.attach', { terminalId: 'term_0123456789abcdef0123456789abcdef' }], ['terminal.input', { terminalId: 'term_0123456789abcdef0123456789abcdef', data: 'x' }]] as const) {
    assert.deepEqual(await refusal(agent.request(method, params)), userOnly(method), method);
    assert.deepEqual(await refusal(owner.request(method, params)), noTerminals, method);
  }
  for (const [method, params, owners] of [
    ['session.fork', { sessionId: 's', requestId: 'f', ifGeneration: '0123456789abcdef0123456789abcdef' }, 'This alpd does not fork conversations (capability session.fork is not listed)'],
    ['session.rewind', { sessionId: 's', requestId: 'r', ifGeneration: '0123456789abcdef0123456789abcdef', beforeTurnId: 't' }, 'This alpd does not rewind conversations (capability session.rewind is not listed)'],
    ['session.reload', { sessionId: 's', requestId: 'l', ifGeneration: '0123456789abcdef0123456789abcdef' }, 'This alpd does not reload sessions (capability session.reload is not listed)'],
  ] as const) {
    assert.deepEqual(await refusal(agent.request(method, params)), userOnly(method), method);
    assert.deepEqual(await refusal(owner.request(method, params)), { code: -32601, message: owners, reason: undefined }, method);
  }
  assert.deepEqual(await refusal(agent.request('question.answer', { questionId: 'q', text: 'yes' })), { code: 1003, message: 'Only the user answers a question; this connection was opened by an ALP agent', reason: 'user_only' });
  assert.deepEqual(await refusal(owner.request('question.answer', { questionId: 'q', text: 'yes' })), { code: 1001, message: 'No question q waits for an answer', reason: undefined });
});

// The other user-only paths of an agent's connection: session.compact and workspace.git.facts refuse
// it before any other check, and session.create opens the root without the spec.restore it sent
// (a named native thread is the owner's alone), where the owner meets the next check or is served.
test('an agent connection is refused session.compact and workspace.git.facts, and its spec.restore is dropped', { skip: process.platform === 'win32' ? 'unix socket path' : false }, async t => {
  const defer = teardown(t);
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-rpc-agent2-')));
  defer(() => rm(base, { recursive: true, force: true }));
  const library = path.join(base, 'library');
  await seedLibrary(library);
  const project = path.join(base, 'project');
  await initProject(project, { library });
  const runtime = createAlpRuntime({ libraryDir: library, supervisor: false, transport: fakeTransport([]) });
  const opened: Array<{ id: string; restore: unknown }> = [];
  const open = runtime.open.bind(runtime);
  runtime.open = (id, spec, options) => { opened.push({ id, restore: spec.restore }); return open(id, spec, options); };
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(base).socket, version: 'test' });
  await server.listen();
  defer(async () => { await server.close(); await runtime.shutdown(); });
  const owner = await connectAs(daemonPaths(base).socket, false);
  defer(() => owner.close());
  await owner.request('daemon.hello', { protocolVersion: 1 });
  const agent = await connectAs(daemonPaths(base).socket, true);
  defer(() => agent.close());
  await agent.request('daemon.hello', { protocolVersion: 1 });
  const userOnly = (method: string) => ({ code: 1003, message: `${method} is the user's; this connection was opened by an ALP agent`, reason: 'user_only' });
  assert.deepEqual(await refusal(agent.request('session.compact', { sessionId: 'none' })), userOnly('session.compact'));
  assert.deepEqual(await refusal(owner.request('session.compact', { sessionId: 'none' })), { code: 1005, message: 'The session is not open', reason: 'session_busy' });
  assert.deepEqual(await refusal(agent.request('workspace.git.facts', { directory: project })), userOnly('workspace.git.facts'));
  assert.deepEqual(await owner.request('workspace.git.facts', { directory: project }), { kind: 'unknown' });
  const made = await agent.request('session.create', { sessionId: 'ses_agent', spec: { cwd: project, workflow: 'pho', restore: { agent: 'main', threadId: 'thread-of-the-owner' } } });
  assert.equal(made.session.id, 'ses_agent');
  assert.deepEqual(opened, [{ id: 'ses_agent', restore: undefined }]);
});
