// The bridge's re-attach of a root after a reconnect or a history.reset, and the team members of its tree
// (task t-b589, issue #121). The bridge knows a root's tree from alpd's session list, not from the tail
// page of its history: a member that opened before the page and is silent in it still has its later
// events, and a re-attach keeps every member's timeline. An attach a later one replaced leaves the later
// one's state alone and resolves with it. alpd's history_gap answer makes the bridge read again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} did not happen`);
}

/** What Paseo shows of a timeline entry: its kind and its text. */
const shown = entries => entries.map(({ item }) => `${item.type}:${item.text ?? item.message ?? item.items?.map(entry => entry.text).join(',')}`);
const timeline = (agents, agentId) => agents.handlers.fetch_agent_timeline_request({ type: 'fetch_agent_timeline_request', agentId, requestId: `timeline-${Math.random()}`, direction: 'tail', limit: 500 });
const subagents = async (agents, parentAgentId) => (await agents.handlers['agent.provider_subagents.list.request']({ type: 'agent.provider_subagents.list.request', requestId: `list-${Math.random()}`, parentAgentId })).payload;
const subagentRows = async (agents, parentAgentId, subagentId) => {
  const { payload } = await agents.handlers['agent.provider_subagents.timeline.get.request']({ type: 'agent.provider_subagents.timeline.get.request', requestId: `rows-${Math.random()}`, parentAgentId, subagentId, direction: 'tail', limit: 500 });
  return payload.error ? [`error:${payload.error}`] : shown(payload.rows);
};
const agentRow = async (agents, agentId) => (await agents.handlers.fetch_agent_request({ type: 'fetch_agent_request', requestId: `agent-${Math.random()}`, agentId })).payload.agent;

