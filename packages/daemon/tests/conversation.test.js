import { failCommittedMarker } from './lifecycle-marker-fault.js';
// session.fork and session.rewind in alpd (docs/protocol/alp-json-rpc-v1.md §12.7, issue #121 branch C):
// the lifecycle journal, the idle barrier, timeline cuts, history generations, branches and receipts.
// The runtime's native side (runtime.branch / runtime.rebind) is scripted here; packages/runtime tests
// prove it against the native contracts, and test/e2e the real Codex and Claude runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { validateResult } from '@anhlp/alp-protocol/contract';
import { defaultForkTitle, turnsOf } from '@anhlp/alp-daemon/conversation';

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
  const native = { branches: [], rebinds: [], reloads: [], next: 0, branch: undefined, rebind: undefined, reload: undefined };
  let count = 0;
  async function start() {
    const runtime = createAlpRuntime({ supervisor: false, transport: fakeTransport(transports), runLogDir: path.join(directory, 'runs') });
    runtime.branch = async request => {
      native.branches.push(request);
      if (native.branch) return native.branch(request);
      return { threadId: `thread-branch-${++native.next}` };
    };
    runtime.rebind = async (sessionId, binding) => {
      native.rebinds.push({ sessionId, binding });
      if (native.rebind) return native.rebind(sessionId, binding);
      return runtime.snapshot(sessionId);
    };
    // The runtime's own reload (restarting a fake process), or a scripted one.
    const reload = runtime.reload;
    runtime.reload = async sessionId => {
      native.reloads.push(sessionId);
      return native.reload ? native.reload(sessionId, reload) : reload(sessionId);
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
  await d.request('session.create', { sessionId, spec: { cwd: d.project ?? d.cwd, persist: true } });
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

/** Waits up to `ms` for `check`, without failing: a race test gives a wake the time it needs to start, if it can. */
async function within(ms, check) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise(resolve => setTimeout(resolve, 5)); }
  return false;
}

const generationOf = async (d, sessionId) => (await d.request('session.history', { sessionId, limit: 1 })).generation;
const rpcError = (code, reason) => error => error.code === code && error.data?.reason === reason;

test('turnsOf: a turn starts at its user message, ends at turn.ended; steers and children do not start turns', () => {
  const e = (cursor, sessionId, event) => ({ sessionId, epoch: 'e', seq: cursor, ts: 't', cursor, event });
  const log = [
    e(1, 'r', { type: 'session.opened' }),
    e(2, 'r', { type: 'item', item: { kind: 'user_message', id: 'user:a', clientMessageId: 'a', text: 'one' } }),
    e(3, 'r', { type: 'prompt.accepted', clientMessageId: 'a', result: 'turn', turnId: 't1' }),
    e(4, 'r', { type: 'turn.started', turnId: 't1', origin: 'user' }),
    e(5, 'c', { type: 'turn.started', turnId: 'child-1', origin: 'assignment' }),
    e(6, 'r', { type: 'item', item: { kind: 'user_message', id: 'user:s', clientMessageId: 's', text: 'steer' } }),
    e(7, 'r', { type: 'prompt.accepted', clientMessageId: 's', result: 'steer', turnId: 't1' }),
    e(8, 'r', { type: 'turn.ended', turnId: 't1', state: 'completed' }),
    e(9, 'r', { type: 'turn.started', turnId: 't2', origin: 'runtime' }),
  ];
  assert.deepEqual(turnsOf(log, 'r'), [{ id: 't1', start: 2, end: 8, state: 'completed' }, { id: 't2', start: 9 }]);
});

test('rewind: same id, the later turns become a recoverable branch, history generation advances, receipts stay', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const hello = await d.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(hello.capabilities.includes('session.fork') && hello.capabilities.includes('session.rewind'));
  const [first, second, third] = await conversation(d, 'r1', ['one', 'two', 'three']);
  const before = await d.request('session.get', { sessionId: 'r1' });
  assert.deepEqual(before.session.conversation, { fork: true, rewind: true, reload: true, configure: true });
  const threadBefore = before.session.threadId;
  const oldPage = await d.request('session.history', { sessionId: 'r1', limit: 2 });
  const generation = oldPage.generation;
  // A second viewer attached by cursor (legacy attach.after), and one by generation.
  const viewer = await d.open();
  const attached = await viewer.request('session.attach', { sessionId: 'r1', replay: false });

  const result = await d.request('session.rewind', { sessionId: 'r1', requestId: 'rw-1', ifGeneration: generation, beforeTurnId: second });
  assert.deepEqual(validateResult('session.rewind', result), []);
  assert.notEqual(result.generation, generation);
  assert.equal(result.branch.beforeTurnId, second);
  assert.equal(result.branch.turns, 2);
  assert.match(result.branch.branchId, /^br_[0-9a-f]{16}$/);
  assert.deepEqual(result.session.branches, [result.branch]);
  // The native step: a cut before the second turn of the root's own conversation, then the live root moved over.
  assert.equal(world.native.branches.length, 1);
  assert.deepEqual(world.native.branches[0].cutoff, { beforeTurnId: second });
  assert.deepEqual(world.native.branches[0].turns, [first, second, third]);
  assert.equal(world.native.branches[0].source.threadId, threadBefore);
  assert.deepEqual(world.native.rebinds, [{ sessionId: 'r1', binding: { threadId: 'thread-branch-1' } }]);

  // The history now holds the first turn and the marker; every older cursor is stale.
  const page = await d.request('session.history', { sessionId: 'r1' });
  assert.equal(page.generation, result.generation);
  const texts = page.items.filter(item => item.event?.type === 'item').map(item => item.event.item.text);
  assert.ok(texts.includes('one') && texts.includes('answer 0'));
  assert.ok(!texts.includes('two') && !texts.includes('three') && !texts.includes('answer 1'));
  assert.match(texts.at(-1), /Files were not changed/);
  await assert.rejects(d.request('session.history', { sessionId: 'r1', before: oldPage.olderCursor }), rpcError(1004, 'stale_cursor'));
  await assert.rejects(d.request('session.attach', { sessionId: 'r1', after: oldPage.tipCursor, generation }), rpcError(1004, 'stale_cursor'));
  // A legacy cursor in the discarded history starts over.
  const legacy = await (await d.open()).request('session.attach', { sessionId: 'r1', after: attached.cursor });
  assert.equal(legacy.reset, true);
  // The attached viewer was told, and saw the marker.
  await until(() => viewer.events.some(envelope => envelope.event.type === 'history.reset' && envelope.event.generation === result.generation), 'history.reset');
  assert.ok(viewer.events.some(envelope => envelope.event.type === 'item' && envelope.event.item.id === `rewind:${result.branch.branchId}`));

  // A repeat answers the same result; another payload under the requestId is a conflict.
  const again = await d.request('session.rewind', { sessionId: 'r1', requestId: 'rw-1', ifGeneration: generation, beforeTurnId: second });
  assert.equal(again.duplicate, true);
  assert.equal(again.branch.branchId, result.branch.branchId);
  await assert.rejects(d.request('session.rewind', { sessionId: 'r1', requestId: 'rw-1', ifGeneration: generation, beforeTurnId: third }), rpcError(1004, 'key_conflict'));
  assert.equal(world.native.branches.length, 1);

  // Receipts are never deleted: the second turn's prompt id still answers as delivered, and nothing is sent.
  const transport = world.transports.at(-1);
  const turnStarts = transport.calls.filter(call => call.method === 'turn/start').length;
  const repeated = await d.request('session.prompt', { sessionId: 'r1', clientMessageId: 'r1-m1', content: [{ type: 'text', text: 'two' }] });
  assert.equal(repeated.duplicate, true);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, turnStarts);

  // The record names the new conversation; the branch keeps the old one; the branch file holds the old timeline.
  await d.stop();
  const restarted = { ...await world.start(), ...world };
  const listed = await restarted.request('session.get', { sessionId: 'r1' });
  assert.equal(listed.session.threadId, 'thread-branch-1');
  assert.deepEqual(listed.session.branches, [result.branch]);
  const stored = JSON.parse(await readFile(path.join(world.state, 'sessions', 'r1.json'), 'utf8'));
  assert.equal(stored.branches[0].threadId, threadBefore);
  const files = await readdir(path.join(world.state, 'timeline'));
  assert.ok(files.includes(`r1.branch-${result.branch.branchId}.jsonl`));
  const branchText = await readFile(path.join(world.state, 'timeline', `r1.branch-${result.branch.branchId}.jsonl`), 'utf8');
  assert.ok(branchText.includes('"three"'));
  // After a restart the repeat still answers the one result, and the generation survives.
  const repeat = await restarted.request('session.rewind', { sessionId: 'r1', requestId: 'rw-1', ifGeneration: generation, beforeTurnId: second });
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.generation, result.generation);
  assert.equal(await generationOf(restarted, 'r1'), result.generation);
  // Reopening continues the new conversation.
  await restarted.request('session.create', { sessionId: 'r1', spec: { cwd: world.project, persist: true }, resume: true });
  const resumed = world.transports.at(-1).calls.find(call => call.method === 'thread/resume');
  assert.equal(resumed.params.threadId, 'thread-branch-1');
});

