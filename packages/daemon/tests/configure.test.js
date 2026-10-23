// session.configure with model, thinking or team, and session.configure.preview, in alpd
// (docs/protocol/alp-json-rpc-v1.md §12.9, issue #121 branch D): the lifecycle journal, the idle barrier,
// what the session's record keeps for a reopen, and refusals that change nothing. The runtime and its
// fake processes are real ALP code; packages/runtime tests prove the restart, test/e2e the real runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { validateParams, validateResult } from '@anhlp/alp-protocol/contract';

async function until(check, what = 'condition') {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} did not happen`);
}

/** A scripted native runtime: each turn/start answers a new turn id; finish() completes the latest. */
function fakeTransport(transports) {
  return () => {
    const index = transports.length;
    let turns = 0;
    const transport = {
      calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() {},
      async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/resume') { this.threadId = params.threadId; return { thread: { id: params.threadId } }; }
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { await this.hold; this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        if (method === 'turn/interrupt') { queueMicrotask(() => this.notification('turn/completed', { threadId: this.threadId, turn: { id: params.turnId, status: 'interrupted' } })); return {}; }
        return {};
      },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `out-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    transports.push(transport);
    return transport;
  };
}

/** A daemon with a real store; `start()` again on the same directory is a restart. The runtime's native fork is scripted. */
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-conversation-'));
  const project = path.join(directory, 'project');
  await initProject(project);
  const transports = [];
  const stops = [];
  t.after(async () => { for (const stop of stops.reverse()) await stop(); await rm(directory, { recursive: true, force: true }); });
  const state = path.join(directory, 'state');
  const native = { configures: [], configure: undefined };
  let count = 0;
  async function start() {
    const runtime = createAlpRuntime({ supervisor: false, transport: fakeTransport(transports), runLogDir: path.join(directory, 'runs') });
    // The runtime's own reconfigure (restarting a fake process), or a scripted one.
    const reconfigure = runtime.reconfigure;
    runtime.reconfigure = async (sessionId, changes, options) => {
      native.configures.push({ sessionId, changes, options });
      return native.configure ? native.configure(sessionId, changes, options, reconfigure) : reconfigure(sessionId, changes, options);
    };
    const store = createStore(state);
    const socketPath = daemonPaths(path.join(directory, `d${count++}`)).socket;
    const server = createDaemonServer({ runtime, socketPath, version: 'test', store });
    await server.listen();
    const clients = [];
    const open = async () => {
      const client = await connect(socketPath, { name: 'test', version: '0' });
      const events = [];
      client.onEvent(envelope => events.push(envelope));
      clients.push(client);
      return { client, events, request: (method, params) => client.request(method, params) };
    };
    let stopped = false;
    const stop = async () => { if (stopped) return; stopped = true; clients.forEach(client => client.close()); await store.flush().catch(() => {}); await server.close().catch(() => {}); await runtime.shutdown(); };
    stops.push(stop);
    const first = await open();
    await first.request('daemon.status');
    return { runtime, store, server, open, stop, ...first };
  }
  return { directory, project, state, transports, native, start };
}

/** Opens a persistent root and runs `texts` as completed turns; answers the turn ids in order. */
async function conversation(d, sessionId, texts) {
  await d.request('session.create', { sessionId, spec: { cwd: d.project ?? d.cwd, persist: true, model: 'codex:gpt-5.6-sol', thinking: 'medium' } });
  const turns = [];
  for (const [index, text] of texts.entries()) {
    const transport = d.transports.at(-1);
    await d.request('session.prompt', { sessionId, clientMessageId: `${sessionId}-m${index}`, content: [{ type: 'text', text }] });
    await until(() => transport.turnId && !turns.includes(transport.turnId), 'turn started');
    turns.push(transport.turnId);
    transport.finish(`answer ${index}`);
    await until(async () => !(await d.request('session.get', { sessionId })).session.activeTurnId, 'turn ended');
  }
  return turns;
}

const generationOf = async (d, sessionId) => (await d.request('session.history', { sessionId, limit: 1 })).generation;
const rpcError = (code, reason) => error => error.code === code && error.data?.reason === reason;
const journalFiles = async state => (await readdir(path.join(state, 'lifecycle')).catch(() => [])).filter(name => name.endsWith('.json'));
const journalOf = async state => Promise.all((await journalFiles(state)).map(async name => JSON.parse(await readFile(path.join(state, 'lifecycle', name), 'utf8'))));
const threadCalls = transport => transport.calls.filter(call => call.method.startsWith('thread/'));

