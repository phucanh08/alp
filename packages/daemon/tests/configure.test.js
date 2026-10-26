import { failCommittedMarker } from './lifecycle-marker-fault.js';
// session.configure with model, thinking or team, and session.configure.preview, in alpd
// (docs/protocol/alp-json-rpc-v1.md §12.9, issue #121 branch D): the lifecycle journal, the idle barrier,
// what the session's record keeps for a reopen, and refusals that change nothing. The runtime and its
// fake processes are real ALP code; packages/runtime tests prove the restart, test/e2e the real runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
        // As Codex: the model a thread resumes or starts with is in the answer (ThreadResumeResponse.model).
        if (method === 'thread/resume') { this.threadId = params.threadId; return { thread: { id: params.threadId }, model: params.model }; }
        if (method.startsWith('thread/')) return { thread: { id: this.threadId }, model: params?.model };
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

test('configure: after a team change the next assignment runs on the new team; an earlier assignment\'s record keeps its own', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  let calls = 0;
  // A tool call of the transport's current turn, as the model makes it.
  const tool = async (transport, name, args) => {
    const result = await transport.serverRequest('item/tool/call', { threadId: transport.threadId, turnId: transport.turnId, callId: `${name}-${++calls}`, namespace: null, tool: name, arguments: args });
    return { success: result.success, ...JSON.parse(result.contentItems[0].text) };
  };
  /** One turn of the root that delegates `agent` and waits for its handoff. */
  const delegatedTurn = async (index, agent) => {
    const main = world.transports.at(-1);
    await d.request('session.prompt', { sessionId: 'c3', clientMessageId: `c3-m${index}`, content: [{ type: 'text', text: `delegate ${agent}` }] });
    await until(() => main.turnId && main.calls.some(call => call.method === 'turn/start' && JSON.stringify(call.params.input).includes(`delegate ${agent}`)), 'turn started');
    const refused = agent === 'lead' ? await tool(main, 'alp_delegate', { agent: 'peer', task: 'Not on this team', mode: 'read-only', wait: false }) : undefined;
    const count = world.transports.length;
    const started = await tool(main, 'alp_delegate', { agent, task: `Work as ${agent}`, mode: 'read-only', wait: false });
    assert.ok(started.assignmentId, JSON.stringify(started));
    await until(() => world.transports.length > count && world.transports.at(-1).turnId, 'assignment turn started');
    const child = world.transports.at(-1);
    await tool(child, 'alp_handoff', { outcome: 'complete', summary: `Done as ${agent}` });
    child.finish();
    await tool(main, 'alp_wait', { assignments: [started.assignmentId] });
    main.finish();
    await until(async () => !(await d.request('session.get', { sessionId: 'c3' })).session.busy, 'tree idle');
    return { assignmentId: started.assignmentId, child, refused };
  };
  await d.request('session.create', { sessionId: 'c3', spec: { cwd: d.project, persist: true, model: 'codex:gpt-5.6-sol', thinking: 'medium' } });
  const pho = await delegatedTurn(0, 'peer');
  assert.match(threadCalls(pho.child)[0].params.developerInstructions, /Profile: pho; fixed for this session/);
  const result = await d.request('session.configure', { sessionId: 'c3', team: 'cafe', requestId: 'cfg-team-delegation', ifGeneration: await generationOf(d, 'c3') });
  assert.equal(result.session.workflow.mode, 'cafe');
  const cafe = await delegatedTurn(1, 'lead');
  assert.equal(cafe.refused.success, false, 'Cafe\'s main does not delegate to peer');
  assert.match(cafe.refused.error, /unauthorized target/);
  assert.match(threadCalls(cafe.child)[0].params.developerInstructions, /Profile: cafe; fixed for this session/);
  const records = async () => {
    const earlier = (await d.request('session.get', { sessionId: pho.assignmentId })).session;
    const later = (await d.request('session.get', { sessionId: cafe.assignmentId })).session;
    return { earlier, later };
  };
  const { earlier, later } = await records();
  assert.equal(earlier.parentId, 'c3');
  assert.equal(earlier.agent, 'peer');
  assert.equal(earlier.workflow.mode, 'pho', 'the earlier assignment keeps the team it ran on');
  assert.equal(later.agent, 'lead');
  assert.equal(later.workflow.mode, 'cafe');
  // And after a restart of alpd, from its store.
  await d.stop();
  const again = { ...await world.start(), ...world };
  assert.equal((await again.request('session.get', { sessionId: pho.assignmentId })).session.workflow.mode, 'pho');
  assert.equal((await again.request('session.get', { sessionId: cafe.assignmentId })).session.workflow.mode, 'cafe');
  assert.equal((await again.request('session.get', { sessionId: 'c3' })).session.workflow.mode, 'cafe');
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

test('a wake still starting its turn when configure prepare ends (a runtime whose hold keeps nothing back) is refused busy before prepared; the same request goes through later', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'cp', ['one']);
  const transport = world.transports.at(-1);
  d.runtime.hold = () => undefined;
  // The preview answers what the runtime held when it began; before it resolves, mail wakes the root and
  // the wake's turn/start is sent, but not answered, so it has no turn id yet.
  const preview = d.runtime.previewConfigure.bind(d.runtime);
  let open;
  d.runtime.previewConfigure = async (sessionId, changes) => {
    const answer = await preview(sessionId, changes);
    if (open) return answer;
    const starts = transport.calls.filter(call => call.method === 'turn/start').length;
    let resolve;
    transport.hold = new Promise(done => { resolve = done; });
    open = () => { transport.hold = undefined; resolve(); };
    await d.request('session.message', { sessionId: 'cp', text: 'mail during configure' });
    await until(() => transport.calls.filter(call => call.method === 'turn/start').length === starts + 1, 'the wake sent turn/start');
    return answer;
  };
  const change = { sessionId: 'cp', model: 'gpt-6.1-sol', requestId: 'cp1' };
  // While the wake waits, a configure that got past prepare answers at once: the runtime's own would queue
  // behind the waiting turn/start. Opened however the checks end: a turn/start left waiting would keep the
  // runtime from shutting down.
  world.native.configure = async () => { throw new Error('the configure reached the runtime while a wake started its turn'); };
  try {
    await assert.rejects(d.request('session.configure', { ...change, ifGeneration: await generationOf(d, 'cp') }), rpcError(1004, 'session_busy'));
    assert.ok(open, 'the mail went out during prepare');
    assert.equal(d.runtime.snapshot('cp').activeTurnId, undefined, 'the wake has no turn id when refused');
    assert.equal(world.native.configures.length, 0, 'the refusal never reached the runtime');
    assert.deepEqual(await journalFiles(d.state), [], 'nothing journaled');
  } finally { world.native.configure = undefined; open?.(); }
  await until(() => d.runtime.snapshot('cp')?.activeTurnId, 'the wake turn started');
  transport.finish('woken');
  await until(async () => !(await d.request('session.get', { sessionId: 'cp' })).session.activeTurnId, 'the wake turn ended');
  const result = await d.request('session.configure', { ...change, ifGeneration: await generationOf(d, 'cp') });
  assert.equal(result.session.model, 'gpt-6.1-sol');
  assert.equal(world.native.configures.length, 1);
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

test('a configure that never reached the runtime before alpd stopped stays unknown, and the record keeps its old configuration (a mode-only change too)', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'c8', ['one']);
  const before = (await d.request('session.get', { sessionId: 'c8' })).session;
  assert.equal(before.mode, 'full-access');
  // model names the current one, so only the mode changes; the runtime never hears of it.
  world.native.configure = () => new Promise(() => {});
  const params = { sessionId: 'c8', model: 'gpt-5.6-sol', mode: 'read-only', requestId: 'm-1', ifGeneration: await generationOf(d, 'c8') };
  const lost = d.request('session.configure', params).catch(error => error);
  await until(() => world.native.configures.length === 1, 'native step in flight');
  await d.stop();
  await lost;
  world.native.configure = undefined;
  const e = { ...await world.start(), ...world };
  await assert.rejects(e.request('session.configure', params), rpcError(1004, 'outcome_unknown'));
  const [entry] = await journalOf(e.state);
  assert.equal(entry.state, 'unknown');
  assert.deepEqual([entry.plan.previous.mode, entry.plan.proposed.mode], ['full-access', 'read-only']);
  await e.request('session.create', { sessionId: 'c8', spec: { cwd: e.project }, resume: true });
  const session = (await e.request('session.get', { sessionId: 'c8' })).session;
  assert.equal(session.mode, 'full-access', 'never a mode the runtime did not take');
  assert.equal(session.model, 'gpt-5.6-sol');
  assert.equal(threadCalls(world.transports.at(-1)).at(-1).params.sandbox, 'danger-full-access');
});