test('rewind refusals record nothing: stale view, unknown turn, the first turn, a busy tree; prompts wait for a rewind', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [first, second] = await conversation(d, 'r2', ['one', 'two']);
  const generation = await generationOf(d, 'r2');
  await assert.rejects(d.request('session.rewind', { sessionId: 'r2', requestId: 'x1', ifGeneration: 'f'.repeat(32), beforeTurnId: second }), rpcError(1004, 'stale_generation'));
  await assert.rejects(d.request('session.rewind', { sessionId: 'r2', requestId: 'x2', ifGeneration: generation, beforeTurnId: 'nope' }), rpcError(1001, 'turn_not_found'));
  await assert.rejects(d.request('session.rewind', { sessionId: 'r2', requestId: 'x3', ifGeneration: generation, beforeTurnId: first }), rpcError(1005, 'empty_prefix'));
  // A turn in progress: the tree is busy for a rewind; a fork may keep only ended turns.
  const transport = world.transports.at(-1);
  await d.request('session.prompt', { sessionId: 'r2', clientMessageId: 'r2-busy', content: [{ type: 'text', text: 'three' }] });
  await until(() => transport.turnId?.endsWith('-3'), 'third turn');
  const running = transport.turnId;
  const busyGeneration = await generationOf(d, 'r2');
  await assert.rejects(d.request('session.rewind', { sessionId: 'r2', requestId: 'x4', ifGeneration: busyGeneration, beforeTurnId: second }), rpcError(1004, 'session_busy'));
  await assert.rejects(d.request('session.fork', { sessionId: 'r2', requestId: 'fx', ifGeneration: busyGeneration, boundary: { throughTurnId: running } }), rpcError(1004, 'turn_in_progress'));
  await assert.rejects(d.request('session.fork', { sessionId: 'r2', requestId: 'fy', ifGeneration: busyGeneration }), rpcError(1004, 'turn_in_progress'));
  // A fork through an ended turn while a later one runs is allowed: it keeps only ended turns.
  const early = await d.request('session.fork', { sessionId: 'r2', requestId: 'fz', ifGeneration: busyGeneration, boundary: { throughTurnId: second } });
  assert.deepEqual(world.native.branches.at(-1).cutoff, { throughTurnId: second });
  world.native.branches.length = 0;
  assert.equal(early.session.status, 'closed');
  transport.finish('three done');
  await until(async () => !(await d.request('session.get', { sessionId: 'r2' })).session.busy, 'idle');
  assert.equal(world.native.branches.length, 0);
  // Refusals before the journal record nothing: the same requestId works once the cause is gone.
  const current = await generationOf(d, 'r2');
  // A prompt sent while the rewind's native step runs waits, then reaches the rewound conversation.
  let release;
  world.native.branch = () => new Promise(resolve => { release = () => resolve({ threadId: 'thread-rewound' }); });
  const rewinding = d.request('session.rewind', { sessionId: 'r2', requestId: 'x4', ifGeneration: current, beforeTurnId: second });
  await until(() => release, 'native step started');
  const starts = transport.calls.filter(call => call.method === 'turn/start').length;
  const prompting = d.request('session.prompt', { sessionId: 'r2', clientMessageId: 'r2-after', content: [{ type: 'text', text: 'after' }] });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, starts, 'the prompt waits for the rewind');
  release();
  const rewound = await rewinding;
  assert.equal(rewound.session.id, 'r2');
  assert.equal((await prompting).outcome, 'accepted');
  assert.equal(world.native.rebinds.length, 1);
  const rebound = world.native.rebinds[0];
  assert.equal(rebound.binding.threadId, 'thread-rewound');
});

test('native refusal is kept as the answer; an unknown native outcome answers outcome_unknown, now and after a restart', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second] = await conversation(d, 'r3', ['one', 'two']);
  const generation = await generationOf(d, 'r3');
  world.native.branch = () => { throw Object.assign(new Error('turn not found: x'), { data: { reason: 'boundary_unmapped' } }); };
  await assert.rejects(d.request('session.rewind', { sessionId: 'r3', requestId: 'n1', ifGeneration: generation, beforeTurnId: second }), rpcError(1005, 'boundary_unmapped'));
  world.native.branch = undefined;
  // The refusal was journaled after prepare: the same requestId answers it again without a native step.
  await assert.rejects(d.request('session.rewind', { sessionId: 'r3', requestId: 'n1', ifGeneration: generation, beforeTurnId: second }), rpcError(1005, 'boundary_unmapped'));
  assert.equal(world.native.branches.length, 1);
  world.native.branch = () => { throw Object.assign(new Error('Runtime request timed out: thread/fork'), { outcomeUnknown: true }); };
  await assert.rejects(d.request('session.rewind', { sessionId: 'r3', requestId: 'n2', ifGeneration: generation, beforeTurnId: second }), rpcError(1004, 'outcome_unknown'));
  world.native.branch = undefined;
  await assert.rejects(d.request('session.rewind', { sessionId: 'r3', requestId: 'n2', ifGeneration: generation, beforeTurnId: second }), rpcError(1004, 'outcome_unknown'));
  // The binding did not move.
  assert.equal((await d.request('session.get', { sessionId: 'r3' })).session.branches, undefined);
  // A native step in flight when alpd stops is unknown after the restart, never sent again.
  world.native.branch = () => new Promise(() => {});
  const lost = d.request('session.rewind', { sessionId: 'r3', requestId: 'n3', ifGeneration: generation, beforeTurnId: second }).catch(error => error);
  await until(() => world.native.branches.length === 3, 'native step in flight');
  await d.stop();
  await lost;
  world.native.branch = undefined;
  const restarted = { ...await world.start(), ...world };
  await assert.rejects(restarted.request('session.rewind', { sessionId: 'r3', requestId: 'n3', ifGeneration: generation, beforeTurnId: second }), rpcError(1004, 'outcome_unknown'));
  assert.equal(world.native.branches.length, 3);
});

test('a rewind whose commit failed finishes from its journal at the next start', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second] = await conversation(d, 'r4', ['one', 'two']);
  const generation = await generationOf(d, 'r4');
  // The native step happens, then the timeline directory cannot be written: alpd's commit fails.
  const timeline = path.join(world.state, 'timeline');
  world.native.branch = async () => {
    await rename(timeline, `${timeline}.saved`);
    await writeFile(timeline, 'not a directory');
    return { threadId: 'thread-branch-1' };
  };
  await assert.rejects(d.request('session.rewind', { sessionId: 'r4', requestId: 'c1', ifGeneration: generation, beforeTurnId: second }), rpcError(1000, 'persistence_failed'));
  world.native.branch = undefined;
  // Until that rewind is finished the root is fenced: closed, no prompt, no reopen, no other rewind.
  assert.equal((await d.request('session.get', { sessionId: 'r4' })).session.status, 'closed');
  await assert.rejects(d.request('session.prompt', { sessionId: 'r4', clientMessageId: 'fenced', content: [{ type: 'text', text: 'x' }] }), error => error.code === 1004 && error.data?.reason === 'session_busy' || error.code === 1001);
  await assert.rejects(d.request('session.create', { sessionId: 'r4', spec: { cwd: world.project, persist: true }, resume: true }), rpcError(1004, 'session_busy'));
  await d.stop();
  await rm(timeline, { force: true });
  await rename(`${timeline}.saved`, timeline);
  const restarted = { ...await world.start(), ...world };
  // The start rolled it forward: the record names the branch's conversation, the repeat answers it.
  const session = (await restarted.request('session.get', { sessionId: 'r4' })).session;
  // No fence after the roll-forward: the root reopens on its new conversation.
  await restarted.request('session.create', { sessionId: 'r4', spec: { cwd: world.project, persist: true }, resume: true });
  assert.equal(world.transports.at(-1).calls.find(call => call.method === 'thread/resume').params.threadId, 'thread-branch-1');
  assert.equal(session.threadId, 'thread-branch-1');
  assert.equal(session.branches.length, 1);
  const repeat = await restarted.request('session.rewind', { sessionId: 'r4', requestId: 'c1', ifGeneration: generation, beforeTurnId: second });
  assert.equal(repeat.branch.branchId, session.branches[0].branchId);
  assert.equal(world.native.branches.length, 1);
  const texts = (await restarted.request('session.history', { sessionId: 'r4' })).items.filter(item => item.event?.type === 'item').map(item => item.event.item.text);
  assert.ok(texts.includes('one') && !texts.includes('two'));
});