/** A scripted native runtime per session: tools are called and items told as the test says. */
function fakeTransport(runtimes) {
  return () => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
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
      call(tool, args) {
        return this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}-${Math.random()}`, namespace: null, tool, arguments: args });
      },
      say(text) { this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `out-${index}-${Math.random()}`, text } }); },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

/**
 * A real alpd with a store. Its root `r1` delegates to a lead that stays at work; then the root says
 * more than a history page holds, so the page's tail no longer has the lead's opening.
 */
async function treeDaemon(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'paseo-reattach-'));
  const project = path.join(dir, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'], lead: ['peer'] } }));
  const runtimes = [];
  const runtime = createAlpRuntime({ supervisor: false, transport: fakeTransport(runtimes), runLogDir: path.join(dir, 'runs') });
  const store = createStore(path.join(dir, 'state'));
  const socketPath = daemonPaths(path.join(dir, 'd')).socket;
  const server = createDaemonServer({ runtime, socketPath, version: 'test', store });
  await server.listen();
  const client = await connect(socketPath, { name: 'test', version: '0' });
  const events = [];
  client.onEvent(envelope => events.push(envelope));
  t.after(async () => { client.close(); await store.flush().catch(() => {}); await server.close().catch(() => {}); await runtime.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const request = (method, params) => client.request(method, params);
  await request('session.create', { sessionId: 'r1', spec: { cwd: project, persist: true } });
  await request('session.attach', { sessionId: 'r1' });
  await request('session.prompt', { sessionId: 'r1', clientMessageId: 'go', content: [{ type: 'text', text: 'Delegate' }] });
  await until(() => runtimes[0].turnId, 'root turn');
  void runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Investigate' }).catch(() => {});
  await until(() => runtimes[1]?.turnId && events.some(envelope => envelope.event.type === 'session.opened' && envelope.event.session.parentId === 'r1'), 'lead turn');
  const lead = events.find(envelope => envelope.event.type === 'session.opened' && envelope.event.session.parentId === 'r1').sessionId;
  /** Waits until alpd's history of r1 holds `count` more events than it did. */
  const settled = async () => { const tip = async () => (await request('session.history', { sessionId: 'r1', limit: 1 })).tipCursor; let last = -1; for (;;) { const now = await tip(); if (now === last) return now; last = now; await new Promise(resolve => setTimeout(resolve, 20)); } };
  await settled();
  for (let i = 0; i < 210; i++) runtimes[0].say(`root note ${i}`);
  await settled();
  return { socketPath, request, runtimes, events, lead, settled };
}

/** The bridge on its own connection to alpd; `drop()` closes that connection as a lost socket would. */
function bridge(t, socketPath) {
  const clients = [];
  const clientFactory = async onEvent => {
    const client = await connect(socketPath, { name: 'paseo-bridge', version: '0' });
    client.onEvent(onEvent);
    clients.push(client);
    return client;
  };
  const frames = [];
  const agents = createAgents({ clientFactory, broadcast: frame => frames.push(frame), directory });
  t.after(() => agents.close());
  return { agents, frames, drop: () => clients.at(-1).close(), connections: () => clients.length };
}

test('a member that opened before the history page and is silent in it keeps its later events, and its own members theirs', async t => {
  const d = await treeDaemon(t);
  const page = await d.request('session.history', { sessionId: 'r1' });
  assert.ok(!page.items.some(item => item.sessionId === d.lead), 'the lead is silent in the tail page');
  const { agents } = bridge(t, d.socketPath);
  await agents.start();
  assert.equal((await timeline(agents, 'r1')).payload.error, null);
  const listed = await subagents(agents, 'r1');
  assert.deepEqual(listed.subagents.map(subagent => subagent.id), [d.lead], 'the working lead is the root\'s subagent');

  // The lead speaks, and delegates to a peer of its own that speaks.
  d.runtimes[1].say('lead says hi');
  void d.runtimes[1].call('alp_delegate', { agent: 'peer', wait: true, task: 'Check' }).catch(() => {});
  await until(() => d.runtimes[2]?.turnId && d.events.some(envelope => envelope.event.type === 'session.opened' && envelope.event.session.parentId === d.lead), 'peer turn');
  d.runtimes[2].say('peer says hi');
  await until(async () => (await subagentRows(agents, 'r1', d.lead)).includes('assistant_message:lead says hi'), 'the lead\'s item in its timeline');
  const peer = d.events.find(envelope => envelope.event.type === 'session.opened' && envelope.event.session.parentId === d.lead).sessionId;
  await until(async () => (await subagentRows(agents, 'r1', peer)).includes('assistant_message:peer says hi'), 'the peer\'s item in its timeline');
  const after = Object.fromEntries((await subagents(agents, 'r1')).subagents.map(subagent => [subagent.id, subagent]));
  assert.equal(after[peer].parentSubagentId, d.lead);
});

test('a reconnect re-attaches a root whose tail page holds an item of a known member opened before the page', async t => {
  const d = await treeDaemon(t);
  d.runtimes[1].say('lead before the bridge');
  await d.settled();
  const page = await d.request('session.history', { sessionId: 'r1' });
  assert.ok(page.items.some(item => item.sessionId === d.lead), 'the tail page holds the lead\'s item');
  assert.ok(!page.items.some(item => item.sessionId === d.lead && item.event.type === 'session.opened'), 'but not its opening');
  const { agents, drop, connections } = bridge(t, d.socketPath);
  await agents.start();
  assert.equal((await timeline(agents, 'r1')).payload.error, null);
  assert.deepEqual(await subagentRows(agents, 'r1', d.lead), ['assistant_message:lead before the bridge']);
  const before = (await timeline(agents, 'r1')).payload;
  const childEpoch = async () => (await agents.handlers['agent.provider_subagents.timeline.get.request']({ type: 'agent.provider_subagents.timeline.get.request', requestId: 'epoch', parentAgentId: 'r1', subagentId: d.lead, direction: 'tail', limit: 1 })).payload.epoch;
  const memberEpoch = await childEpoch();

  drop();
  await until(() => connections() === 2, 'the bridge reconnects');
  await until(async () => (await timeline(agents, 'r1')).payload.epoch !== before.epoch, 'a new timeline epoch');
  const { payload } = await timeline(agents, 'r1');
  assert.equal(payload.error, null, 'the re-attach succeeds');
  assert.deepEqual(shown(payload.entries), shown(before.entries), 'the same root timeline');
  assert.deepEqual(await subagentRows(agents, 'r1', d.lead), ['assistant_message:lead before the bridge'], 'the member\'s item is kept');
  assert.notEqual(await childEpoch(), memberEpoch, 'the member\'s timeline starts over with the root\'s, as clients reset theirs');
  d.runtimes[1].say('lead after the reconnect');
  await until(async () => (await subagentRows(agents, 'r1', d.lead)).includes('assistant_message:lead after the reconnect'), 'the lead\'s live item after the reconnect');
});

// Injected connections stand in for alpd where its answer must be exact.
const ROOT = { id: 'r1', projectRoot: '/work', agent: 'main', runtime: 'codex', model: 'gpt-5.5', mode: 'workspace-write', thinking: 'medium', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, threadId: 't', persistent: true, busy: false, status: 'idle' };
const G1 = 'a'.repeat(32);
const G2 = 'b'.repeat(32);
const env = (cursor, sessionId, event) => ({ sessionId, epoch: 'e', seq: cursor, ts: `2026-10-23T00:00:${String(cursor).padStart(2, '0')}.000Z`, ...(cursor !== undefined ? { cursor } : {}), event });
const say = (cursor, text, sessionId = 'r1') => env(cursor, sessionId, { type: 'item', item: { kind: 'assistant_message', id: `out:${text}`, text } });
const opened = (cursor, id, parentId = 'r1') => env(cursor, id, { type: 'session.opened', session: { ...ROOT, id, parentId, agent: 'peer' }, cwd: '/work', effective: { model: 'gpt-5.5', thinking: 'medium' } });
const started = (cursor, turnId) => env(cursor, 'r1', { type: 'turn.started', turnId });
const ended = (cursor, turnId, state = 'completed') => env(cursor, 'r1', { type: 'turn.ended', turnId, state });

/**
 * A scripted alpd connection. `history(call)` and `attach(params, call, listener)` answer by call number;
 * `sessions` is what session.list answers.
 */
function scripted({ capabilities = ['session.history'], sessions = [ROOT], history, attach, extra = () => undefined }) {
  const world = { calls: [], listener: () => {}, sessions };
  let histories = 0;
  let attaches = 0;
  const connection = {
    capabilities,
    onEvent: () => {}, onClose: () => {}, close() {},
    async request(method, params) {
      world.calls.push({ method, params });
      if (method === 'session.list') return { sessions: params?.rootsOnly ? world.sessions.filter(session => !session.parentId) : world.sessions };
      if (method === 'question.list') return { questions: [] };
      if (method === 'session.get') return { session: world.sessions.find(session => session.id === params.sessionId) };
      if (method === 'session.history') return history(histories++, params);
      if (method === 'session.attach') return attach(params, attaches++, world.listener);
      const answer = await extra(method, params);
      if (answer !== undefined) return answer;
      throw new Error(`unexpected request ${method}`);
    },
  };
  const frames = [];
  world.agents = createAgents({ clientFactory: async onEvent => { world.listener = onEvent; return connection; }, broadcast: frame => frames.push(frame), directory });
  world.frames = frames;
  return world;
}

test('alpd\'s history_gap answer to an attach makes the bridge read the history again', async t => {
  const world = scripted({
    sessions: [{ ...ROOT, status: 'closed' }],
    history: () => ({ generation: G1, hasOlder: false, tipCursor: 1, items: [say(1, 'one')] }),
    attach(params, call) {
      if (call === 0) throw Object.assign(new Error('History advanced beyond replay coverage; retry attach'), { code: 1005, data: { reason: 'history_gap' } });
      return { session: ROOT, cursor: 1 };
    },
  });
  t.after(() => world.agents.close());
  await world.agents.start();
  const { payload } = await timeline(world.agents, 'r1');
  assert.equal(payload.error, null);
  assert.deepEqual(shown(payload.entries), ['assistant_message:one']);
  assert.equal(world.calls.filter(call => call.method === 'session.history').length, 2, 'read again');
});

test('without a history page, the attach\'s replay and live events on an attached connection apply once', async t => {
  // A todo list is shown again at each event: an event applied twice shows twice.
  const say = (cursor, text) => env(cursor, 'r1', { type: 'item', item: { kind: 'todo', id: 'plan', items: [{ id: 's', text, status: 'pending' }] } });
  const world = scripted({
    capabilities: [],
    sessions: [{ ...ROOT, status: 'closed' }],
    history: () => { throw new Error('no history'); },
    attach(params, call, listener) {
      // An attached connection: a live event comes before the replay that brings it again.
      if (call === 0) { listener(say(1, 'one')); listener(say(2, 'two')); return { session: ROOT, cursor: 2 }; }
      listener(say(3, 'three'));
      for (const envelope of [say(1, 'one'), say(2, 'two'), say(3, 'three')]) listener(envelope);
      return { session: ROOT, cursor: 3 };
    },
    extra: method => method === 'session.create' ? {} : undefined,
  });
  t.after(() => world.agents.close());
  await world.agents.start();
  assert.deepEqual(shown((await timeline(world.agents, 'r1')).payload.entries), ['todo:one', 'todo:two']);
  // A Paseo Reload re-attaches on the same connection; then a replay of what came before arrives live.
  await world.agents.handlers.refresh_agent_request({ type: 'refresh_agent_request', agentId: 'r1', requestId: 'reload' });
  await until(async () => shown((await timeline(world.agents, 'r1')).payload.entries).length >= 3, 'the re-attach');
  world.listener(say(2, 'two'));
  world.listener(say(4, 'four'));
  await until(async () => shown((await timeline(world.agents, 'r1')).payload.entries).includes('todo:four'), 'the live item');
  assert.deepEqual(shown((await timeline(world.agents, 'r1')).payload.entries), ['todo:one', 'todo:two', 'todo:three', 'todo:four']);
});

for (const outcome of ['page', 'error']) test(`an attach a later one replaced while it read the history applies nothing of its ${outcome}`, async t => {
  let releaseFirst; const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let reachedFirst; const atFirst = new Promise(resolve => { reachedFirst = resolve; });
  const world = scripted({
    sessions: [{ ...ROOT, status: 'closed' }],
    async history(call) {
      if (call === 0) { reachedFirst(); await firstGate; if (outcome === 'error') throw Object.assign(new Error('connection lost'), { code: -32000 }); return { generation: G1, hasOlder: true, olderCursor: 'old', tipCursor: 7, items: [say(6, 'stale six'), say(7, 'stale seven')] }; }
      return { generation: G2, hasOlder: false, tipCursor: 2, items: [say(1, 'one'), say(2, 'two')] };
    },
    async attach(params) {
      if (params.generation === G1) throw Object.assign(new Error('History generation changed'), { code: 1004, data: { reason: 'stale_cursor' } });
      return { session: ROOT, cursor: 2 };
    },
    extra: method => method === 'session.create' ? {} : undefined,
  });
  t.after(() => world.agents.close());
  await world.agents.start();
  const first = timeline(world.agents, 'r1');
  await atFirst;
  await world.agents.handlers.refresh_agent_request({ type: 'refresh_agent_request', agentId: 'r1', requestId: 'reload' });
  await until(async () => world.calls.filter(call => call.method === 'session.attach').length === 1, 'the later attach');
  const later = (await timeline(world.agents, 'r1')).payload;
  assert.deepEqual(shown(later.entries), ['assistant_message:one', 'assistant_message:two']);
  releaseFirst();
  const { payload } = await first;
  assert.equal(payload.error, null, 'the replaced attach\'s awaiter gets the later timeline');
  assert.deepEqual(shown(payload.entries), ['assistant_message:one', 'assistant_message:two'], 'nothing of the replaced attach\'s page');
  assert.equal(payload.hasOlder, false, 'nor its older cursor');
  assert.equal(world.calls.filter(call => call.method === 'session.attach').length, 1, 'the replaced attach never attaches');
});

test('an attach a later one replaced while it attached throws nothing to its awaiters on stale_cursor or reset', async t => {
  for (const answer of ['stale_cursor', 'reset']) {
    let releaseAttach; const attachGate = new Promise(resolve => { releaseAttach = resolve; });
    let reachedAttach; const atAttach = new Promise(resolve => { reachedAttach = resolve; });
    const world = scripted({
      sessions: [{ ...ROOT, status: 'closed' }],
      history: call => call === 0 ? { generation: G1, hasOlder: false, tipCursor: 1, items: [say(1, 'one')] } : { generation: G2, hasOlder: false, tipCursor: 2, items: [say(1, 'one'), say(2, 'two')] },
      async attach(params) {
        if (params.generation === G1) {
          reachedAttach(); await attachGate;
          if (answer === 'reset') return { session: ROOT, cursor: 2, reset: true };
          throw Object.assign(new Error('History generation changed'), { code: 1004, data: { reason: 'stale_cursor' } });
        }
        return { session: ROOT, cursor: 2 };
      },
      extra: method => method === 'session.create' ? {} : undefined,
    });
    try {
      await world.agents.start();
      const first = timeline(world.agents, 'r1');
      await atAttach;
      await world.agents.handlers.refresh_agent_request({ type: 'refresh_agent_request', agentId: 'r1', requestId: 'reload' });
      await until(async () => world.calls.filter(call => call.method === 'session.attach').length === 2, `${answer}: the later attach`);
      releaseAttach();
      const { payload } = await first;
      assert.equal(payload.error, null, answer);
      assert.deepEqual(shown(payload.entries), ['assistant_message:one', 'assistant_message:two'], answer);
      assert.equal(world.calls.filter(call => call.method === 'session.history').length, 2, `${answer}: the replaced attach does not read again`);
    } finally { world.agents.close(); }
  }
});

test('a rewind drops the members of the branch it set aside', async t => {
  const NEXT = 'c'.repeat(32);
  const kept = opened(2, 'c-kept');
  const gone = opened(4, 'c-gone');
  const sessions = [ROOT, { ...kept.event.session, status: 'closed' }, { ...gone.event.session, status: 'closed' }];
  const world = scripted({
    sessions,
    history: call => call === 0
      ? { generation: G1, hasOlder: false, tipCursor: 6, items: [say(1, 'one'), kept, say(3, 'kept says hi', 'c-kept'), gone, say(5, 'gone says hi', 'c-gone'), say(6, 'kept, set aside', 'c-kept')] }
      // The rewind kept what lay before cursor 4 and added its marker.
      : { generation: NEXT, hasOlder: false, tipCursor: 9, items: [say(1, 'one'), kept, say(3, 'kept says hi', 'c-kept'), env(9, 'r1', { type: 'item', item: { kind: 'notice', id: 'rewind:br', level: 'info', text: 'Conversation rewound' } })] },
    attach: () => ({ session: ROOT, cursor: 9 }),
  });
  t.after(() => world.agents.close());
  await world.agents.start();
  assert.deepEqual((await subagents(world.agents, 'r1')).subagents.map(subagent => subagent.id).sort(), ['c-gone', 'c-kept']);
  assert.deepEqual(await subagentRows(world.agents, 'r1', 'c-kept'), ['assistant_message:kept says hi', 'assistant_message:kept, set aside']);
  world.listener(env(undefined, 'r1', { type: 'history.reset', generation: NEXT, reason: 'rewind', branchId: 'br' }));
  await until(async () => shown((await timeline(world.agents, 'r1')).payload.entries).includes('notification:Conversation rewound'), 'the rewound timeline');
  assert.deepEqual((await subagents(world.agents, 'r1')).subagents.map(subagent => subagent.id), ['c-kept']);
  assert.deepEqual(await subagentRows(world.agents, 'r1', 'c-kept'), ['assistant_message:kept says hi'], 'the kept member\'s timeline is the rewound history\'s');
  assert.ok(world.frames.some(frame => frame.type === 'agent.provider_subagents.update' && frame.payload.kind === 'remove' && frame.payload.subagentId === 'c-gone'), 'clients are told the member is gone');
});

test('a turn that ends between the history read and the attach\'s answer asks for attention; a replayed start clears none', async t => {
  const world = scripted({
    sessions: [{ ...ROOT, status: 'closed' }],
    history: call => call === 0
      ? { generation: G1, hasOlder: false, tipCursor: 1, items: [say(1, 'one')] }
      : { generation: G1, hasOlder: false, tipCursor: 4, items: [say(1, 'one'), started(2, 't1'), say(3, 'answer'), ended(4, 't1')] },
    attach(params, call, listener) {
      // The turn runs and ends after the history read, before the attach's answer.
      if (call === 0) { for (const envelope of [started(2, 't1'), say(3, 'answer'), ended(4, 't1')]) listener(envelope); return { session: ROOT, cursor: 4 }; }
      return { session: ROOT, cursor: 4 };
    },
    extra: method => method === 'session.create' ? {} : undefined,
  });
  t.after(() => world.agents.close());
  await world.agents.start();
  assert.equal((await timeline(world.agents, 'r1')).payload.error, null);
  const agent = await agentRow(world.agents, 'r1');
  assert.equal(agent.requiresAttention, true, 'the finished turn asks for attention');
  assert.equal(agent.attentionReason, 'finished');
  assert.ok(world.frames.some(frame => frame.type === 'agent_stream' && frame.payload.event.type === 'attention_required'), 'clients are told');
  // A re-attach replays the page with that turn's start: the attention stays.
  await world.agents.handlers.refresh_agent_request({ type: 'refresh_agent_request', agentId: 'r1', requestId: 'reload' });
  await until(() => world.calls.filter(call => call.method === 'session.attach').length === 2, 'the re-attach');
  assert.equal((await timeline(world.agents, 'r1')).payload.error, null);
  assert.equal((await agentRow(world.agents, 'r1')).requiresAttention, true, 'a replayed turn.started clears no attention');
});

test('an event at or before the cursor an attach covered that comes after its answer is not applied again', async t => {
  const world = scripted({
    history: () => ({ generation: G1, hasOlder: true, olderCursor: 'older', tipCursor: 6, items: [say(5, 'five'), say(6, 'six')] }),
    attach: () => ({ session: ROOT, cursor: 6 }),
  });
  t.after(() => world.agents.close());
  await world.agents.start();
  assert.deepEqual(shown((await timeline(world.agents, 'r1')).payload.entries), ['assistant_message:five', 'assistant_message:six']);
  // A replay of an attach a later one replaced, after the later one's answer; then a live event.
  world.listener(say(3, 'three'));
  world.listener(say(7, 'seven'));
  await until(async () => shown((await timeline(world.agents, 'r1')).payload.entries).includes('assistant_message:seven'), 'the live item');
  assert.deepEqual(shown((await timeline(world.agents, 'r1')).payload.entries), ['assistant_message:five', 'assistant_message:six', 'assistant_message:seven']);
});