test('configure: Codex must say which model it continued with; without it nothing is taken', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'c9', ['one']);
  // The next process answers thread/resume without a model (as no Codex does: it is a required field).
  const index = world.transports.length;
  const push = world.transports.push;
  world.transports.push = function (transport) {
    if (this.length === index) { const request = transport.request.bind(transport); transport.request = async (method, params) => { const answer = await request(method, params); if (method === 'thread/resume') delete answer.model; return answer; }; }
    return push.call(this, transport);
  };
  await assert.rejects(d.request('session.configure', { sessionId: 'c9', model: 'gpt-6.1-sol', requestId: 'e1', ifGeneration: await generationOf(d, 'c9') }), rpcError(1005, 'native_refused'));
  world.transports.push = push;
  const session = (await d.request('session.get', { sessionId: 'c9' })).session;
  assert.equal(session.model, 'gpt-5.6-sol');
  assert.equal(threadCalls(world.transports.at(-1)).at(-1).params.model, 'gpt-5.6-sol', 'the old configuration restarted');
});

test('an unknown configure the runtime took is reconciled once into agreement, and never undoes a later configure at a later start', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'c10', ['one']);
  // A: the runtime takes model and team, then alpd stops before its commit.
  world.native.configure = async (sessionId, changes, options, reconfigure) => { await reconfigure(sessionId, changes, options); return new Promise(() => {}); };
  const lost = d.request('session.configure', { sessionId: 'c10', model: 'gpt-6.1-sol', team: 'cafe', requestId: 'A', ifGeneration: await generationOf(d, 'c10') }).catch(error => error);
  await until(async () => (await d.request('session.get', { sessionId: 'c10' })).session.model === 'gpt-6.1-sol', 'runtime took A');
  await d.stop();
  await lost;
  world.native.configure = undefined;
  const e = { ...await world.start(), ...world };
  await e.request('session.create', { sessionId: 'c10', spec: { cwd: e.project }, resume: true });
  // B, committed later: a lower mode and another effort.
  const b = await e.request('session.configure', { sessionId: 'c10', thinking: 'high', mode: 'read-only', requestId: 'B', ifGeneration: await generationOf(e, 'c10') });
  assert.deepEqual([b.session.mode, b.session.thinking, b.session.model, b.session.workflow.mode], ['read-only', 'high', 'gpt-6.1-sol', 'cafe']);
  await e.request('session.close', { sessionId: 'c10' });
  await e.stop();
  // A is still unknown in the journal at this start; B's mode and effort must survive it.
  const f = { ...await world.start(), ...world };
  assert.ok((await journalOf(f.state)).some(entry => entry.requestId.endsWith('A') && entry.state === 'unknown'));
  await f.request('session.create', { sessionId: 'c10', spec: { cwd: f.project }, resume: true });
  const session = (await f.request('session.get', { sessionId: 'c10' })).session;
  assert.deepEqual([session.mode, session.thinking, session.model, session.workflow.mode], ['read-only', 'high', 'gpt-6.1-sol', 'cafe']);
  const resume = threadCalls(world.transports.at(-1)).at(-1).params;
  assert.equal(resume.sandbox, 'read-only', 'never back to the wider mode A ran with');
  assert.equal(resume.thinking, 'high');
});