test('configure: model and effort change on the same conversation; the record keeps them through close, reopen and a restart of alpd', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const hello = await d.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(hello.capabilities.includes('session.configure.live'));
  await conversation(d, 'c1', ['one']);
  const before = (await d.request('session.get', { sessionId: 'c1' })).session;
  assert.equal(before.conversation.configure, true);
  assert.equal(before.model, 'gpt-5.6-sol');
  const preview = await d.request('session.configure.preview', { sessionId: 'c1', model: 'codex:gpt-6.1-sol', thinking: 'high' });
  validateResult('session.configure.preview', preview);
  assert.deepEqual(preview.preview.changes, ['model', 'thinking']);
  assert.equal(preview.preview.allowed, true);
  const generation = await generationOf(d, 'c1');
  const params = { sessionId: 'c1', model: 'codex:gpt-6.1-sol', thinking: 'high', requestId: 'cfg-1', ifGeneration: generation };
  assert.deepEqual(validateParams('session.configure', params), []);
  const processes = world.transports.length;
  const result = await d.request('session.configure', params);
  assert.deepEqual(validateResult('session.configure', result), []);
  assert.equal(result.duplicate, undefined);
  assert.equal(result.configured.status, 'applied');
  assert.equal(result.configured.restarted, true);
  assert.deepEqual(result.configured.requested, { model: 'codex:gpt-6.1-sol', thinking: 'high' });
  assert.equal(result.configured.effective.model, 'gpt-6.1-sol');
  assert.equal(result.session.model, 'gpt-6.1-sol');
  assert.equal(result.session.thinking, 'high');
  assert.equal(result.session.threadId, before.threadId, 'same conversation');
  assert.equal(world.transports.length, processes + 1, 'one new native process');
  assert.deepEqual(threadCalls(world.transports.at(-1)).map(call => [call.method, call.params.threadId, call.params.model, call.params.thinking]), [['thread/resume', before.threadId, 'gpt-6.1-sol', 'high']]);
  assert.equal(await generationOf(d, 'c1'), generation, 'history untouched');
  // A repeat answers the first result and restarts nothing; other parameters under the id conflict.
  const repeat = await d.request('session.configure', params);
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.configured.effective.model, 'gpt-6.1-sol');
  assert.equal(world.native.configures.length, 1);
  await assert.rejects(d.request('session.configure', { ...params, thinking: 'low' }), rpcError(1004, 'key_conflict'));
  // The next turn runs on the new model.
  const transport = world.transports.at(-1);
  await d.request('session.prompt', { sessionId: 'c1', clientMessageId: 'c1-m1', content: [{ type: 'text', text: 'two' }] });
  await until(() => transport.calls.some(call => call.method === 'turn/start'), 'turn in the new process');
  const turn = transport.calls.find(call => call.method === 'turn/start').params;
  assert.equal(turn.model, 'gpt-6.1-sol');
  assert.equal(turn.effort, 'high');
  transport.finish();
  await until(async () => !(await d.request('session.get', { sessionId: 'c1' })).session.activeTurnId, 'turn ended');
  // Close and reopen: the same model and effort.
  await d.request('session.close', { sessionId: 'c1' });
  await d.request('session.create', { sessionId: 'c1', spec: { cwd: d.project }, resume: true });
  const reopened = threadCalls(world.transports.at(-1));
  assert.deepEqual(reopened.map(call => [call.method, call.params.threadId, call.params.model, call.params.thinking]), [['thread/resume', before.threadId, 'gpt-6.1-sol', 'high']]);
  // A restart of alpd: the record says the same.
  await d.request('session.close', { sessionId: 'c1' });
  await d.stop();
  const e = { ...await world.start(), ...world };
  await e.request('session.create', { sessionId: 'c1', spec: { cwd: e.project }, resume: true });
  const session = (await e.request('session.get', { sessionId: 'c1' })).session;
  assert.equal(session.model, 'gpt-6.1-sol');
  assert.equal(session.thinking, 'high');
  assert.equal(threadCalls(world.transports.at(-1)).at(-1).params.model, 'gpt-6.1-sol');
});