test('fork: a new closed root with the cut conversation and provenance; resumable; a branch is recoverable as a fork', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [first, second, third] = await conversation(d, 'r5', ['one', 'two', 'three']);
  const generation = await generationOf(d, 'r5');
  const fork = await d.request('session.fork', { sessionId: 'r5', requestId: 'f1', ifGeneration: generation, boundary: { throughTurnId: first }, newSessionId: 'f5' });
  assert.deepEqual(validateResult('session.fork', fork), []);
  assert.equal(fork.session.id, 'f5');
  assert.equal(fork.session.status, 'closed');
  assert.equal(fork.session.threadId, 'thread-branch-1');
  assert.deepEqual(fork.forkedFrom, { sessionId: 'r5', turnId: first, boundary: 'through', at: fork.forkedFrom.at });
  assert.deepEqual(fork.session.forkedFrom, fork.forkedFrom);
  assert.deepEqual(world.native.branches[0].cutoff, { throughTurnId: first });
  assert.equal(world.native.branches[0].targetCwd, undefined);
  const texts = (await d.request('session.history', { sessionId: 'f5' })).items.filter(item => item.event?.type === 'item').map(item => item.event.item.text);
  assert.ok(texts.includes('one') && texts.includes('answer 0') && !texts.includes('two'));
  assert.match(texts.at(-1), /Forked from/);
  // The source is unchanged.
  assert.equal(await generationOf(d, 'r5'), generation);
  // Repeat and conflict.
  assert.equal((await d.request('session.fork', { sessionId: 'r5', requestId: 'f1', ifGeneration: generation, boundary: { throughTurnId: first }, newSessionId: 'f5' })).duplicate, true);
  await assert.rejects(d.request('session.fork', { sessionId: 'r5', requestId: 'f1', ifGeneration: generation, boundary: { throughTurnId: second }, newSessionId: 'f5' }), rpcError(1004, 'key_conflict'));
  await assert.rejects(d.request('session.fork', { sessionId: 'r5', requestId: 'f2', ifGeneration: generation, boundary: { throughTurnId: first }, newSessionId: 'f5' }), rpcError(1004, 'request_conflict'));
  // The fork opens on its own native conversation.
  await d.request('session.create', { sessionId: 'f5', spec: { cwd: world.project, persist: true }, resume: true });
  assert.equal(world.transports.at(-1).calls.find(call => call.method === 'thread/resume').params.threadId, 'thread-branch-1');
  // Rewind the source, then restore the discarded branch whole as a new session.
  const rewound = await d.request('session.rewind', { sessionId: 'r5', requestId: 'r1', ifGeneration: generation, beforeTurnId: second });
  const restored = await d.request('session.fork', { sessionId: 'r5', requestId: 'f3', ifGeneration: rewound.generation, branchId: rewound.branch.branchId });
  assert.equal(restored.forkedFrom.boundary, 'whole');
  assert.equal(restored.forkedFrom.branchId, rewound.branch.branchId);
  const branchCall = world.native.branches.at(-1);
  // The branch's conversation is the one the root continued before the rewind.
  assert.equal(branchCall.source.threadId, world.native.branches[1].source.threadId);
  assert.deepEqual(branchCall.turns, [first, second, third]);
  // A whole fork is cut through the last turn prepare checked, never at whatever the source ends with later.
  assert.deepEqual(branchCall.cutoff, { throughTurnId: third });
  const restoredTexts = (await d.request('session.history', { sessionId: restored.session.id })).items.filter(item => item.event?.type === 'item').map(item => item.event.item.text);
  assert.ok(restoredTexts.includes('two') && restoredTexts.includes('three'));
  await assert.rejects(d.request('session.fork', { sessionId: 'r5', requestId: 'f4', ifGeneration: rewound.generation, branchId: 'br_0000000000000000' }), rpcError(1001, 'branch_not_found'));
  // A cut before the first turn has nothing to keep; a turn of another generation is unknown here.
  await assert.rejects(d.request('session.fork', { sessionId: 'r5', requestId: 'f5', ifGeneration: rewound.generation, boundary: { beforeTurnId: first } }), rpcError(1005, 'empty_prefix'));
  await assert.rejects(d.request('session.fork', { sessionId: 'r5', requestId: 'f6', ifGeneration: rewound.generation, boundary: { throughTurnId: third } }), rpcError(1001, 'turn_not_found'));
});

test('a runtime without native forks lists neither capability and refuses both methods', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-noconv-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = createAlpRuntime({ transport: fakeTransport([]) });
  delete runtime.branch;
  delete runtime.rebind;
  const socketPath = daemonPaths(path.join(directory, 'd')).socket;
  const server = createDaemonServer({ runtime, socketPath, version: 'test', store: createStore(path.join(directory, 'state')) });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); });
  const client = await connect(socketPath, { name: 'test', version: '0' });
  t.after(() => client.close());
  const hello = await client.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(!hello.capabilities.includes('session.fork') && !hello.capabilities.includes('session.rewind'));
  await assert.rejects(client.request('session.rewind', { sessionId: 's', requestId: 'r', ifGeneration: 'a'.repeat(32), beforeTurnId: 't' }), error => error.code === -32601);
});

test('a commit that fails is fenced until the same rewind is sent again, in the same alpd', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second] = await conversation(d, 'r6', ['one', 'two']);
  const generation = await generationOf(d, 'r6');
  const sessions = path.join(world.state, 'sessions');
  world.native.branch = async () => {
    await rename(sessions, `${sessions}.saved`);
    await writeFile(sessions, 'not a directory');
    return { threadId: 'thread-fenced' };
  };
  await assert.rejects(d.request('session.rewind', { sessionId: 'r6', requestId: 'f1', ifGeneration: generation, beforeTurnId: second }), rpcError(1000, 'persistence_failed'));
  world.native.branch = undefined;
  await assert.rejects(d.request('session.create', { sessionId: 'r6', spec: { cwd: world.project, persist: true }, resume: true }), rpcError(1004, 'session_busy'));
  await rm(sessions, { force: true });
  await rename(`${sessions}.saved`, sessions);
  // The same request finishes the commit (no second native step), and the fence goes.
  const finished = await d.request('session.rewind', { sessionId: 'r6', requestId: 'f1', ifGeneration: generation, beforeTurnId: second });
  assert.equal(finished.branch.beforeTurnId, second);
  assert.equal(world.native.branches.length, 1);
  await d.request('session.create', { sessionId: 'r6', spec: { cwd: world.project, persist: true }, resume: true });
  assert.equal(world.transports.at(-1).calls.find(call => call.method === 'thread/resume').params.threadId, 'thread-fenced');
  assert.equal((await d.request('session.prompt', { sessionId: 'r6', clientMessageId: 'after', content: [{ type: 'text', text: 'after' }] })).outcome, 'accepted');
});

test('mail that would wake the root during a rewind waits, then reaches it after the rebind', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second] = await conversation(d, 'r7', ['one', 'two']);
  const generation = await generationOf(d, 'r7');
  const transport = world.transports.at(-1);
  let release;
  world.native.branch = () => new Promise(resolve => { release = () => resolve({ threadId: 'thread-woken' }); });
  const rewinding = d.request('session.rewind', { sessionId: 'r7', requestId: 'w1', ifGeneration: generation, beforeTurnId: second });
  await until(() => release, 'native step started');
  const starts = transport.calls.filter(call => call.method === 'turn/start').length;
  // A note from the user to the idle root wakes it, unless a rewind holds its wakes.
  await d.request('session.message', { sessionId: 'r7', text: 'a note while rewinding' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, starts, 'the wake waits for the rewind');
  release();
  await rewinding;
  assert.equal(world.native.rebinds.length, 1);
  await until(() => transport.calls.filter(call => call.method === 'turn/start').length === starts + 1, 'the wake after the rebind');
});

test('a whole fork holds the live source: a prompt waits until the runtime read it', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [first, second] = await conversation(d, 'r8', ['one', 'two']);
  const generation = await generationOf(d, 'r8');
  const transport = world.transports.at(-1);
  let release;
  world.native.branch = request => new Promise(resolve => { release = () => resolve({ threadId: 'thread-whole' }); world.native.seen = request; });
  const forking = d.request('session.fork', { sessionId: 'r8', requestId: 'w', ifGeneration: generation });
  await until(() => release, 'native step started');
  // The whole conversation is cut through its last turn, from the turns prepare checked.
  assert.deepEqual(world.native.seen.cutoff, { throughTurnId: second });
  assert.deepEqual(world.native.seen.turns, [first, second]);
  const starts = transport.calls.filter(call => call.method === 'turn/start').length;
  const prompting = d.request('session.prompt', { sessionId: 'r8', clientMessageId: 'during', content: [{ type: 'text', text: 'during' }] });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, starts, 'the prompt waits for the fork');
  release();
  assert.equal((await forking).forkedFrom.boundary, 'whole');
  assert.equal((await prompting).outcome, 'accepted');
});