test('when the runtime took a configure but the journal could not record it, the answer is outcome_unknown and the record runs with what the runtime runs', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'c11', ['one']);
  const lifecycle = path.join(d.state, 'lifecycle');
  world.native.configure = async (sessionId, changes, options, reconfigure) => {
    const done = await reconfigure(sessionId, changes, options);
    await chmod(lifecycle, 0o500);
    return done;
  };
  try {
    await assert.rejects(d.request('session.configure', { sessionId: 'c11', model: 'gpt-6.1-sol', team: 'cafe', requestId: 'J', ifGeneration: await generationOf(d, 'c11') }), rpcError(1004, 'outcome_unknown'));
  } finally { await chmod(lifecycle, 0o700); world.native.configure = undefined; }
  const live = (await d.request('session.get', { sessionId: 'c11' })).session;
  assert.deepEqual([live.model, live.workflow.mode], ['gpt-6.1-sol', 'cafe']);
  // A reopen before alpd restarts resumes with it (the team guard does not trip).
  await d.request('session.close', { sessionId: 'c11' });
  await d.request('session.create', { sessionId: 'c11', spec: { cwd: d.project }, resume: true });
  const resume = threadCalls(world.transports.at(-1)).at(-1).params;
  assert.equal(resume.model, 'gpt-6.1-sol');
  assert.match(resume.developerInstructions, /Profile: cafe/);
});