test('configure: a team change runs the new team from the same conversation, and a reopen keeps it', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'c2', ['one']);
  const before = (await d.request('session.get', { sessionId: 'c2' })).session;
  assert.equal(before.workflow.mode, 'pho');
  const preview = (await d.request('session.configure.preview', { sessionId: 'c2', team: 'cafe' })).preview;
  assert.deepEqual(preview.changes, ['team']);
  assert.deepEqual(preview.proposed.delegates, ['lead', 'oracle', 'reviewer']);
  assert.ok(preview.teams.some(team => team.id === 'cafe' && team.label === 'Cafe'));
  const result = await d.request('session.configure', { sessionId: 'c2', team: 'cafe', requestId: 'cfg-team', ifGeneration: await generationOf(d, 'c2') });
  assert.equal(result.session.workflow.mode, 'cafe');
  assert.equal(result.session.teamLabel, 'Cafe');
  assert.equal(result.session.model, before.model, 'the model stays');
  assert.match(threadCalls(world.transports.at(-1))[0].params.developerInstructions, /Profile: cafe; fixed for this session/);
  await d.request('session.close', { sessionId: 'c2' });
  await d.request('session.create', { sessionId: 'c2', spec: { cwd: d.project }, resume: true });
  const reopened = (await d.request('session.get', { sessionId: 'c2' })).session;
  assert.equal(reopened.workflow.mode, 'cafe');
  assert.equal(reopened.teamLabel, 'Cafe');
  assert.match(threadCalls(world.transports.at(-1))[0].params.developerInstructions, /Profile: cafe/);
});

test('configure refusals record nothing and change nothing: stale view, a running turn, a question, another runtime, more permissions, an unknown team', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'c3', ['one']);
  const generation = await generationOf(d, 'c3');
  const ask = (params, extra = {}) => d.request('session.configure', { sessionId: 'c3', ifGeneration: generation, ...params, ...extra });
  await assert.rejects(ask({ model: 'gpt-6.1-sol', requestId: 'r1', ifGeneration: 'f'.repeat(32) }), rpcError(1004, 'stale_generation'));
  await assert.rejects(ask({ model: 'claude:claude-opus-5-5', requestId: 'r2' }), error => error.code === 1005 && error.data?.reason === 'runtime_mismatch' && error.data?.action === 'session.create');
  await assert.rejects(ask({ model: 'gpt-made-up', requestId: 'r3' }), rpcError(-32602, 'invalid_params'));
  await assert.rejects(ask({ team: 'nonesuch', requestId: 'r4' }), rpcError(1001, 'team_not_found'));
  await assert.rejects(d.request('session.configure', { sessionId: 'nobody', model: 'gpt-6.1-sol', requestId: 'r5', ifGeneration: generation }), rpcError(1001, 'not_found'));
  await assert.rejects(d.request('session.configure', { sessionId: 'c3', model: 'gpt-6.1-sol' }), error => error.code === -32602);
  // A running turn.
  const transport = world.transports.at(-1);
  await d.request('session.prompt', { sessionId: 'c3', clientMessageId: 'c3-busy', content: [{ type: 'text', text: 'busy' }] });
  await until(() => transport.calls.filter(call => call.method === 'turn/start').length === 2, 'second turn');
  await assert.rejects(ask({ model: 'gpt-6.1-sol', requestId: 'r6' }), rpcError(1004, 'session_busy'));
  // A question to the user, asked inside that turn.
  void transport.serverRequest('item/tool/call', { threadId: transport.threadId, turnId: transport.turnId, callId: 'ask-1', namespace: null, tool: 'alp_ask', arguments: { question: 'Which?', options: ['A', 'B'] } });
  await until(async () => (await d.request('question.list', {})).questions?.some(question => question.rootId === 'c3'), 'question asked');
  await assert.rejects(ask({ model: 'gpt-6.1-sol', requestId: 'r7' }), rpcError(1004, 'session_busy'));
  const preview = (await d.request('session.configure.preview', { sessionId: 'c3', model: 'gpt-6.1-sol' })).preview;
  assert.equal(preview.allowed, false);
  assert.equal(preview.reason, 'session_busy');
  assert.equal(world.native.configures.length, 0, 'no refusal reached the runtime');
  assert.deepEqual(await journalFiles(d.state), [], 'nothing journaled');
  const session = (await d.request('session.get', { sessionId: 'c3' })).session;
  assert.equal(session.model, 'gpt-5.6-sol');
  assert.equal(session.thinking, 'medium');
  // A closed root is opened first.
  await d.request('session.close', { sessionId: 'c3' });
  await assert.rejects(ask({ model: 'gpt-6.1-sol', requestId: 'r8', ifGeneration: await generationOf(d, 'c3') }), rpcError(1005, 'session_closed'));
});