test('store.rewind keeps the lines after the marker in cursor order', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-rewind-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStore(directory);
  const e = (cursor, event, sessionId = 'root') => ({ sessionId, epoch: 'e', seq: cursor, ts: 't', cursor, event });
  for (const envelope of [
    e(1, { type: 'item', item: { kind: 'user_message', id: 'u1', text: 'one' } }),
    e(2, { type: 'item', item: { kind: 'user_message', id: 'u2', text: 'two' } }),
    e(3, { type: 'session.updated', session: {} }),
    e(4, { type: 'item', item: { kind: 'assistant_message', id: 'a2', text: 'cut' } }),
    // Kept while the rewind waited for the append queue: its cursor follows the marker's.
    e(7, { type: 'session.updated', session: {} }),
  ]) await store.append('root', envelope);
  await store.rewind('root', { cut: 2, branchId: 'br_0000000000000001', marker: e(6, { type: 'item', item: { kind: 'notice', id: 'rewind:br_0000000000000001', level: 'info', text: 'rewound' } }) });
  const kept = await store.timeline('root');
  assert.deepEqual(kept.map(envelope => envelope.cursor), [1, 3, 6, 7]);
  assert.deepEqual((await store.branchTimeline('root', 'br_0000000000000001')).map(envelope => envelope.cursor), [1, 2, 3, 4, 7]);
  // Repeating it changes nothing.
  await store.rewind('root', { cut: 2, branchId: 'br_0000000000000001', marker: e(6, { type: 'item', item: { kind: 'notice', id: 'rewind:br_0000000000000001', level: 'info', text: 'rewound' } }) });
  assert.deepEqual((await store.timeline('root')).map(envelope => envelope.cursor), [1, 3, 6, 7]);
});

test('a fork without a title is "<source> (fork)" in the same workspace, neutral in another', () => {
  assert.equal(defaultForkTitle('Plan the release', true), 'Plan the release (fork)');
  assert.equal(defaultForkTitle(undefined, true), 'Session (fork)');
  assert.equal(defaultForkTitle('Plan the release', false), 'Fork of a session');
  assert.equal(defaultForkTitle('x'.repeat(300), true).length, 200);
});

test('a repeat of an older committed rewind does not lift the fence of a newer one', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second] = await conversation(d, 'r9', ['one', 'two']);
  const first = await d.request('session.rewind', { sessionId: 'r9', requestId: 'old', ifGeneration: await generationOf(d, 'r9'), beforeTurnId: second });
  // Two more turns on the rewound conversation, then a rewind whose commit fails.
  await d.request('session.create', { sessionId: 'r9', spec: { cwd: world.project, persist: true }, resume: true }).catch(() => {});
  const transport = world.transports.at(-1);
  const turns = [];
  for (const text of ['three', 'four']) {
    await d.request('session.prompt', { sessionId: 'r9', clientMessageId: `r9-${text}`, content: [{ type: 'text', text }] });
    await until(() => transport.turnId && !turns.includes(transport.turnId), 'turn');
    turns.push(transport.turnId);
    transport.finish(text);
    await until(async () => !(await d.request('session.get', { sessionId: 'r9' })).session.activeTurnId, 'ended');
  }
  const sessions = path.join(world.state, 'sessions');
  world.native.branch = async () => { await rename(sessions, `${sessions}.saved`); await writeFile(sessions, 'not a directory'); return { threadId: 'thread-new' }; };
  await assert.rejects(d.request('session.rewind', { sessionId: 'r9', requestId: 'new', ifGeneration: await generationOf(d, 'r9'), beforeTurnId: turns[1] }), rpcError(1000, 'persistence_failed'));
  world.native.branch = undefined;
  await rm(sessions, { force: true });
  await rename(`${sessions}.saved`, sessions);
  // The older rewind answers its result again; the newer one's fence stays.
  assert.equal((await d.request('session.rewind', { sessionId: 'r9', requestId: 'old', ifGeneration: first.generation, beforeTurnId: second })).duplicate, true);
  await assert.rejects(d.request('session.create', { sessionId: 'r9', spec: { cwd: world.project, persist: true }, resume: true }), rpcError(1004, 'session_busy'));
  // The newer one, sent again, finishes and lifts it.
  await d.request('session.rewind', { sessionId: 'r9', requestId: 'new', ifGeneration: 'f'.repeat(32), beforeTurnId: turns[1] });
  await d.request('session.create', { sessionId: 'r9', spec: { cwd: world.project, persist: true }, resume: true });
});

test('a fork that does not keep the latest turn holds nothing: prompts to the source go on', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second] = await conversation(d, 'r10', ['one', 'two']);
  const generation = await generationOf(d, 'r10');
  const transport = world.transports.at(-1);
  let release;
  world.native.branch = () => new Promise(resolve => { release = () => resolve({ threadId: 'thread-before' }); });
  const forking = d.request('session.fork', { sessionId: 'r10', requestId: 'b', ifGeneration: generation, boundary: { beforeTurnId: second } });
  await until(() => release, 'native step started');
  const starts = transport.calls.filter(call => call.method === 'turn/start').length;
  assert.equal((await d.request('session.prompt', { sessionId: 'r10', clientMessageId: 'free', content: [{ type: 'text', text: 'free' }] })).outcome, 'accepted');
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, starts + 1);
  release();
  assert.equal((await forking).forkedFrom.boundary, 'before');
});

// ---- session.reload and session.resumeCommand (§12.8)

test('reload: the same id, thread, history and receipts in a new process; a repeat answers duplicate without a second restart', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const hello = await d.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(hello.capabilities.includes('session.reload') && hello.capabilities.includes('session.resumeCommand'));
  await conversation(d, 'rl', ['one', 'two']);
  const before = (await d.request('session.get', { sessionId: 'rl' })).session;
  assert.equal(before.conversation.reload, true);
  const generation = await generationOf(d, 'rl');
  const history = await d.request('session.history', { sessionId: 'rl', limit: 50 });
  const processes = world.transports.length;
  const result = await d.request('session.reload', { sessionId: 'rl', requestId: 'reload-1', ifGeneration: generation });
  validateResult('session.reload', result);
  assert.equal(result.duplicate, undefined);
  assert.equal(result.session.id, 'rl');
  assert.equal(result.session.threadId, before.threadId);
  for (const key of ['model', 'mode', 'thinking', 'agent', 'runtime', 'projectRoot']) assert.equal(result.session[key], before[key], key);
  assert.equal(world.transports.length, processes + 1, 'one new native process');
  assert.deepEqual(world.transports.at(-1).calls.filter(call => call.method.startsWith('thread/')).map(call => [call.method, call.params.threadId]), [['thread/resume', before.threadId]]);
  // History is untouched: same generation, same envelopes.
  assert.equal(await generationOf(d, 'rl'), generation);
  const after = await d.request('session.history', { sessionId: 'rl', limit: 50 });
  assert.deepEqual(after.items.slice(0, history.items.length), history.items, 'the earlier history is unchanged');
  // A repeat answers the first result, restarts nothing.
  const repeat = await d.request('session.reload', { sessionId: 'rl', requestId: 'reload-1', ifGeneration: generation });
  assert.equal(repeat.duplicate, true);
  assert.equal(world.native.reloads.length, 1);
  assert.equal(world.transports.length, processes + 1);
  // Receipts stay: an earlier clientMessageId is a duplicate, never delivered again.
  const again = await d.request('session.prompt', { sessionId: 'rl', clientMessageId: 'rl-m0', content: [{ type: 'text', text: 'one' }] });
  assert.equal(again.duplicate, true);
  // The next prompt continues the same conversation in the new process.
  const transport = world.transports.at(-1);
  await d.request('session.prompt', { sessionId: 'rl', clientMessageId: 'rl-m2', content: [{ type: 'text', text: 'three' }] });
  await until(() => transport.calls.some(call => call.method === 'turn/start'), 'turn in the new process');
  assert.equal(transport.calls.find(call => call.method === 'turn/start').params.threadId, before.threadId);
  // The generation is the precondition of the first request only (as for a rewind): a repeat answers its result.
  assert.equal((await d.request('session.reload', { sessionId: 'rl', requestId: 'reload-1', ifGeneration: 'f'.repeat(32) })).duplicate, true);
  assert.equal(world.native.reloads.length, 1);
});