for (const field of ['mode', 'thinking']) for (const observedFirst of [false, true]) {
  test(`historical unknown configure cannot overwrite a later accepted ${field} override (${observedFirst ? 'seen at earlier startup' : 'legacy unseen'})`, async t => {
    const world = await setup(t);
    let d = { ...await world.start(), ...world };
    await conversation(d, 'historical', ['one']);
    const override = field === 'mode' ? 'read-only' : 'high';
    const params = { sessionId: 'historical', model: 'gpt-5.6-sol', [field]: override, requestId: 'old', ifGeneration: await generationOf(d, 'historical') };
    world.native.configure = async () => { throw Object.assign(new Error('lost answer'), { outcomeUnknown: true }); };
    await assert.rejects(d.request('session.configure', params), rpcError(1004, 'outcome_unknown'));
    world.native.configure = undefined;
    if (observedFirst) {
      await d.stop();
      d = { ...await world.start(), ...world };
      await d.request('session.create', { sessionId: 'historical', spec: { cwd: d.project }, resume: true });
    }
    // The old proposal matches this independently accepted override, which is saved causally.
    if (field === 'mode') await d.request('session.configure', { sessionId: 'historical', mode: override });
    else {
      await d.request('session.close', { sessionId: 'historical' });
      await d.request('session.create', { sessionId: 'historical', spec: { cwd: d.project, thinking: override }, resume: true });
    }
    const unchanged = await d.request('session.configure', { sessionId: 'historical', model: 'gpt-5.6-sol', requestId: 'unchanged', ifGeneration: await generationOf(d, 'historical') });
    assert.equal(unchanged.configured.status, 'unchanged', 'unchanged does not apply the historical proposal');
    const generation = await generationOf(d, 'historical');
    await d.request('session.close', { sessionId: 'historical' });
    await d.stop();
    for (let restart = 0; restart < 2; restart++) {
      d = { ...await world.start(), ...world };
      assert.equal(await generationOf(d, 'historical'), generation, 'startup does not rewrite history');
      await assert.rejects(d.request('session.configure', params), rpcError(1004, 'outcome_unknown'));
      await d.request('session.create', { sessionId: 'historical', spec: { cwd: d.project }, resume: true });
      assert.equal((await d.request('session.get', { sessionId: 'historical' })).session[field], override, 'independently accepted preference remains durable');
      await d.request('session.close', { sessionId: 'historical' });
      await d.stop();
    }
    assert.equal(world.native.configures.length, 2, 'startup and repeats never resend unknown configure');
  });
}

