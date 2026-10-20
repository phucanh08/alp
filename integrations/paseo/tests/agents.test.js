import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { AgentSnapshotPayloadSchema, AgentStreamMessageSchema } from '@getpaseo/protocol/messages';

import { createAgents } from '../server/dist/paseo/agents.js';

/**
 * The four lifecycle-review fixes on the agents bridge: a failed first factory must not poison
 * every later handler, and a connection that connected but whose first refresh failed is
 * half-open and must be dropped and retried rather than spun on. Both are driven with an injected
 * client factory, so no daemon is involved and the failure order is exact.
 */
const directory = {
  load: async () => {},
  workspaceIdFor: () => 'workspace',
  placement: () => ({ projectKey: 'p', projectName: 'p', directory: '/' }),
  assign: () => {},
  changed: () => {},
};

/** A DaemonConnection the bridge can attach to, recording calls and answering the two list RPCs. */
function fakeConnection({ onRequest } = {}) {
  const listeners = { event: [], close: [] };
  const connection = {
    calls: [],
    closed: false,
    onEvent: listener => listeners.event.push(listener),
    onClose: listener => listeners.close.push(listener),
    close() { if (connection.closed) return; connection.closed = true; for (const listener of listeners.close) listener(); },
    async request(method, params) {
      connection.calls.push(method);
      if (onRequest) return onRequest(method, params, connection);
      if (method === 'session.list') return { sessions: [] };
      if (method === 'question.list') return { questions: [] };
      if (method === 'session.attach') return {};
      throw new Error(`unexpected request ${method}`);
    },
  };
  return connection;
}

/**
 * A frame the bridge sends, held to Paseo's own schema where it is the bridge's (the placement is
 * this file's stub). A mismatch is collected, not thrown: frames sent from a background refresh
 * would swallow a throw. Each test asserts it collected none.
 */
function checked(frame, problems) {
  const result = frame.type === 'agent_stream' ? AgentStreamMessageSchema.safeParse(frame)
    : frame.type === 'agent_update' && frame.payload.kind === 'upsert' ? AgentSnapshotPayloadSchema.safeParse(frame.payload.agent)
    : { success: true };
  if (!result.success) problems.push({ type: frame.type, issues: result.error.issues });
  return frame;
}

async function until(check, what, tries = 200) {
  for (let i = 0; i < tries; i++) { if (check()) return; await sleep(25); }
  assert.fail(`Expected ${what} did not happen`);
}

test('a failed first factory is retried, not memoized, and the bridge recovers', async () => {
  const connections = [];
  let factoryCalls = 0;
  const clientFactory = async () => {
    factoryCalls += 1;
    if (factoryCalls === 1) throw new Error('daemon not up yet');
    const connection = fakeConnection();
    connections.push(connection);
    return connection;
  };
  const agents = createAgents({ clientFactory, broadcast: () => {}, directory });
  try {
    await assert.rejects(() => agents.start(), /daemon not up yet/);
    // The scheduled initial reconnect brings a connection up without any second start() call.
    await until(() => connections.length === 1 && connections[0].calls.includes('session.list'), 'the scheduled reconnect to refresh');
    // The rejected promise is not memoized: a later start() must attempt again and resolve.
    await agents.start();
    assert.equal(factoryCalls, 3, 'a fresh attempt followed the failure');
  } finally { agents.close(); }
});

test('a connection whose first refresh fails is dropped as half-open and replaced', async () => {
  const connections = [];
  let factoryCalls = 0;
  const clientFactory = async () => {
    factoryCalls += 1;
    const call = factoryCalls;
    const connection = fakeConnection({
      onRequest: method => {
        if (method === 'session.list' && call === 2) throw new Error('daemon is restarting');
        if (method === 'session.list') return { sessions: [] };
        if (method === 'question.list') return { questions: [] };
        return {};
      },
    });
    connections.push(connection);
    return connection;
  };
  const agents = createAgents({ clientFactory, broadcast: () => {}, directory });
  try {
    await agents.start();
    assert.equal(connections.length, 1, 'the first connection is live');
    // Lose the live socket: the bridge schedules a reconnect.
    connections[0].close();
    // The reconnect's first connection connects but fails its refresh; it must be closed, and a
    // third connection must be used instead of spinning on the dead one.
    await until(() => connections.length >= 3 && connections[2].calls.includes('session.list'), 'the refresh to succeed on a replacement connection');
    assert.equal(connections[1].closed, true, 'the half-open connection was dropped');
    assert.equal(connections[2].calls.filter(method => method === 'session.list').length, 1, 'the replacement refreshed exactly once');
  } finally { agents.close(); }
});