test('reload refusals record nothing: stale view, no conversation yet, a busy tree, a closed root, an assignment', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  // Never prompted: no conversation to keep (a Claude root would have no transcript).
  await d.request('session.create', { sessionId: 'fresh', spec: { cwd: d.project, persist: true } });
  await assert.rejects(d.request('session.reload', { sessionId: 'fresh', requestId: 'x1', ifGeneration: await generationOf(d, 'fresh') }), rpcError(1005, 'no_history'));
  await conversation(d, 'rb', ['one']);
  const generation = await generationOf(d, 'rb');
  await assert.rejects(d.request('session.reload', { sessionId: 'rb', requestId: 'x2', ifGeneration: 'f'.repeat(32) }), rpcError(1004, 'stale_generation'));
  await assert.rejects(d.request('session.reload', { sessionId: 'missing', requestId: 'x3', ifGeneration: generation }), rpcError(1001, 'not_found'));
  // A running turn.
  const transport = world.transports.at(-1);
  await d.request('session.prompt', { sessionId: 'rb', clientMessageId: 'rb-busy', content: [{ type: 'text', text: 'busy' }] });
  await until(() => transport.turnId === 'turn-0-2' || transport.calls.filter(call => call.method === 'turn/start').length === 2, 'second turn');
  await assert.rejects(d.request('session.reload', { sessionId: 'rb', requestId: 'x4', ifGeneration: generation }), rpcError(1004, 'session_busy'));
  transport.finish();
  await until(async () => !(await d.request('session.get', { sessionId: 'rb' })).session.activeTurnId, 'turn ended');
  assert.equal(world.native.reloads.length, 0, 'no refusal reached the runtime');
  // The same requestId goes through once the root is idle: nothing was recorded.
  const now = await generationOf(d, 'rb');
  await d.request('session.reload', { sessionId: 'rb', requestId: 'x4', ifGeneration: now });
  assert.equal(world.native.reloads.length, 1);
  // A closed root is opened, not reloaded.
  await d.request('session.close', { sessionId: 'rb' });
  await assert.rejects(d.request('session.reload', { sessionId: 'rb', requestId: 'x5', ifGeneration: now }), rpcError(1005, 'session_closed'));
  // resumeCommand: the CLI attach of that id; nothing else.
  const command = await d.request('session.resumeCommand', { sessionId: 'rb' });
  validateResult('session.resumeCommand', command);
  assert.deepEqual(command.argv, ['alp', 'attach', 'rb']);
  assert.equal(command.display, 'alp attach rb');
  assert.ok(!JSON.stringify(command).includes(d.project) && !JSON.stringify(command).includes(world.directory), 'no path');
  await assert.rejects(d.request('session.resumeCommand', { sessionId: 'nobody' }), rpcError(1001, 'not_found'));
});

test('a reload whose new process cannot resume answers native_refused; the root is closed with its conversation and reopens on it', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'rf', ['one']);
  const { threadId } = (await d.request('session.get', { sessionId: 'rf' })).session;
  const generation = await generationOf(d, 'rf');
  world.transports.at(-1);
  const failing = world.transports.length;
  world.native.reload = (sessionId, reload) => {
    // The next process refuses to resume, as a Claude CLI does for a missing transcript.
    const index = world.transports.length;
    const watch = setInterval(() => {
      const next = world.transports[index];
      if (!next || next.patched) return;
      next.patched = true;
      const request = next.request.bind(next);
      next.request = async (method, params) => { if (method === 'thread/resume') throw new Error(`no rollout found for thread id ${params.threadId}`); return request(method, params); };
    }, 0);
    return reload(sessionId).finally(() => clearInterval(watch));
  };
  // Patch synchronously too: the transport is made inside the runtime's queue.
  const original = world.transports.push;
  world.transports.push = function (transport) {
    const request = transport.request.bind(transport);
    if (this.length === failing) transport.request = async (method, params) => { if (method === 'thread/resume') throw new Error(`no rollout found for thread id ${params.threadId}`); return request(method, params); };
    return original.call(this, transport);
  };
  await assert.rejects(d.request('session.reload', { sessionId: 'rf', requestId: 'f1', ifGeneration: generation }), rpcError(1005, 'native_refused'));
  world.transports.push = original;
  world.native.reload = undefined;
  await until(async () => (await d.request('session.get', { sessionId: 'rf' })).session.status === 'closed', 'closed');
  const closed = (await d.request('session.get', { sessionId: 'rf' })).session;
  assert.equal(closed.threadId, threadId, 'the binding is kept');
  assert.equal(world.transports.slice(failing).flatMap(tr => tr.calls).filter(call => call.method === 'thread/start').length, 0, 'never an empty replacement thread');
  // The refusal is the answer of a repeat; a new requestId on the reopened root reloads it.
  await assert.rejects(d.request('session.reload', { sessionId: 'rf', requestId: 'f1', ifGeneration: generation }), rpcError(1005, 'native_refused'));
  await d.request('session.create', { sessionId: 'rf', spec: { cwd: d.project }, resume: true });
  const reopened = world.transports.at(-1);
  assert.deepEqual(reopened.calls.filter(call => call.method.startsWith('thread/')).map(call => [call.method, call.params.threadId]), [['thread/resume', threadId]]);
  const result = await d.request('session.reload', { sessionId: 'rf', requestId: 'f2', ifGeneration: await generationOf(d, 'rf') });
  assert.equal(result.session.threadId, threadId);
});

test('a reload in flight when alpd stops is outcome_unknown after the restart, never sent again', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'ru', ['one']);
  const generation = await generationOf(d, 'ru');
  world.native.reload = () => new Promise(() => {});
  const lost = d.request('session.reload', { sessionId: 'ru', requestId: 'u1', ifGeneration: generation }).catch(error => error);
  await until(() => world.native.reloads.length === 1, 'native step in flight');
  await d.stop();
  await lost;
  world.native.reload = undefined;
  const restarted = { ...await world.start(), ...world };
  await assert.rejects(restarted.request('session.reload', { sessionId: 'ru', requestId: 'u1', ifGeneration: generation }), rpcError(1004, 'outcome_unknown'));
  assert.equal(world.native.reloads.length, 1);
});

test('a prompt sent during a reload waits for it, then reaches the new process', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'rw', ['one']);
  const generation = await generationOf(d, 'rw');
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  world.native.reload = async (sessionId, reload) => { await gate; return reload(sessionId); };
  const reloading = d.request('session.reload', { sessionId: 'rw', requestId: 'w1', ifGeneration: generation });
  await until(() => world.native.reloads.length === 1, 'reload started');
  const old = world.transports.at(-1);
  const prompt = d.request('session.prompt', { sessionId: 'rw', clientMessageId: 'rw-late', content: [{ type: 'text', text: 'late' }] });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(old.calls.filter(call => call.method === 'turn/start').length, 1, 'the prompt waits');
  finish();
  await reloading;
  await prompt;
  const fresh = world.transports.at(-1);
  assert.notEqual(fresh, old);
  await until(() => fresh.calls.some(call => call.method === 'turn/start'), 'delivered to the new process');
});

test('mail that wakes the root while a reload reads its history waits for the new process; the reload is not refused busy', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  await conversation(d, 'rm', ['one']);
  const generation = await generationOf(d, 'rm');
  const old = world.transports.at(-1);
  // A session.message from another client lands between the idle check and the end of prepare.
  const timeline = d.store.timeline.bind(d.store);
  let sent = false;
  d.store.timeline = async sessionId => {
    if (sessionId === 'rm' && !sent) {
      sent = true;
      await d.request('session.message', { sessionId: 'rm', text: 'mail during reload' });
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return timeline(sessionId);
  };
  const result = await d.request('session.reload', { sessionId: 'rm', requestId: 'm1', ifGeneration: generation });
  d.store.timeline = timeline;
  assert.ok(sent, 'the mail went out during prepare');
  assert.equal(result.session.id, 'rm');
  assert.equal(world.native.reloads.length, 1);
  assert.equal(old.calls.filter(call => call.method === 'turn/start').length, 1, 'no wake turn on the old process');
  const fresh = world.transports.at(-1);
  assert.notEqual(fresh, old);
  await until(() => fresh.calls.some(call => call.method === 'turn/start'), 'the mail wakes the new process');
});

test('mail that wakes the root while a rewind reads its timeline waits for the rebind; the cut is not run over by a wake turn', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second] = await conversation(d, 'rw', ['one', 'two']);
  const generation = await generationOf(d, 'rw');
  const transport = world.transports.at(-1);
  const starts = transport.calls.filter(call => call.method === 'turn/start').length;
  // The read answers what the store held when it began; a session.message from another client lands before
  // it resolves, between the idle check and the end of prepare.
  const timeline = d.store.timeline.bind(d.store);
  let sent = false;
  d.store.timeline = async sessionId => {
    if (sessionId !== 'rw' || sent) return timeline(sessionId);
    sent = true;
    const read = await timeline(sessionId);
    await d.request('session.message', { sessionId: 'rw', text: 'mail during rewind' });
    // Unheld, the wake starts a turn here; held, none starts, and the wait ends at its bound.
    await within(500, () => d.runtime.snapshot('rw')?.activeTurnId);
    return read;
  };
  let during;
  world.native.branch = () => {
    during = { starts: transport.calls.filter(call => call.method === 'turn/start').length, active: d.runtime.snapshot('rw')?.activeTurnId };
    return { threadId: 'thread-after-wake' };
  };
  const result = await d.request('session.rewind', { sessionId: 'rw', requestId: 'rw1', ifGeneration: generation, beforeTurnId: second });
  d.store.timeline = timeline;
  assert.ok(sent, 'the mail went out during prepare');
  assert.equal(result.session.id, 'rw');
  assert.deepEqual(during, { starts, active: undefined }, 'no wake turn while the runtime cut the conversation');
  assert.equal(world.native.rebinds.length, 1);
  await until(() => transport.calls.filter(call => call.method === 'turn/start').length === starts + 1, 'the mail wakes the root after the rebind');
});