for (const changes of [{ model: 'gpt-6.1-sol', thinking: 'high' }, { model: 'gpt-5.6-sol', mode: 'read-only' }]) {
  test(`applied configure persistence failure is unknown, never resent or rolled back (${changes.mode ? 'mode only' : 'restart'})`, async t => {
    const world = await setup(t);
    const d = { ...await world.start(), ...world };
    await conversation(d, 'failed-save', ['one']);
    const updates = [];
    const unsubscribe = d.runtime.onEvent(({ sessionId, event }) => { if (sessionId === 'failed-save' && event.type === 'session.updated') updates.push(event); });
    t.after(unsubscribe);
    const put = d.store.put.bind(d.store);
    let attempts = 0;
    d.store.put = async record => {
      if (record.id === 'failed-save' && (record.spec.thinking === 'high' || record.spec.mode === 'read-only')) { attempts++; throw new Error('configure store unavailable'); }
      return put(record);
    };
    const params = { sessionId: 'failed-save', ...changes, requestId: 'failed-save', ifGeneration: await generationOf(d, 'failed-save') };
    await assert.rejects(d.request('session.configure', params), rpcError(1004, 'outcome_unknown'));
    assert.equal(attempts, 1, 'no unowned fallback write after apply failure');
    assert.equal(updates.length, 0, 'no successful update before durable persistence');
    assert.equal((await journalOf(world.state))[0].state, 'unknown');
    const live = d.runtime.snapshot('failed-save');
    for (const [key, value] of Object.entries(changes)) assert.equal(live[key], value);
    await assert.rejects(d.request('session.configure', params), rpcError(1004, 'outcome_unknown'));
    assert.equal(world.native.configures.length, 1);
    d.store.put = put;
    const next = await d.request('session.configure', { sessionId: 'failed-save', thinking: 'low', requestId: 'new-choice', ifGeneration: await generationOf(d, 'failed-save') });
    assert.equal(next.configured.status, 'applied');
    assert.equal(next.session.thinking, 'low');
    assert.equal(world.native.configures.length, 2, 'new request remains usable');
  });
}

test('lost configure journal answer never overwrites a subsequent run-only mode update', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'legacy-order', ['one']);
  const directory = path.join(world.state, 'lifecycle');
  world.native.configure = async (sessionId, changes, options, reconfigure) => {
    const done = await reconfigure(sessionId, changes, options);
    await d.runtime.configure(sessionId, { mode: 'read-only' });
    await chmod(directory, 0o500);
    return done;
  };
  try {
    await assert.rejects(d.request('session.configure', { sessionId: 'legacy-order', model: 'gpt-6.1-sol', requestId: 'lost', ifGeneration: await generationOf(d, 'legacy-order') }), rpcError(1004, 'outcome_unknown'));
  } finally { await chmod(directory, 0o700); world.native.configure = undefined; }
  await d.store.flush();
  const record = (await d.store.list()).find(record => record.id === 'legacy-order');
  assert.equal(record.session.mode, 'read-only', 'later runtime update remains the recorded snapshot');
  assert.equal(record.spec.mode, 'full-access', 'run-only mode remains run-only');
  assert.equal(record.session.model, 'gpt-6.1-sol');
  await d.request('session.close', { sessionId: 'legacy-order' });
  await d.request('session.create', { sessionId: 'legacy-order', spec: { cwd: world.project }, resume: true });
  assert.equal(d.runtime.snapshot('legacy-order').mode, 'full-access');
});

for (const route of ['legacy-mode', 'resume-mode', 'resume-thinking']) {
  test(`persistence: ${route} survives close/reopen and daemon restart`, async t => {
    const world = await setup(t);
    const d = { ...await world.start(), ...world };
    const sessionId = route;
    await conversation(d, sessionId, []);
    const field = route === 'resume-thinking' ? 'thinking' : 'mode';
    const value = field === 'thinking' ? 'high' : 'read-only';
    if (route === 'legacy-mode') await d.request('session.configure', { sessionId, mode: value });
    else {
      await d.request('session.close', { sessionId });
      const changed = await d.request('session.create', { sessionId, resume: true, spec: { cwd: world.project, [field]: value, model: 'ignored-model' } });
      assert.equal(changed.session[field], value);
      assert.equal(changed.session.model, 'gpt-5.6-sol', 'resume does not accept a requested model');
    }
    await d.request('session.close', { sessionId });
    const reopened = await d.request('session.create', { sessionId, resume: true, spec: { cwd: world.project } });
    assert.equal(reopened.session[field], value, 'close/reopen keeps accepted configuration');
    await d.request('session.close', { sessionId });
    await d.stop();
    const e = await world.start();
    const restarted = await e.request('session.create', { sessionId, resume: true, spec: { cwd: world.project } });
    assert.equal(restarted.session[field], value, 'fresh daemon reads accepted configuration');
    assert.equal(restarted.session.model, 'gpt-5.6-sol');
  });
}