test('configure: a native refusal keeps the old configuration and is the answer of every repeat; a new requestId may try again', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'c4', ['one']);
  const generation = await generationOf(d, 'c4');
  world.native.configure = async () => { const error = new Error('Codex continued the conversation with gpt-5.6-sol, not gpt-6.1-sol'); error.data = { reason: 'native_refused' }; throw error; };
  const params = { sessionId: 'c4', model: 'gpt-6.1-sol', requestId: 'n1', ifGeneration: generation };
  await assert.rejects(d.request('session.configure', params), rpcError(1005, 'native_refused'));
  await assert.rejects(d.request('session.configure', params), rpcError(1005, 'native_refused'));
  assert.equal(world.native.configures.length, 1, 'the native step is never sent twice');
  assert.equal((await d.request('session.get', { sessionId: 'c4' })).session.model, 'gpt-5.6-sol');
  const [entry] = await journalOf(d.state);
  assert.equal(entry.state, 'failed');
  world.native.configure = undefined;
  const result = await d.request('session.configure', { ...params, requestId: 'n2' });
  assert.equal(result.session.model, 'gpt-6.1-sol');
});

test('configure in flight when alpd stops is outcome_unknown after the restart, never sent again; the record runs with all of what the runtime took, or none', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'c5', ['one']);
  const generation = await generationOf(d, 'c5');
  // The runtime takes it (its session.updated reaches the record), then alpd stops before its commit.
  world.native.configure = async (sessionId, changes, options, reconfigure) => { await reconfigure(sessionId, changes, options); return new Promise(() => {}); };
  const lost = d.request('session.configure', { sessionId: 'c5', model: 'gpt-6.1-sol', team: 'cafe', requestId: 'u1', ifGeneration: generation }).catch(error => error);
  await until(async () => (await d.request('session.get', { sessionId: 'c5' })).session.model === 'gpt-6.1-sol', 'runtime took it');
  await d.stop();
  await lost;
  world.native.configure = undefined;
  const e = { ...await world.start(), ...world };
  await assert.rejects(e.request('session.configure', { sessionId: 'c5', model: 'gpt-6.1-sol', team: 'cafe', requestId: 'u1', ifGeneration: generation }), rpcError(1004, 'outcome_unknown'));
  assert.equal(world.native.configures.length, 1);
  // Reconciled: the record runs with the new model and team throughout, so the root reopens with them.
  await e.request('session.create', { sessionId: 'c5', spec: { cwd: e.project }, resume: true });
  const session = (await e.request('session.get', { sessionId: 'c5' })).session;
  assert.equal(session.model, 'gpt-6.1-sol');
  assert.equal(session.workflow.mode, 'cafe');
  assert.match(threadCalls(world.transports.at(-1))[0].params.developerInstructions, /Profile: cafe/);
});

test('mail that wakes the root while a configure reads its history waits for the new process; the configure is not refused busy', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'c6', ['one']);
  const generation = await generationOf(d, 'c6');
  const old = world.transports.at(-1);
  const timeline = d.store.timeline.bind(d.store);
  let sent = false;
  d.store.timeline = async sessionId => {
    if (sessionId === 'c6' && !sent) {
      sent = true;
      await d.request('session.message', { sessionId: 'c6', text: 'mail during configure' });
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return timeline(sessionId);
  };
  const result = await d.request('session.configure', { sessionId: 'c6', model: 'gpt-6.1-sol', requestId: 'm1', ifGeneration: generation });
  d.store.timeline = timeline;
  assert.ok(sent);
  assert.equal(result.session.model, 'gpt-6.1-sol');
  assert.equal(old.calls.filter(call => call.method === 'turn/start').length, 1, 'no wake turn on the old process');
  const fresh = world.transports.at(-1);
  assert.notEqual(fresh, old);
  await until(() => fresh.calls.some(call => call.method === 'turn/start' && JSON.stringify(call.params).includes('mail during configure')), 'the mail reached the new process');
  assert.equal(fresh.calls.find(call => call.method === 'turn/start').params.model, 'gpt-6.1-sol');
});

test('configure of a root with no turn yet starts its conversation anew with the new model; mode alone stays the old method', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await d.request('session.create', { sessionId: 'c7', spec: { cwd: d.project, persist: true, model: 'codex:gpt-5.6-sol' } });
  const result = await d.request('session.configure', { sessionId: 'c7', model: 'gpt-6.1-sol', requestId: 'f1', ifGeneration: await generationOf(d, 'c7') });
  assert.equal(result.session.model, 'gpt-6.1-sol');
  assert.deepEqual(threadCalls(world.transports.at(-1)).map(call => call.method), ['thread/start']);
  const mode = await d.request('session.configure', { sessionId: 'c7', mode: 'read-only' });
  assert.equal(mode.session.mode, 'read-only');
  assert.equal(mode.configured, undefined);
});