test('a changed alpd epoch resets the delta state for a root; within one epoch only suffixes stream', async () => {
  const session = { id: 'root-1', status: 'idle', projectRoot: '/', agent: 'main', title: 'root', runtime: 'claude', model: 'opus', mode: 'default', workflow: { mode: 'custom' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  let emit, connection;
  const clientFactory = async onEvent => {
    emit = onEvent;
    return connection = fakeConnection({
      onRequest: method => {
        if (method === 'session.list') return { sessions: [session] };
        if (method === 'question.list') return { questions: [] };
        return {};
      },
    });
  };
  const frames = [];
  const agents = createAgents({ clientFactory, broadcast: frame => frames.push(frame), directory });
  const texts = () => frames
    .filter(frame => frame.type === 'agent_stream' && frame.payload.agentId === session.id && frame.payload.event.type === 'timeline' && frame.payload.event.item.type === 'assistant_message')
    .map(frame => frame.payload.event.item.text);
  const item = (epoch, text) => emit({ sessionId: session.id, epoch, ts: new Date().toISOString(), event: { type: 'item', item: { id: 'msg-1', kind: 'assistant_message', text } } });
  try {
    await agents.start();
    // The refresh attaches the live root; once the attach has answered, its timeline exists and is not replaying.
    await until(() => connection.calls.includes('session.attach'), 'the live root to attach');
    await sleep(10);
    item('epoch-A', 'Answer received:');
    item('epoch-A', 'Answer received: you');
    assert.deepEqual(texts(), ['Answer received:', ' you'], 'within one epoch only the new suffix streams');
    // A daemon restart: the same item id arrives under a new epoch and must be appended whole.
    item('epoch-B', 'Answer received: you');
    assert.deepEqual(texts(), ['Answer received:', ' you', 'Answer received: you'], 'a new epoch re-appends the full snapshot');
    item('epoch-B', 'Answer received: you said hi');
    assert.deepEqual(texts().slice(3), [' said hi'], 'the new epoch then streams suffixes again');
  } finally { agents.close(); }
});

test('a root removed from alpd drops its timeline; when it reappears it replays freshly, without stale or repeated rows', async () => {
  const session = { id: 'root-1', status: 'idle', projectRoot: '/', agent: 'main', title: 'root', runtime: 'claude', model: 'opus', mode: 'default', workflow: { mode: 'custom' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  let listed = [session];
  let emit, connection;
  const item = text => ({ sessionId: session.id, epoch: 'epoch-A', ts: new Date().toISOString(), event: { type: 'item', item: { id: 'msg-1', kind: 'assistant_message', text } } });
  const clientFactory = async onEvent => {
    emit = onEvent;
    return connection = fakeConnection({
      onRequest: method => {
        if (method === 'session.list') return { sessions: listed };
        if (method === 'question.list') return { questions: [] };
        // alpd replays the root's history as it is now: the fully streamed message.
        if (method === 'session.attach') { emit(item('Hello world')); return {}; }
        return {};
      },
    });
  };
  const frames = [];
  const problems = [];
  const agents = createAgents({ clientFactory, broadcast: frame => frames.push(checked(frame, problems)), directory });
  const live = () => frames.filter(frame => frame.type === 'agent_stream' && frame.payload.agentId === session.id && frame.payload.event.type === 'timeline').map(frame => frame.payload.event.item.text);
  const timeline = async () => (await agents.handlers.fetch_agent_timeline_request({ type: 'fetch_agent_timeline_request', requestId: 'r', agentId: session.id })).payload;
  const attaches = () => connection.calls.filter(method => method === 'session.attach').length;
  // A root opening makes the bridge read alpd's roots again, as its poll does, known or not.
  const relist = async () => { emit({ sessionId: session.id, epoch: 'epoch-A', ts: new Date().toISOString(), event: { type: 'session.opened', session, cwd: '/' } }); await sleep(20); };
  try {
    await agents.start();
    await until(() => attaches() === 1, 'the live root to attach');
    await sleep(10);
    const first = await timeline();
    assert.deepEqual(first.entries.map(entry => entry.item.text), ['Hello world']);

    // The root goes away in alpd: the bridge removes it and forgets its timeline.
    listed = [];
    await relist();
    assert.ok(frames.some(frame => frame.type === 'agent_update' && frame.payload.kind === 'remove' && frame.payload.agentId === session.id));
    // A late event of the removed root is not streamed into a timeline nobody shows.
    frames.length = 0;
    emit(item('Hello world, again'));
    assert.deepEqual(live(), [], 'nothing streams for a removed root');

    // The root reappears: it attaches again with a replay into a new timeline epoch.
    listed = [session];
    await relist();
    await until(() => attaches() === 2, 'the reappearing root to attach again');
    await sleep(10);
    const second = await timeline();
    assert.notEqual(second.epoch, first.epoch, 'clients see a new epoch and reset');
    assert.deepEqual(second.entries.map(entry => entry.item.text), ['Hello world'], 'the replay seeds the message once, with no stale suffix');
    // Within the new timeline, streaming continues by suffix: the replayed message is not appended whole again.
    frames.length = 0;
    emit(item('Hello world!'));
    assert.deepEqual(live(), ['!']);
    await sleep(20);
    assert.deepEqual(problems, [], 'every frame is one Paseo accepts');
  } finally { agents.close(); }
});

test("a root's usage is the agent's lastUsage, and its turn's usage when the turn completes (t-7679.12)", async () => {
  const usage = { contextWindowUsedTokens: 50_000, contextWindowMaxTokens: 200_000, inputTokens: 40_000, cachedInputTokens: 30_000, outputTokens: 10_000 };
  let session = { id: 'root-1', status: 'idle', projectRoot: '/', agent: 'main', title: 'root', runtime: 'claude', model: 'opus', mode: 'default', workflow: { mode: 'custom' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', usage };
  let emit, connection;
  const clientFactory = async onEvent => {
    emit = onEvent;
    return connection = fakeConnection({
      onRequest: method => {
        if (method === 'session.list') return { sessions: [structuredClone(session)] };
        if (method === 'question.list') return { questions: [] };
        return {};
      },
    });
  };
  const frames = [];
  const problems = [];
  // Every agent and stream frame must be one Paseo's own clients accept.
  const agents = createAgents({ clientFactory, broadcast: frame => frames.push(checked(frame, problems)), directory });
  const fetched = async () => (await agents.handlers.fetch_agent_request({ type: 'fetch_agent_request', requestId: 'r', agentId: session.id })).payload.agent;
  const event = (sessionId, body) => emit({ sessionId, epoch: 'e', ts: new Date().toISOString(), event: body });
  try {
    await agents.start();
    await until(() => connection.calls.includes('session.attach'), 'the live root to attach');
    await sleep(10);
    // The usage alpd lists with the root is the agent's lastUsage from the start.
    assert.deepEqual((await fetched()).lastUsage, usage);
    event(session.id, { type: 'turn.started', turnId: 'turn-1' });
    await sleep(20);
    frames.length = 0;
    const next = { contextWindowUsedTokens: 60_000, contextWindowMaxTokens: 200_000, inputTokens: 50_000, outputTokens: 10_000, totalCostUsd: 0.25 };
    session = { ...session, usage: next };
    event(session.id, { type: 'usage', usage: next });
    const upserts = frames.filter(frame => frame.type === 'agent_update' && frame.payload.kind === 'upsert');
    assert.equal(upserts.length, 1, 'clients get the agent again at once');
    assert.deepEqual(upserts[0].payload.agent.lastUsage, next, 'with its new lastUsage');
    assert.deepEqual((await fetched()).lastUsage, next);
    event(session.id, { type: 'turn.ended', turnId: 'turn-1', state: 'completed' });
    const completed = frames.find(frame => frame.type === 'agent_stream' && frame.payload.event.type === 'turn_completed');
    assert.deepEqual(completed?.payload.event, { type: 'turn_completed', provider: 'alp', turnId: 'turn-1', usage: next });
    // A team member's usage is its own, not the root's context meter.
    await sleep(20);
    frames.length = 0;
    event('child-1', { type: 'session.opened', session: { id: 'child-1', parentId: session.id, agent: 'peer', runtime: 'codex', model: 'x' }, cwd: '/' });
    event('child-1', { type: 'usage', usage: { contextWindowUsedTokens: 1 } });
    assert.ok(!frames.some(frame => frame.type === 'agent_update'), 'the root is not sent again');
    assert.deepEqual((await fetched()).lastUsage, next);
    await sleep(20);
    assert.deepEqual(problems, [], 'every frame is one Paseo accepts');
  } finally { agents.close(); }
});

test('an attach that a later one replaced leaves the later timeline alone when it settles', async () => {
  const session = { id: 'root-1', status: 'idle', projectRoot: '/', agent: 'main', title: 'root', runtime: 'claude', model: 'opus', mode: 'default', workflow: { mode: 'custom' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  let listed = [session];
  let emit, connection;
  let failFirst;
  const item = text => ({ sessionId: session.id, epoch: 'epoch-A', ts: new Date().toISOString(), event: { type: 'item', item: { id: 'msg-1', kind: 'assistant_message', text } } });
  const clientFactory = async onEvent => {
    emit = onEvent;
    return connection = fakeConnection({
      onRequest: method => {
        if (method === 'session.list') return { sessions: listed };
        if (method === 'question.list') return { questions: [] };
        if (method === 'session.attach') {
          // The first attach hangs, then fails late (as on a connection that went away); the next replays.
          if (connection.calls.filter(call => call === 'session.attach').length === 1) return new Promise((_, reject) => { failFirst = () => reject(new Error('connection lost')); });
          emit(item('Hello world'));
          return {};
        }
        return {};
      },
    });
  };
  const frames = [];
  const problems = [];
  const agents = createAgents({ clientFactory, broadcast: frame => frames.push(checked(frame, problems)), directory });
  const live = () => frames.filter(frame => frame.type === 'agent_stream' && frame.payload.agentId === session.id && frame.payload.event.type === 'timeline').map(frame => frame.payload.event.item.text);
  const attaches = () => connection.calls.filter(method => method === 'session.attach').length;
  // The root is replaying, so its own events do not refresh: a root the bridge does not know yet does, as the poll would.
  const relist = async () => { emit({ sessionId: 'unknown', epoch: 'epoch-A', ts: new Date().toISOString(), event: { type: 'session.opened', session: { ...session, id: 'unknown' }, cwd: '/' } }); await sleep(20); };
  try {
    await agents.start();
    await until(() => attaches() === 1 && failFirst, 'the first attach to hang');
    // The root goes and comes back while its first attach still hangs: a second attach replays it.
    listed = [];
    await relist();
    listed = [session];
    await relist();
    await until(() => attaches() === 2, 'the second attach');
    await sleep(10);
    // The first attach fails now; the second one's timeline and live state must survive it.
    failFirst();
    await sleep(20);
    const page = (await agents.handlers.fetch_agent_timeline_request({ type: 'fetch_agent_timeline_request', requestId: 'r', agentId: session.id })).payload;
    assert.equal(page.error, null);
    assert.deepEqual(page.entries.map(entry => entry.item.text), ['Hello world']);
    assert.equal(attaches(), 2, 'the timeline was kept, so nothing attached again');
    frames.length = 0;
    emit(item('Hello world!'));
    assert.deepEqual(live(), ['!'], 'the root streams live, not as a replay');
    assert.deepEqual(problems, []);
  } finally { agents.close(); }
});

test('durable backward pages rebuild split snapshots at stable source positions and attach at fixed generation watermark', async () => {
  const session = { id: 'root-history', status: 'idle', projectRoot: '/', agent: 'main', title: 'root', runtime: 'codex', model: 'm', mode: 'read-only', workflow: { mode: 'custom' }, createdAt: '', updatedAt: '' };
  const envelopes = Array.from({ length: 650 }, (_, i) => ({ sessionId: session.id, epoch: 'old', seq: i + 1, cursor: i + 1, ts: '2026-10-20T00:00:00Z', event: { type: 'item', item: { kind: 'assistant_message', id: i === 449 || i === 450 ? 'split' : `m${i}`, text: i === 449 ? 'hello' : i === 450 ? 'hello world' : `text ${i}` } } }));
  const child = { ...session, id: 'history-child', parentId: session.id, status: 'closed', agent: 'peer' };
  envelopes[0] = { ...envelopes[0], sessionId: child.id, event: { type: 'session.opened', session: child, cwd: '/', effective: { model: 'm', thinking: 'low' } } };
  envelopes[500] = { ...envelopes[500], sessionId: child.id };
  const calls = [];
  let emit;
  const clientFactory = async listener => {
    emit = listener;
    const connection = fakeConnection({ onRequest(method, params) {
      calls.push({ method, params });
      if (method === 'session.list') return { sessions: [session] };
      if (method === 'session.get') return { session: child };
      if (method === 'question.list') return { questions: [] };
      if (method === 'session.history') {
        const end = params.before ? Number(params.before) : 650;
        const start = Math.max(0, end - 200);
        return { generation: 'durable', items: envelopes.slice(start, end), hasOlder: start > 0, ...(start ? { olderCursor: String(start) } : {}), tipCursor: 650 };
      }
      return {};
    } });
    connection.capabilities = ['session.history'];
    return connection;
  };
  const agents = createAgents({ clientFactory, broadcast() {}, directory });
  try {
    await agents.start();
    const fetch = (extra = {}) => agents.handlers.fetch_agent_timeline_request({ type: 'fetch_agent_timeline_request', requestId: 'r', agentId: session.id, ...extra }).then(reply => reply.payload);
    const first = await fetch();
    assert.equal(first.entries.length, 199);
    const childFetch = () => agents.handlers['agent.provider_subagents.timeline.get.request']({ type: 'agent.provider_subagents.timeline.get.request', requestId: 'c', parentAgentId: session.id, subagentId: child.id, limit: 0 }).then(reply => reply.payload);
    const childPage = await childFetch();
    assert.equal(childPage.error, null);
    assert.equal(childPage.rows.length, 1);
    assert.equal(childPage.rows[0].item.text, 'text 500');
    assert.equal(childPage.rows[0].seqEnd, 501);
    assert.equal(first.hasOlder, true);
    const attach = calls.find(call => call.method === 'session.attach');
    assert.deepEqual(attach.params, { sessionId: session.id, replay: true, after: 650, generation: 'durable' });
    const before = await fetch({ direction: 'before', cursor: first.startCursor });
    assert.equal(before.error, null);
    assert.ok(before.entries.every(entry => entry.seqStart < first.startCursor.seq));
    const boundary = before.entries.find(entry => entry.item.messageId === 'split');
    assert.ok(boundary, 'the crossing projected item is explicitly returned for update');
    assert.equal(boundary.seqStart, 450);
    assert.equal(boundary.seqEnd, 451);
    assert.equal(boundary.item.text, 'hello world');
    assert.equal(before.epoch, first.epoch);
    const continued = await fetch({ direction: 'after', cursor: first.endCursor });
    assert.equal(continued.reset, false, 'an existing cursor remains valid after prepending');
    assert.equal(continued.entries.length, 0);
    const merged = await fetch({ limit: 0 });
    const split = merged.entries.filter(entry => entry.item.messageId === 'split');
    assert.equal(split.length, 1);
    assert.equal(split[0].item.text, 'hello world');
    const childAgain = await childFetch();
    assert.equal(childAgain.rows.length, 1, 'child source snapshot remains once after older-page rebuild');
    assert.equal(childAgain.rows[0].seqEnd, 501);
    assert.equal(childAgain.epoch, childPage.epoch);
    emit(envelopes.at(-1));
    const again = await fetch({ limit: 0 });
    assert.equal(again.entries.length, merged.entries.length, 'stable cursor replay is deduplicated');
  } finally { agents.close(); }
});