for (const route of ['legacy-mode', 'resume']) {
  test(`persistence: rejected ${route} leaves the stored spec unchanged`, async t => {
    const world = await setup(t);
    const d = { ...await world.start(), ...world };
    await conversation(d, 'refused-spec', []);
    await d.store.flush();
    const before = (await d.store.list()).find(record => record.id === 'refused-spec').spec;
    if (route === 'legacy-mode') await assert.rejects(d.request('session.configure', { sessionId: 'refused-spec', mode: 'invalid-mode' }));
    else {
      await d.request('session.close', { sessionId: 'refused-spec' });
      await assert.rejects(d.request('session.create', { sessionId: 'refused-spec', resume: true, spec: { cwd: world.project, mode: 'invalid-mode', thinking: 'high' } }));
    }
    await d.store.flush();
    assert.deepEqual((await d.store.list()).find(record => record.id === 'refused-spec').spec, before);
    if (route === 'legacy-mode') await d.request('session.close', { sessionId: 'refused-spec' });
    const opened = await d.request('session.create', { sessionId: 'refused-spec', resume: true, spec: { cwd: world.project } });
    assert.equal(opened.session.thinking, 'medium');
    assert.notEqual(opened.session.mode, 'invalid-mode');
  });
}

for (const route of ['legacy-mode', 'resume']) {
  test(`persistence: ${route} reports a store failure after apply without rollback`, async t => {
    const world = await setup(t);
    const d = { ...await world.start(), ...world };
    await conversation(d, 'unrecorded', []);
    if (route === 'resume') await d.request('session.close', { sessionId: 'unrecorded' });
    const put = d.store.put.bind(d.store);
    let appliedWrites = 0;
    d.store.put = async record => {
      if (record.id === 'unrecorded' && record.spec.mode === 'read-only') { appliedWrites++; throw new Error('store offline'); }
      return put(record);
    };
    const updates = [];
    const unsubscribe = d.runtime.onEvent(({ event }) => { if (event.type === 'session.updated') updates.push(event); });
    t.after(unsubscribe);
    const request = route === 'legacy-mode'
      ? d.request('session.configure', { sessionId: 'unrecorded', mode: 'read-only' })
      : d.request('session.create', { sessionId: 'unrecorded', resume: true, spec: { cwd: world.project, mode: 'read-only' } });
    await assert.rejects(request, error => error.data?.reason === 'persistence_failed' && /runtime already applied/.test(error.message));
    assert.equal(appliedWrites, 1);
    assert.equal(d.runtime.snapshot('unrecorded').mode, 'read-only', 'native apply is not rolled back');
    if (route === 'legacy-mode') assert.equal(updates.length, 0, 'failed persistence precedes session.updated');
    d.store.put = put;
  });
}

test('persistence: legacy mode is durably recorded before its session.updated', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'ordered-mode', []);
  const put = d.store.put.bind(d.store);
  let durable = false;
  let observed = false;
  d.store.put = async record => {
    const saving = record.id === 'ordered-mode' && record.spec.mode === 'read-only';
    await put(record);
    if (saving) durable = true;
  };
  const unsubscribe = d.runtime.onEvent(({ sessionId, event }) => {
    if (sessionId === 'ordered-mode' && event.type === 'session.updated') { observed = true; assert.equal(durable, true); }
  });
  t.after(unsubscribe);
  await d.request('session.configure', { sessionId: 'ordered-mode', mode: 'read-only' });
  assert.equal(observed, true);
});

