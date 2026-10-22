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
  const native = { branches: [], rebinds: [], next: 0, branch: undefined, rebind: undefined };
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
  assert.deepEqual(before.session.conversation, { fork: true, rewind: true });
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