test('mail that wakes the source while a whole fork re-reads its timeline waits for the fork; the cut is not run over by a wake turn', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [first, second] = await conversation(d, 'fw', ['one', 'two']);
  const generation = await generationOf(d, 'fw');
  const transport = world.transports.at(-1);
  const starts = transport.calls.filter(call => call.method === 'turn/start').length;
  // The second read is the one after the prompt hold; the mail lands before it resolves.
  const timeline = d.store.timeline.bind(d.store);
  let reads = 0;
  let sent = false;
  d.store.timeline = async sessionId => {
    if (sessionId !== 'fw' || sent || ++reads < 2) return timeline(sessionId);
    sent = true;
    const read = await timeline(sessionId);
    await d.request('session.message', { sessionId: 'fw', text: 'mail during fork' });
    // Unheld, the wake starts a turn here; held, none starts, and the wait ends at its bound.
    await within(500, () => d.runtime.snapshot('fw')?.activeTurnId);
    return read;
  };
  let during;
  world.native.branch = request => {
    during = { starts: transport.calls.filter(call => call.method === 'turn/start').length, active: d.runtime.snapshot('fw')?.activeTurnId, turns: request.turns };
    return { threadId: 'thread-fork-wake' };
  };
  const result = await d.request('session.fork', { sessionId: 'fw', requestId: 'fw1', ifGeneration: generation });
  d.store.timeline = timeline;
  assert.ok(sent, 'the mail went out during prepare');
  assert.equal(result.forkedFrom.boundary, 'whole');
  assert.deepEqual(during, { starts, active: undefined, turns: [first, second] }, 'no wake turn while the runtime read the source');
  await until(() => transport.calls.filter(call => call.method === 'turn/start').length === starts + 1, 'the mail wakes the source after the fork');
});

test('a turn that began during prepare anyway (a runtime whose hold keeps nothing back) is refused busy before prepared; the same request goes through later', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second] = await conversation(d, 'rh', ['one', 'two']);
  await conversation(d, 'fh', ['one', 'two']);
  d.runtime.hold = () => undefined;
  // The nth read of a root during prepare answers the store as it began; mail wakes the root before it resolves.
  const timeline = d.store.timeline.bind(d.store);
  const woken = new Set();
  const counts = new Map();
  const wakeAt = { rh: 1, fh: 2 };
  d.store.timeline = async sessionId => {
    const read = await timeline(sessionId);
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    if (!(sessionId in wakeAt) || woken.has(sessionId) || counts.get(sessionId) < wakeAt[sessionId]) return read;
    woken.add(sessionId);
    await d.request('session.message', { sessionId, text: `mail during ${sessionId}` });
    await until(() => d.runtime.snapshot(sessionId)?.activeTurnId, `the wake turn of ${sessionId} started`);
    return read;
  };
  const rewind = { sessionId: 'rh', requestId: 'rh1', beforeTurnId: second };
  await assert.rejects(d.request('session.rewind', { ...rewind, ifGeneration: await generationOf(d, 'rh') }), rpcError(1004, 'session_busy'));
  const fork = { sessionId: 'fh', requestId: 'fh1' };
  await assert.rejects(d.request('session.fork', { ...fork, ifGeneration: await generationOf(d, 'fh') }), rpcError(1004, 'session_busy'));
  d.store.timeline = timeline;
  assert.deepEqual([...woken], ['rh', 'fh']);
  assert.equal(world.native.branches.length, 0, 'the runtime cut nothing');
  // The refusals recorded nothing: once the wake turns end, the same requests go through.
  for (const root of ['rh', 'fh']) {
    const transport = world.transports.find(candidate => candidate.turnId === d.runtime.snapshot(root).activeTurnId);
    transport.finish('woken');
    await until(async () => !(await d.request('session.get', { sessionId: root })).session.activeTurnId, `the wake turn of ${root} ended`);
  }
  const rewound = await d.request('session.rewind', { ...rewind, ifGeneration: await generationOf(d, 'rh') });
  assert.equal(rewound.duplicate, undefined);
  const forked = await d.request('session.fork', { ...fork, ifGeneration: await generationOf(d, 'fh') });
  assert.equal(forked.duplicate, undefined);
  assert.equal(forked.forkedFrom.boundary, 'whole');
  assert.equal(world.native.branches.length, 2);
  assert.equal(world.native.rebinds.length, 1);
});

/** Makes the next turn/start of `transport` wait until the returned function is called. */
function gateStart(transport) {
  let open;
  transport.hold = new Promise(resolve => { open = resolve; });
  return () => { transport.hold = undefined; open(); };
}

test('a whole fork refuses while a mail wake of the source is starting its turn (turn/start sent, no turn id yet); the runtime reads nothing', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [first, second] = await conversation(d, 'fs', ['one', 'two']);
  const transport = world.transports.at(-1);
  const starts = transport.calls.filter(call => call.method === 'turn/start').length;
  const open = gateStart(transport);
  const fork = { sessionId: 'fs', requestId: 'fs1' };
  // Opened however the checks end: a turn/start left waiting would keep the runtime from shutting down.
  try {
    await d.request('session.message', { sessionId: 'fs', text: 'mail before the fork' });
    await until(() => transport.calls.filter(call => call.method === 'turn/start').length === starts + 1, 'the wake sent turn/start');
    assert.equal(d.runtime.snapshot('fs').activeTurnId, undefined, 'no turn id yet');
    await assert.rejects(d.request('session.fork', { ...fork, ifGeneration: await generationOf(d, 'fs') }), rpcError(1004, 'turn_in_progress'));
    assert.equal(world.native.branches.length, 0, 'the runtime read nothing while the wake turn started');
  } finally { open(); }
  // The refusal recorded nothing: once the wake turn ends, the same request goes through and keeps it.
  await until(() => d.runtime.snapshot('fs')?.activeTurnId, 'the wake turn started');
  const wake = transport.turnId;
  transport.finish('woken');
  await until(async () => !(await d.request('session.get', { sessionId: 'fs' })).session.activeTurnId, 'the wake turn ended');
  const forked = await d.request('session.fork', { ...fork, ifGeneration: await generationOf(d, 'fs') });
  assert.equal(forked.duplicate, undefined);
  assert.equal(forked.forkedFrom.boundary, 'whole');
  assert.deepEqual(world.native.branches.map(request => request.turns), [[first, second, wake]]);
});

test('a wake still starting its turn when prepare ends (a runtime whose hold keeps nothing back) is refused busy before prepared: rewind, whole fork, reload', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const transports = {};
  const [, second] = await conversation(d, 'rp', ['one', 'two']);
  transports.rp = world.transports.at(-1);
  await conversation(d, 'fp', ['one', 'two']);
  transports.fp = world.transports.at(-1);
  await conversation(d, 'lp', ['one']);
  transports.lp = world.transports.at(-1);
  d.runtime.hold = () => undefined;
  // The nth read of a root during prepare answers the store as it began; before it resolves, mail wakes
  // the root and the wake's turn/start is sent, but not answered, so it has no turn id yet.
  const timeline = d.store.timeline.bind(d.store);
  const opens = new Map();
  const counts = new Map();
  const wakeAt = { rp: 1, fp: 2, lp: 1 };
  d.store.timeline = async sessionId => {
    const read = await timeline(sessionId);
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    if (!(sessionId in wakeAt) || opens.has(sessionId) || counts.get(sessionId) < wakeAt[sessionId]) return read;
    const transport = transports[sessionId];
    const starts = transport.calls.filter(call => call.method === 'turn/start').length;
    opens.set(sessionId, gateStart(transport));
    await d.request('session.message', { sessionId, text: `mail during ${sessionId}` });
    await until(() => transport.calls.filter(call => call.method === 'turn/start').length === starts + 1, `the wake of ${sessionId} sent turn/start`);
    return read;
  };
  const cases = [
    { root: 'rp', method: 'session.rewind', params: { sessionId: 'rp', requestId: 'rp1', beforeTurnId: second } },
    { root: 'fp', method: 'session.fork', params: { sessionId: 'fp', requestId: 'fp1' } },
    { root: 'lp', method: 'session.reload', params: { sessionId: 'lp', requestId: 'lp1' } },
  ];
  // One root at a time: the runtime runs its operations, a wake's turn/start among them, one after another.
  // While a wake waits, a reload that got past prepare answers at once: the runtime's own would queue
  // behind the waiting turn/start. Opened however the checks end: a turn/start left waiting would keep the
  // runtime from shutting down.
  world.native.reload = async () => { throw new Error('the reload reached the runtime while a wake started its turn'); };
  try {
    for (const { root, method, params } of cases) {
      try {
        await assert.rejects(d.request(method, { ...params, ifGeneration: await generationOf(d, root) }), rpcError(1004, 'session_busy'), method);
        assert.ok(opens.has(root), `the mail went out during the ${method} prepare`);
        assert.equal(d.runtime.snapshot(root).activeTurnId, undefined, `the wake of ${root} has no turn id when refused`);
      } finally { opens.get(root)?.(); }
      await until(() => d.runtime.snapshot(root)?.activeTurnId, `the wake turn of ${root} started`);
      transports[root].finish('woken');
      await until(async () => !(await d.request('session.get', { sessionId: root })).session.activeTurnId, `the wake turn of ${root} ended`);
    }
    assert.equal(world.native.branches.length, 0, 'the runtime cut nothing');
    assert.equal(world.native.reloads.length, 0, 'nothing restarted');
  } finally {
    d.store.timeline = timeline;
    world.native.reload = undefined;
    for (const open of opens.values()) open();
  }
  // The refusals recorded nothing: the same requests go through now.
  const answers = [];
  for (const { root, method, params } of cases) answers.push(await d.request(method, { ...params, ifGeneration: await generationOf(d, root) }));
  assert.equal(answers[0].duplicate, undefined);
  assert.equal(answers[1].forkedFrom.boundary, 'whole');
  assert.equal(answers[2].duplicate, undefined);
  assert.equal(world.native.branches.length, 2);
  assert.equal(world.native.rebinds.length, 1);
  assert.equal(world.native.reloads.length, 1);
});