for (const retryBeforeRestart of [false, true]) {
  test(`marker write failure (retry=${retryBeforeRestart}): old configure replay cannot undo a later configuration`, async t => {
    const world = await setup(t);
    const d = { ...await world.start(), ...world };
    await conversation(d, 'marker-config', ['one']);
    const generation = await generationOf(d, 'marker-config');
    const first = { sessionId: 'marker-config', requestId: 'marker-old', ifGeneration: generation, thinking: 'high' };
    const restore = failCommittedMarker(d.store, world.state, first.requestId);
    const original = await d.request('session.configure', first);
    assert.equal((await restore()).state, 'applied', 'actual commit succeeded but marker rename failed');
    await d.request('session.configure', { ...first, requestId: 'marker-new', thinking: 'low' });
    if (retryBeforeRestart) {
      const repeat = await d.request('session.configure', first);
      assert.equal(repeat.duplicate, true);
      assert.deepEqual(repeat.configured, original.configured);
      assert.equal(repeat.session.thinking, 'low');
    }
    await d.stop();
    const restarted = { ...await world.start(), ...world };
    assert.equal((await restarted.request('session.get', { sessionId: first.sessionId })).session.thinking, 'low');
    const repeat = await restarted.request('session.configure', first);
    assert.equal(repeat.duplicate, true);
    assert.deepEqual(repeat.configured, original.configured, 'receipt describes the original native outcome');
    assert.equal(repeat.session.thinking, 'low');
    assert.equal(world.native.configures.length, 2, 'restart/retry sends no native mutation');
    await restarted.stop();
    const again = await world.start();
    assert.equal((await again.request('session.get', { sessionId: first.sessionId })).session.thinking, 'low');
  });
}

test('an unfinished configure store commit blocks later native mutations and retries real work', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'unfinished-config', ['one']);
  const first = { sessionId: 'unfinished-config', requestId: 'unfinished', ifGeneration: await generationOf(d, 'unfinished-config'), thinking: 'high' };
  await d.store.flush();
  const put = d.store.put;
  let failed = false;
  d.store.put = async record => {
    // Reject every snapshot carrying this commit, including queued event saves. Awaiting
    // a journal read here lets such a save publish the shared record's witness, correctly
    // allowing later work despite the original put failure (covered separately below).
    if (Object.values(record.lifecycleCommits ?? {}).some(receipt => receipt.requestId === first.requestId)) {
      failed = true;
      throw new Error('final record put refused');
    }
    return put(record);
  };
  await assert.rejects(d.request('session.configure', first), rpcError(1000, 'persistence_failed'));
  assert.equal(failed, true);
  assert.equal(Object.values((await d.store.get(first.sessionId)).lifecycleCommits ?? {}).some(receipt => receipt.requestId === first.requestId), false, 'no queued save durably completed the commit');
  await assert.rejects(d.request('session.configure', { ...first, requestId: 'later', thinking: 'low' }), rpcError(1000, 'persistence_failed'));
  assert.equal((await journalOf(world.state)).some(entry => entry.requestId === 'later'), false, 'barrier refuses before preparing a new native attempt');
  assert.equal(world.native.configures.length, 1, 'later native operation stays behind incomplete commit');
  d.store.put = put;
  const result = await d.request('session.configure', first);
  assert.equal(result.duplicate, undefined, 'unwritten witness is not success');
  assert.equal(world.native.configures.length, 1);
  await d.request('session.configure', { ...first, requestId: 'later', thinking: 'low' });
  await d.stop();
  const restarted = await world.start();
  assert.equal((await restarted.request('session.get', { sessionId: first.sessionId })).session.thinking, 'low');
});

