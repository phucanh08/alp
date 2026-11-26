// The bridge's first attach of a root races a rewind (docs/protocol/alp-json-rpc-v1.md §12.7, §66; task
// t-15b0.20, issue #121 C): the bridge reads the root's history, then attaches after its tip under its
// generation. A rewind in between leaves that history stale. alpd answers the attach either with 1004
// stale_cursor (the generation changed) or with `reset: true` and the whole timeline replayed from its
// start. Either way the bridge reads the history again and attaches anew: the timeline it keeps and
// serves is the rewound conversation, each item once, with the live events after the attach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { createAgents } from '../server/dist/paseo/agents.js';

const directory = {
  load: async () => {}, prepare: async () => {}, workspaceIdFor: () => 'workspace',
  placement: () => ({ projectKey: 'p', projectName: 'p', directory: '/' }), assign: async () => {}, changed: () => {},
};

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
      threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() {},
      async request(method, params) {
        if (method === 'thread/resume') { this.threadId = params.threadId; return { thread: { id: params.threadId } }; }
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      finish(text) {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `out-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    transports.push(transport);
    return transport;
  };
}

/** A real alpd with a store, whose runtime's native rewind (branch, rebind) is scripted. */
async function daemon(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'paseo-attach-reset-'));
  const project = path.join(dir, 'project');
  await initProject(project);
  const transports = [];
  const runtime = createAlpRuntime({ supervisor: false, transport: fakeTransport(transports), runLogDir: path.join(dir, 'runs') });
  let branches = 0;
  runtime.branch = async () => ({ threadId: `thread-branch-${++branches}` });
  runtime.rebind = async sessionId => runtime.snapshot(sessionId);
  const store = createStore(path.join(dir, 'state'));
  const socketPath = daemonPaths(path.join(dir, 'd')).socket;
  const server = createDaemonServer({ runtime, socketPath, version: 'test', store });
  await server.listen();
  const client = await connect(socketPath, { name: 'test', version: '0' });
  t.after(async () => { client.close(); await store.flush().catch(() => {}); await server.close().catch(() => {}); await runtime.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const request = (method, params) => client.request(method, params);
  /** Runs one completed turn of `text` on the root; answers its turn id. */
  async function turn(sessionId, text, answer) {
    const transport = transports.at(-1);
    const before = transport.turnId;
    await request('session.prompt', { sessionId, clientMessageId: `${sessionId}-${text}`, content: [{ type: 'text', text }] });
    await until(() => transport.turnId && transport.turnId !== before, 'turn started');
    const id = transport.turnId;
    transport.finish(answer);
    await until(async () => !(await request('session.get', { sessionId })).session.activeTurnId, 'turn ended');
    return id;
  }
  return { project, socketPath, request, turn };
}

/** What Paseo shows of a timeline entry: its kind and its text. */
const shown = entries => entries.map(({ item }) => `${item.type}:${item.text ?? item.message}`);
/** The same for alpd's own history: the root's message and notice items. */
const historyShown = items => items.filter(item => item.event?.type === 'item').map(({ event: { item } }) =>
  item.kind === 'user_message' ? `user_message:${item.text}` : item.kind === 'assistant_message' ? `assistant_message:${item.text}` : `notification:${item.text}`);
const timeline = (agents, agentId) => agents.handlers.fetch_agent_timeline_request({ type: 'fetch_agent_timeline_request', agentId, requestId: `timeline-${Math.random()}`, direction: 'tail', limit: 200 });

test('a rewind between the bridge\'s history read and its attach: the bridge reads the rewound history, each item once', async t => {
  const d = await daemon(t);
  await d.request('session.create', { sessionId: 'r1', spec: { cwd: d.project, persist: true } });
  await d.turn('r1', 'one', 'answer one');
  const second = await d.turn('r1', 'two', 'answer two');
  await d.turn('r1', 'three', 'answer three');

  // The bridge's connection to alpd, held at its first attach of r1: its history read is done by then.
  let reached; const atAttach = new Promise(resolve => { reached = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  let held = false;
  const clientFactory = async onEvent => {
    const client = await connect(d.socketPath, { name: 'paseo-bridge', version: '0' });
    client.onEvent(onEvent);
    return {
      get capabilities() { return client.capabilities; },
      get closed() { return client.closed; },
      onEvent: listener => client.onEvent(listener), onClose: listener => client.onClose(listener), close: () => client.close(),
      async request(method, params) {
        if (method === 'session.attach' && params?.sessionId === 'r1' && !held) { held = true; reached(params); await gate; }
        return client.request(method, params);
      },
    };
  };
  const frames = [];
  const agents = createAgents({ clientFactory, broadcast: frame => frames.push(frame), directory });
  t.after(() => agents.close());
  await agents.start();
  const attach = await atAttach;
  assert.equal(typeof attach.generation, 'string', 'the bridge attaches under the generation it read');

  // A Paseo client opens the agent while the bridge waits; another client rewinds in that window.
  const opened = timeline(agents, 'r1');
  const { generation } = await d.request('session.history', { sessionId: 'r1', limit: 1 });
  assert.equal(generation, attach.generation);
  const rewound = await d.request('session.rewind', { sessionId: 'r1', requestId: 'rw-1', ifGeneration: generation, beforeTurnId: second });
  release();

  const { payload } = await opened;
  assert.equal(payload.error, null, 'the open succeeds');
  const expected = historyShown((await d.request('session.history', { sessionId: 'r1' })).items);
  assert.deepEqual(expected.slice(0, 2), ['user_message:one', 'assistant_message:answer one']);
  assert.match(expected.at(-1), /Files were not changed/);
  assert.deepEqual(shown(payload.entries), expected, 'the rewound conversation, each item once');

  // Live events after the attach reach the timeline, and Paseo clients, once.
  await d.turn('r1', 'four', 'answer four');
  await until(async () => shown((await timeline(agents, 'r1')).payload.entries).includes('assistant_message:answer four'), 'live answer in the timeline');
  const after = (await timeline(agents, 'r1')).payload;
  assert.deepEqual(shown(after.entries), [...expected, 'user_message:four', 'assistant_message:answer four']);
  assert.equal(after.epoch, payload.epoch, 'one timeline epoch');
  const streamed = frames.filter(frame => frame.type === 'agent_stream' && frame.payload.agentId === 'r1' && frame.payload.event.type === 'timeline').map(frame => frame.payload.event.item);
  assert.deepEqual(shown(streamed.map(item => ({ item }))), ['user_message:four', 'assistant_message:answer four'], 'clients were sent only the live items');
  assert.ok(rewound.generation !== generation);
});

/**
 * alpd's other answer to a stale view: `reset: true` after replaying the whole timeline from its start
 * (server.ts session.attach). An injected connection stands in for alpd, so the answer is exact: the
 * bridge read a tail page holding a turn the rewind set aside; the attach replays the current timeline
 * and answers reset. The bridge must not keep the stale page nor append the replay on top of it.
 */
test('an attach that answers reset makes the bridge read the history again, without the stale page or a doubled replay', async t => {
  const STALE = 'a'.repeat(32);
  const CURRENT = 'b'.repeat(32);
  const env = (cursor, item) => ({ sessionId: 'r1', epoch: 'e', seq: cursor, ts: '2026-10-23T00:00:00.000Z', cursor, event: { type: 'item', item } });
  const user = (cursor, text) => env(cursor, { kind: 'user_message', id: `user:${text}`, clientMessageId: text, text });
  const answer = (cursor, text) => env(cursor, { kind: 'assistant_message', id: `out:${text}`, text });
  // The conversation now: the first turn and the rewind's marker. The stale page: the turns it set aside.
  const current = [user(1, 'one'), answer(2, 'answer one'), env(9, { kind: 'notice', id: 'rewind:br', level: 'info', text: 'Conversation rewound' })];
  const stalePage = { generation: STALE, hasOlder: true, olderCursor: 'older', tipCursor: 8, items: [user(5, 'three'), answer(6, 'answer three')] };
  const currentPage = { generation: CURRENT, hasOlder: false, tipCursor: 9, items: current };
  const live = answer(10, 'live');
  const session = { id: 'r1', projectRoot: '/work', agent: 'main', runtime: 'codex', model: 'gpt-5.5', mode: 'workspace-write', thinking: 'medium', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, threadId: 't', persistent: true, busy: false, status: 'idle' };
  const calls = [];
  let listener = () => {};
  let histories = 0;
  const connection = {
    capabilities: ['session.history', 'session.rewind'],
    onEvent: () => {}, onClose: () => {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.list') return { sessions: [session] };
      if (method === 'question.list') return { questions: [] };
      if (method === 'session.history') {
        if (histories++ === 0) return stalePage;
        // The reset attach left the connection attached: a live event comes while the history is read again.
        listener(live);
        return currentPage;
      }
      if (method === 'session.attach') {
        if (params.generation === STALE) { for (const envelope of current) listener(envelope); return { session, cursor: 9, reset: true }; }
        // Attached after the current tip: its replay brings the live event again.
        for (const envelope of [...current, live]) if (envelope.cursor > params.after) listener(envelope);
        return { session, cursor: 10 };
      }
      throw new Error(`unexpected request ${method}`);
    },
  };
  const agents = createAgents({ clientFactory: async onEvent => { listener = onEvent; return connection; }, broadcast: () => {}, directory });
  t.after(() => agents.close());
  await agents.start();
  const { payload } = await timeline(agents, 'r1');
  assert.equal(payload.error, null);
  // The current conversation, then the live event, each once and in cursor order.
  assert.deepEqual(shown(payload.entries), ['user_message:one', 'assistant_message:answer one', 'notification:Conversation rewound', 'assistant_message:live']);
  assert.equal(payload.hasOlder, false, 'the current history has nothing older; the stale page\'s cursor is gone');
  assert.deepEqual(calls.filter(call => call.method === 'session.attach').map(call => call.params.generation), [STALE, CURRENT], 'attached again under the history read after the reset');
});

test('without durable history, the attach\'s replay and the live events after it reach the timeline', async t => {
  const session = { id: 'r1', projectRoot: '/work', agent: 'main', runtime: 'codex', model: 'gpt-5.5', mode: 'workspace-write', thinking: 'medium', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, threadId: 't', persistent: true, busy: false, status: 'idle' };
  const env = (cursor, text) => ({ sessionId: 'r1', epoch: 'e', seq: cursor, ts: '2026-10-23T00:00:00.000Z', cursor, event: { type: 'item', item: { kind: 'assistant_message', id: `out:${text}`, text } } });
  let listener = () => {};
  const connection = {
    capabilities: [],
    onEvent: () => {}, onClose: () => {}, close() {},
    async request(method, params) {
      if (method === 'session.list') return { sessions: [session] };
      if (method === 'question.list') return { questions: [] };
      if (method === 'session.attach') { assert.equal(params.after, undefined); listener(env(1, 'replayed')); setTimeout(() => listener(env(2, 'live')), 0); return { session, cursor: 1 }; }
      throw new Error(`unexpected request ${method}`);
    },
  };
  const agents = createAgents({ clientFactory: async onEvent => { listener = onEvent; return connection; }, broadcast: () => {}, directory });
  t.after(() => agents.close());
  await agents.start();
  assert.deepEqual(shown((await timeline(agents, 'r1')).payload.entries), ['assistant_message:replayed']);
  await until(async () => shown((await timeline(agents, 'r1')).payload.entries).length === 2, 'live event');
  assert.deepEqual(shown((await timeline(agents, 'r1')).payload.entries), ['assistant_message:replayed', 'assistant_message:live']);
});

/**
 * A re-read on a connection that is already attached (after a reset answer, as after history.reset):
 * alpd keeps sending it live events while the history is read and while the attach awaits its store.
 * An event the attach replays may thus come after a later live one; the bridge applies them in cursor
 * order, once. A history.reset that comes before the attach's answer is not lost: the bridge reads again.
 */
function attachedWorld({ duringAttach }) {
  const STALE = 'a'.repeat(32);
  const CURRENT = 'b'.repeat(32);
  const env = (cursor, item) => ({ sessionId: 'r1', epoch: 'e', seq: cursor, ts: '2026-10-23T00:00:00.000Z', cursor, event: { type: 'item', item } });
  const answer = (cursor, text) => env(cursor, { kind: 'assistant_message', id: `out:${text}`, text });
  const current = [env(1, { kind: 'user_message', id: 'user:one', clientMessageId: 'one', text: 'one' }), answer(2, 'answer one')];
  const session = { id: 'r1', projectRoot: '/work', agent: 'main', runtime: 'codex', model: 'gpt-5.5', mode: 'workspace-write', thinking: 'medium', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, threadId: 't', persistent: true, busy: false, status: 'idle' };
  const world = { calls: [], live: [answer(3, 'three'), answer(4, 'four')], generations: [STALE, CURRENT], histories: 0, listener: () => {} };
  const connection = {
    capabilities: ['session.history'],
    onEvent: () => {}, onClose: () => {}, close() {},
    async request(method, params) {
      world.calls.push({ method, params });
      if (method === 'session.list') return { sessions: [session] };
      if (method === 'question.list') return { questions: [] };
      if (method === 'session.history') {
        const generation = world.generations[Math.min(world.histories++, world.generations.length - 1)];
        return { generation, hasOlder: false, tipCursor: 2, items: current };
      }
      if (method === 'session.attach') {
        if (params.generation === STALE) return { session, cursor: 2, reset: true };
        return duringAttach(world, params);
      }
      throw new Error(`unexpected request ${method}`);
    },
  };
  world.agents = createAgents({ clientFactory: async onEvent => { world.listener = onEvent; return connection; }, broadcast: () => {}, directory });
  return world;
}

test('on an attached connection, live events and the attach\'s replay apply in cursor order, once', async t => {
  const world = attachedWorld({
    duringAttach(world, params) {
      // Four comes live while alpd's attach awaits its store; then the replay brings three and four.
      world.listener(world.live[1]);
      for (const envelope of world.live) if (envelope.cursor > params.after) world.listener(envelope);
      return { session: {}, cursor: 4 };
    },
  });
  t.after(() => world.agents.close());
  await world.agents.start();
  const { payload } = await timeline(world.agents, 'r1');
  assert.equal(payload.error, null);
  assert.deepEqual(shown(payload.entries), ['user_message:one', 'assistant_message:answer one', 'assistant_message:three', 'assistant_message:four']);
});

test('a history.reset that comes before the attach\'s answer makes the bridge read the history again', async t => {
  const NEXT = 'c'.repeat(32);
  let resets = 0;
  const world = attachedWorld({
    duringAttach(world, params) {
      // A rewind commits after the attach checked its generation: its history.reset precedes the answer.
      if (resets++ === 0) { world.generations.push(NEXT); world.listener({ sessionId: 'r1', epoch: 'rewind-br', seq: 0, ts: '2026-10-23T00:00:00.000Z', event: { type: 'history.reset', generation: NEXT, reason: 'rewind', branchId: 'br' } }); }
      return { session: {}, cursor: params.after };
    },
  });
  t.after(() => world.agents.close());
  await world.agents.start();
  assert.equal((await timeline(world.agents, 'r1')).payload.error, null);
  await until(() => world.calls.filter(call => call.method === 'session.attach').at(-1)?.params.generation === NEXT, 'an attach under the generation after the reset');
});

test('team members that open while the bridge holds a root\'s events keep theirs: timeline, description, status', async t => {
  const root = { id: 'r1', projectRoot: '/work', agent: 'main', runtime: 'codex', model: 'gpt-5.5', mode: 'workspace-write', thinking: 'medium', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, threadId: 't', persistent: true, busy: false, status: 'idle' };
  const env = (cursor, sessionId, event) => ({ sessionId, epoch: 'e', seq: cursor, ts: '2026-10-23T00:00:00.000Z', cursor, event });
  const opened = (cursor, id, parentId) => env(cursor, id, { type: 'session.opened', session: { ...root, id, parentId, rootId: 'r1', agent: id === 'c1' ? 'peer' : 'reviewer' }, cwd: '/work', effective: { model: 'gpt-5.5', thinking: 'medium' } });
  const say = (cursor, sessionId, kind, text) => env(cursor, sessionId, { type: 'item', item: kind === 'user_message' ? { kind, id: `user:${text}`, text } : { kind, id: `out:${text}`, text } });
  // The tree after the page's tip: a member opens, works, opens one of its own, and ends its turn.
  const after = [
    opened(2, 'c1', 'r1'), say(3, 'c1', 'user_message', 'review this'), say(4, 'c1', 'assistant_message', 'child says hi'),
    opened(5, 'g1', 'c1'), say(6, 'g1', 'assistant_message', 'grandchild says hi'),
    env(7, 'c1', { type: 'turn.ended', turnId: 'c1-turn', state: 'completed' }),
  ];
  const later = say(8, 'c1', 'assistant_message', 'later');
  const shapes = {
    // A first attach: alpd replays what follows the page, then live events come after its answer, whose
    // cursor (the tip when it attached) is below theirs (§8.3).
    first(listener, params) { for (const envelope of after) if (envelope.cursor > params.after) listener(envelope); setTimeout(() => listener(later), 0); return 7; },
    // An attached connection (a re-read): live events come in cursor order while alpd's attach awaits its
    // store, then its replay brings them again.
    attached(listener, params) { for (const envelope of [...after, later]) listener(envelope); for (const envelope of [...after, later]) if (envelope.cursor > params.after) listener(envelope); return 8; },
  };
  for (const [name, deliver] of Object.entries(shapes)) {
    let listener = () => {};
    const connection = {
      capabilities: ['session.history'],
      onEvent: () => {}, onClose: () => {}, close() {},
      async request(method, params) {
        if (method === 'session.list') return { sessions: [root] };
        if (method === 'question.list') return { questions: [] };
        if (method === 'session.history') return { generation: 'a'.repeat(32), hasOlder: false, tipCursor: 1, items: [say(1, 'r1', 'user_message', 'one')] };
        if (method === 'session.attach') return { session: root, cursor: deliver(listener, params) };
        throw new Error(`unexpected request ${method}`);
      },
    };
    const agents = createAgents({ clientFactory: async onEvent => { listener = onEvent; return connection; }, broadcast: () => {}, directory });
    try {
      await agents.start();
      const list = await agents.handlers['agent.provider_subagents.list.request']({ type: 'agent.provider_subagents.list.request', requestId: 'l', parentAgentId: 'r1' });
      assert.equal(list.payload.error, null, name);
      const byId = Object.fromEntries(list.payload.subagents.map(subagent => [subagent.id, subagent]));
      assert.deepEqual(Object.keys(byId).sort(), ['c1', 'g1'], name);
      assert.equal(byId.c1.description, 'review this', name);
      assert.equal(byId.g1.parentSubagentId, 'c1', name);
      const rows = async subagentId => shown((await agents.handlers['agent.provider_subagents.timeline.get.request']({ type: 'agent.provider_subagents.timeline.get.request', requestId: subagentId, parentAgentId: 'r1', subagentId, direction: 'tail', limit: 50 })).payload.rows);
      await until(async () => (await rows('c1')).length === 3, `${name}: the live item`);
      assert.deepEqual(await rows('c1'), ['user_message:review this', 'assistant_message:child says hi', 'assistant_message:later'], name);
      assert.deepEqual(await rows('g1'), ['assistant_message:grandchild says hi'], name);
      // The member's turn ended before its later item: the turn.ended was not lost.
      assert.equal(byId.c1.status, 'completed', name);
    } finally { agents.close(); }
  }
});