test('a parked source resumed while a whole fork reads it stays parked until the fork ends, then continues; no turn of it begins while the runtime reads', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [first, second] = await conversation(d, 'pf', ['one', 'two']);
  const transport = world.transports.at(-1);
  const kind = d.runtime.snapshot('pf').runtime;
  // A root parked while its runtime is paused (as alpd's recovery parks one); a whole fork may read it.
  d.runtime.pause({ runtime: kind });
  await d.runtime.recover('pf', { continueRoot: true });
  assert.ok(d.runtime.snapshot('pf').parked, 'the source is parked');
  const starts = transport.calls.filter(call => call.method === 'turn/start').length;
  let release;
  let during;
  world.native.branch = request => new Promise(resolve => { release = () => resolve({ threadId: 'thread-fork-parked', turns: request.turns }); });
  const forking = d.request('session.fork', { sessionId: 'pf', requestId: 'pf1', ifGeneration: await generationOf(d, 'pf') });
  // Released however the checks end, so the fork and the runtime can finish.
  try {
    await until(() => release, 'the runtime reads the source');
    // The runtime is resumed while the fork reads: unheld, the parked source continues in a new turn here.
    d.runtime.resume({ runtime: kind });
    await within(500, () => transport.calls.filter(call => call.method === 'turn/start').length > starts);
    during = { starts: transport.calls.filter(call => call.method === 'turn/start').length, parked: !!d.runtime.snapshot('pf').parked };
  } finally { release?.(); }
  const result = await forking;
  assert.equal(result.forkedFrom.boundary, 'whole');
  assert.deepEqual(world.native.branches.map(request => request.turns), [[first, second]]);
  assert.deepEqual(during, { starts, parked: true }, 'the source stayed parked while the runtime read it');
  // Not dropped: once the fork lets go of the source, it continues where it stopped.
  await until(() => transport.calls.filter(call => call.method === 'turn/start').length === starts + 1, 'the source continues after the fork');
  assert.match(JSON.stringify(transport.calls.filter(call => call.method === 'turn/start').at(-1).params), /alpd restarted during your turn.*Continue the user's request/);
  assert.equal(d.runtime.snapshot('pf').parked, undefined);
});

for (const operation of ['fork', 'rewind', 'reload']) {
  test(`${operation} unknown startup never replays over a later rewind or changes its generation`, async t => {
    const world = await setup(t);
    let d = { ...await world.start(), ...world };
    const [, second] = await conversation(d, 'unknown-root', ['one', 'two']);
    const originalGeneration = await generationOf(d, 'unknown-root');
    const params = { sessionId: 'unknown-root', requestId: 'unknown-old', ifGeneration: originalGeneration,
      ...(operation === 'rewind' ? { beforeTurnId: second } : operation === 'fork' ? { newSessionId: 'unknown-fork' } : {}) };
    const unknown = async () => { throw Object.assign(new Error('answer lost'), { outcomeUnknown: true }); };
    if (operation === 'reload') world.native.reload = unknown;
    else world.native.branch = unknown;
    await assert.rejects(d.request(`session.${operation}`, params), rpcError(1004, 'outcome_unknown'));
    world.native.reload = world.native.branch = undefined;
    // A later confirmed mutation is authoritative even before the unknown is first seen at startup.
    const later = await d.request('session.rewind', { sessionId: 'unknown-root', requestId: 'later', ifGeneration: originalGeneration, beforeTurnId: second });
    const expectedThread = world.native.rebinds.at(-1).binding.threadId;
    await d.request('session.close', { sessionId: 'unknown-root' });
    const history = await d.request('session.history', { sessionId: 'unknown-root' });
    const calls = { branches: world.native.branches.length, reloads: world.native.reloads.length, rebinds: world.native.rebinds.length };
    await d.stop();
    let seen;
    for (let restart = 0; restart < 3; restart++) {
      d = { ...await world.start(), ...world };
      const current = (await d.request('session.get', { sessionId: 'unknown-root' })).session;
      assert.equal(current.threadId, expectedThread);
      assert.deepEqual(current.branches, later.session.branches);
      assert.deepEqual(await d.request('session.history', { sessionId: 'unknown-root' }), history);
      await assert.rejects(d.request(`session.${operation}`, params), rpcError(1004, 'outcome_unknown'));
      const entries = await Promise.all((await readdir(path.join(world.state, 'lifecycle'))).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(path.join(world.state, 'lifecycle', name), 'utf8'))));
      const entry = entries.find(entry => entry.requestId === 'unknown-old');
      assert.equal(entry.state, 'unknown');
      assert.equal(typeof entry.recoverySeenAt, 'string');
      if (seen) assert.deepEqual(entry, seen, 'observed only on first startup');
      seen = entry;
      if (operation === 'fork') await assert.rejects(d.request('session.get', { sessionId: 'unknown-fork' }), /Session is not open/);
      assert.deepEqual({ branches: world.native.branches.length, reloads: world.native.reloads.length, rebinds: world.native.rebinds.length }, calls);
      await d.stop();
    }
  });
}


for (const replay of [false, true]) {
  test(`rewind attach handover holds a generation-less attach during marker commit (replay=${replay})`, async t => {
    const world = await setup(t);
    const d = { ...await world.start(), ...world };
    const [, second] = await conversation(d, 'handover', ['one', 'two']);
    const generation = await generationOf(d, 'handover');
    const before = await d.open();
    await before.request('session.attach', { sessionId: 'handover', replay: false, generation });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(release);
    let entered = false;
    const rewind = d.store.rewind;
    // commitRewind has journaled/allocated the marker cursor, but has not published it.
    d.store.rewind = async (...args) => { entered = true; await gate; return rewind(...args); };
    const params = { sessionId: 'handover', requestId: 'handover', ifGeneration: generation, beforeTurnId: second };
    const rewinding = d.request('session.rewind', params);
    await until(() => entered, 'marker commit gate');
    const during = await d.open();
    let responseIndex;
    const attaching = during.request('session.attach', { sessionId: 'handover', replay })
      .then(result => { responseIndex = during.events.length; return result; });
    const aware = await d.open();
    const stale = assert.rejects(aware.request('session.attach', { sessionId: 'handover', replay, generation }), rpcError(1004, 'stale_cursor'));
    // RPC frames on this socket are ordered: the attach handler ran before this barrier.
    await during.request('daemon.status');
    await aware.request('daemon.status');
    release();
    const result = await attaching;
    const rewound = await rewinding;
    await stale;
    await before.request('daemon.status');
    await during.request('daemon.status');
    const markers = events => events.filter(e => e.event.type === 'item' && e.event.item.id === `rewind:${rewound.branch.branchId}`);
    assert.equal(markers(before.events).length, 1, 'an already attached viewer receives one live marker');
    const marker = markers(before.events)[0];
    assert.ok(result.cursor >= marker.cursor, 'attach response includes the reserved marker in its tip');
    const late = during.events.slice(responseIndex).filter(e => e.cursor !== undefined && e.cursor <= result.cursor);
    assert.deepEqual(late, [], 'no live cursor at or below the attach response tip (§8.3)');
    assert.equal(markers(during.events).length, replay ? 1 : 0, 'marker is replayed once, or excluded by replay=false');
    const after = await d.open();
    await after.request('session.attach', { sessionId: 'handover', generation: rewound.generation, replay: true });
    assert.equal(markers(after.events).length, 1, 'attach after commit replays the marker once');
    await assert.rejects(after.request('session.attach', { sessionId: 'handover', generation }), rpcError(1004, 'stale_cursor'));
    assert.equal((await d.request('session.rewind', params)).duplicate, true);
    await before.request('daemon.status');
    assert.equal(markers(before.events).length, 1, 'committed repeat does not broadcast again');
  });
}