test('retained completion witness cannot complete a reused requestId attempt', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'reuse-config', ['one']);
  const params = { sessionId: 'reuse-config', requestId: 'reuse', ifGeneration: await generationOf(d, 'reuse-config'), thinking: 'high' };
  const restore = failCommittedMarker(d.store, world.state, params.requestId);
  await d.request('session.configure', params);
  const old = await restore();
  await d.request('session.configure', { ...params, requestId: 'middle', thinking: 'low' });
  assert.equal(Object.keys((await d.store.get(params.sessionId)).lifecycleCommits).length, 2, 'pending marker witness retained');
  // Terminal retention permits key reuse. Simulate expiration while its harmless witness remains.
  await rm(path.join(world.state, 'lifecycle', `${old.key}.json`));
  const put = d.store.put;
  d.store.put = async record => {
    if ((await journalOf(world.state)).some(entry => entry.requestId === params.requestId && entry.state === 'applied')) throw new Error('new attempt final put failed');
    return put(record);
  };
  await assert.rejects(d.request('session.configure', params), rpcError(1000, 'persistence_failed'));
  const applied = (await journalOf(world.state)).find(entry => entry.requestId === params.requestId);
  assert.notEqual(applied.attemptId, old.attemptId);
  // Even two attempts with the same millisecond timestamp must remain distinct.
  applied.createdAt = old.createdAt;
  await writeFile(path.join(world.state, 'lifecycle', `${applied.key}.json`), JSON.stringify(applied));
  d.store.put = put;
  const retried = await d.request('session.configure', params);
  assert.equal(retried.duplicate, undefined, 'old attempt receipt cannot bypass incomplete new commit');
  assert.equal(world.native.configures.length, 3);
  assert.equal(retried.session.thinking, 'high');
  await d.request('session.configure', { ...params, requestId: 'cleanup', thinking: 'low' });
  assert.equal(Object.keys((await d.store.get(params.sessionId)).lifecycleCommits).length, 1, 'committed witnesses compact on the next commit');
});

test('a queued record save completing after commit failure keeps its durable witness through later saves', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'queued-witness', ['one']);
  const params = { sessionId: 'queued-witness', requestId: 'queued-old', ifGeneration: await generationOf(d, 'queued-witness'), thinking: 'high' };
  const put = d.store.put;
  let queued;
  d.store.put = async record => {
    if ((await journalOf(world.state)).some(entry => entry.requestId === params.requestId && entry.state === 'applied')) {
      // An event save has captured the full completed mutation before its original caller fails.
      queued = put(record);
      throw new Error('original record write failed while event save was queued');
    }
    return put(record);
  };
  await assert.rejects(d.request('session.configure', params), rpcError(1000, 'persistence_failed'));
  await queued;
  d.store.put = put;
  const [witness] = Object.values((await d.store.get(params.sessionId)).lifecycleCommits);
  assert.equal(witness.result.configured.effective.thinking, 'high');
  await d.request('session.configure', { ...params, requestId: 'queued-new', thinking: 'low' });
  await d.stop();
  const restarted = await world.start();
  assert.equal((await restarted.request('session.get', { sessionId: params.sessionId })).session.thinking, 'low');
  const repeat = await restarted.request('session.configure', params);
  assert.equal(repeat.configured.effective.thinking, 'high');
  assert.equal(repeat.session.thinking, 'low');
});

test('legacy applied configure with newer journal evidence stays unfinished without undoing later state', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'legacy-config', ['one']);
  const params = { sessionId: 'legacy-config', requestId: 'legacy-old', ifGeneration: await generationOf(d, 'legacy-config'), thinking: 'high' };
  const restore = failCommittedMarker(d.store, world.state, params.requestId);
  await d.request('session.configure', params);
  const old = await restore();
  await d.request('session.configure', { ...params, requestId: 'legacy-new', thinking: 'low' });
  await d.stop();
  const record = await d.store.get(params.sessionId);
  delete record.lifecycleCommits;
  await d.store.put(record);
  delete old.attemptId;
  await writeFile(path.join(world.state, 'lifecycle', `${old.key}.json`), JSON.stringify(old));
  const restarted = await world.start();
  assert.equal((await restarted.request('session.get', { sessionId: params.sessionId })).session.thinking, 'low');
  await assert.rejects(restarted.request('session.configure', params), rpcError(1000, 'persistence_failed'));
  assert.equal((await journalOf(world.state)).find(entry => entry.key === old.key).state, 'applied');
  assert.equal(world.native.configures.length, 2);
});