test('rewind attach handover rereads history if a rewind finishes during the attach history read', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second] = await conversation(d, 'read-race', ['one', 'two']);
  const generation = await generationOf(d, 'read-race');
  // A closed root has no in-memory replay coverage, so attach reads the durable timeline.
  await d.request('session.close', { sessionId: 'read-race' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  let entered = false;
  const timeline = d.store.timeline;
  d.store.timeline = async (...args) => {
    const result = await timeline(...args);
    if (!entered) { entered = true; await gate; }
    return result;
  };
  const viewer = await d.open();
  const attaching = viewer.request('session.attach', { sessionId: 'read-race' });
  await until(() => entered, 'attach history read');
  const rewound = await d.request('session.rewind', { sessionId: 'read-race', requestId: 'read-race', ifGeneration: generation, beforeTurnId: second });
  release();
  const attached = await attaching;
  assert.ok(!viewer.events.some(e => e.event.type === 'item' && e.event.item.text === 'two'), 'discarded history must not replay');
  const marker = viewer.events.find(e => e.event.type === 'item' && e.event.item.id === `rewind:${rewound.branch.branchId}`);
  assert.ok(marker, 'kept marker must replay');
  assert.ok(attached.cursor >= marker.cursor);
});

test('rewind attach handover releases queued attaches on commit failure and replay after restart keeps one marker', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second] = await conversation(d, 'failed-handover', ['one', 'two']);
  const generation = await generationOf(d, 'failed-handover');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  let entered = false;
  const rewind = d.store.rewind;
  d.store.rewind = async () => { entered = true; await gate; throw new Error('commit blocked'); };
  const params = { sessionId: 'failed-handover', requestId: 'failed-handover', ifGeneration: generation, beforeTurnId: second };
  const failed = assert.rejects(d.request('session.rewind', params), rpcError(1000, 'persistence_failed'));
  await until(() => entered, 'failing marker commit');
  const viewer = await d.open();
  const attaching = assert.rejects(viewer.request('session.attach', { sessionId: 'failed-handover' }), rpcError(1004, 'session_busy'));
  await viewer.request('daemon.status');
  release();
  await failed;
  await attaching;
  d.store.rewind = rewind;
  await d.stop();
  const restarted = { ...await world.start(), ...world };
  const attached = await restarted.request('session.attach', { sessionId: 'failed-handover' });
  const markers = restarted.events.filter(e => e.event.type === 'item' && e.event.item.id?.startsWith('rewind:'));
  assert.equal(markers.length, 1, 'applied journal recovery persists one marker');
  assert.ok(attached.cursor >= markers[0].cursor);
  assert.equal((await restarted.request('session.rewind', params)).duplicate, true);
  await restarted.request('daemon.status');
  assert.equal(restarted.events.filter(e => e.event.type === 'item' && e.event.item.id?.startsWith('rewind:')).length, 1);
  assert.equal(world.native.branches.length, 1, 'recovery never repeats the native step');
});


test('rewind attach handover revalidates generation if rewind finishes during the checkpoint read', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second] = await conversation(d, 'checkpoint-race', ['one', 'two']);
  const generation = await generationOf(d, 'checkpoint-race');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  let entered = false;
  const history = d.store.history;
  d.store.history = async (...args) => {
    const result = await history(...args);
    if (!entered) { entered = true; await gate; }
    return result;
  };
  const viewer = await d.open();
  const attaching = assert.rejects(viewer.request('session.attach', { sessionId: 'checkpoint-race', generation, replay: false }), rpcError(1004, 'stale_cursor'));
  await until(() => entered, 'attach checkpoint read');
  await d.request('session.rewind', { sessionId: 'checkpoint-race', requestId: 'checkpoint-race', ifGeneration: generation, beforeTurnId: second });
  release();
  await attaching;
  assert.equal(viewer.events.length, 0, 'stale attach never registers a live subscription');
});

for (const retryBeforeRestart of [false, true]) {
  test(`marker write failure (retry=${retryBeforeRestart}): old rewind replay preserves later thread and generation`, async t => {
    const world = await setup(t);
    const d = { ...await world.start(), ...world };
    const [, second, third] = await conversation(d, 'marker-rewind', ['one', 'two', 'three']);
    const first = { sessionId: 'marker-rewind', requestId: 'marker-old', ifGeneration: await generationOf(d, 'marker-rewind'), beforeTurnId: third };
    const restore = failCommittedMarker(d.store, world.state, first.requestId);
    const original = await d.request('session.rewind', first);
    assert.equal((await restore()).state, 'applied');
    const latest = await d.request('session.rewind', { ...first, requestId: 'marker-new', ifGeneration: original.generation, beforeTurnId: second });
    const generation = await generationOf(d, first.sessionId);
    if (retryBeforeRestart) {
      const repeat = await d.request('session.rewind', first);
      assert.equal(repeat.duplicate, true);
      assert.equal(repeat.generation, original.generation);
      assert.equal(await generationOf(d, first.sessionId), generation);
      assert.equal(world.native.rebinds.length, 2, 'receipt retry cannot rebind old thread');
    }
    await d.stop();
    const restarted = { ...await world.start(), ...world };
    assert.equal((await restarted.request('session.get', { sessionId: first.sessionId })).session.threadId, 'thread-branch-2');
    assert.equal(await generationOf(restarted, first.sessionId), generation);
    const repeat = await restarted.request('session.rewind', first);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.generation, original.generation, 'historical receipt keeps its generation');
    assert.equal(repeat.session.threadId, 'thread-branch-2');
    assert.equal(await generationOf(restarted, first.sessionId), generation);
    assert.equal(world.native.branches.length, 2);
    assert.equal(world.native.rebinds.length, 2, 'no rebind from replay');
    await restarted.stop();
    const again = await world.start();
    assert.equal(await generationOf(again, first.sessionId), generation);
  });
}

test('fork marker loss replays continuation without replacing later target history or title', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [first] = await conversation(d, 'fork-marker-source', ['one', 'two']);
  const params = { sessionId: 'fork-marker-source', requestId: 'fork-marker', ifGeneration: await generationOf(d, 'fork-marker-source'), boundary: { throughTurnId: first }, newSessionId: 'fork-marker-target' };
  const restore = failCommittedMarker(d.store, world.state, params.requestId);
  await d.request('session.fork', params);
  assert.equal((await restore()).state, 'applied');
  await d.request('session.rename', { sessionId: params.newSessionId, title: 'later target title' });
  await d.request('session.create', { sessionId: params.newSessionId, spec: { cwd: world.project, persist: true }, resume: true });
  await d.request('session.prompt', { sessionId: params.newSessionId, clientMessageId: 'after-fork', content: [{ type: 'text', text: 'later target turn' }] });
  const transport = world.transports.at(-1);
  await until(() => transport.turnId, 'target turn');
  transport.finish('later target answer');
  await until(async () => !(await d.request('session.get', { sessionId: params.newSessionId })).session.activeTurnId, 'target idle');
  const generation = await generationOf(d, params.newSessionId);
  const timeline = await d.store.timeline(params.newSessionId);
  await d.stop();
  const restarted = await world.start();
  assert.equal((await restarted.request('session.get', { sessionId: params.newSessionId })).session.title, 'later target title');
  assert.equal(await generationOf(restarted, params.newSessionId), generation);
  assert.deepEqual(await restarted.store.timeline(params.newSessionId), timeline);
  assert.equal((await restarted.request('session.fork', params)).duplicate, true);
  assert.equal(world.native.branches.length, 1);
});

test('legacy applied rewind with newer journal evidence preserves the later thread and generation', async t => {
  const world = await setup(t);
  const d = { ...await world.start(), ...world };
  const [, second, third] = await conversation(d, 'legacy-rewind', ['one', 'two', 'three']);
  const params = { sessionId: 'legacy-rewind', requestId: 'legacy-old', ifGeneration: await generationOf(d, 'legacy-rewind'), beforeTurnId: third };
  const restore = failCommittedMarker(d.store, world.state, params.requestId);
  const first = await d.request('session.rewind', params);
  const old = await restore();
  await d.request('session.rewind', { ...params, requestId: 'legacy-new', ifGeneration: first.generation, beforeTurnId: second });
  const generation = await generationOf(d, params.sessionId);
  await d.stop();
  const record = await d.store.get(params.sessionId);
  delete record.lifecycleCommits;
  await d.store.put(record);
  delete old.attemptId;
  await writeFile(path.join(world.state, 'lifecycle', `${old.key}.json`), JSON.stringify(old));
  const restarted = await world.start();
  assert.equal((await restarted.request('session.get', { sessionId: params.sessionId })).session.threadId, 'thread-branch-2');
  assert.equal(await generationOf(restarted, params.sessionId), generation);
  await assert.rejects(restarted.request('session.rewind', params), rpcError(1000, 'persistence_failed'));
  assert.equal(world.native.branches.length, 2);
  assert.equal(world.native.rebinds.length, 2);
});
