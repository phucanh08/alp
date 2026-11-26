// alpd's store under failing writes and cut-short data, and prompt delivery under retries,
// reconnects and cancellation (ALPD §66). In process with a scripted runtime, so each race
// is ordered by the test rather than by timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rename, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';

async function until(check, what = 'condition') {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} did not happen`);
}

/** A scripted native runtime; set `hold` to a promise to keep turn/start unanswered until it settles. */
function fakeTransport(runtimes) {
  return () => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() {},
      async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/resume') return { thread: { id: params.threadId } };
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { await this.hold; this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        if (method === 'turn/interrupt') { queueMicrotask(() => this.notification('turn/completed', { threadId: this.threadId, turn: { id: params.turnId, status: 'interrupted' } })); return {}; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `out-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

/** A daemon with a real store in `directory`; `start` again on the same directory is a restart. */
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-persist-'));
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] } }));
  const runtimes = [];
  const stops = [];
  t.after(async () => { for (const stop of stops.reverse()) await stop(); await rm(directory, { recursive: true, force: true }); });
  const state = path.join(directory, 'state');
  let count = 0;
  async function start() {
    const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), runLogDir: path.join(directory, 'runs') });
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
    // Without a clean runtime shutdown, as a crash leaves the store.
    const stop = async () => { if (stopped) return; stopped = true; clients.forEach(client => client.close()); await store.flush().catch(() => {}); await server.close().catch(() => {}); await runtime.shutdown(); };
    stops.push(stop);
    /** As a crash leaves things: the server is gone, a held delivery never finishes in this alpd. */
    const crash = async () => { clients.forEach(client => client.close()); await store.flush().catch(() => {}); await server.close().catch(() => {}); };
    const first = await open();
    // A request waits for the startup restore; Windows cannot move a directory it is still reading.
    await first.request('daemon.status');
    return { runtime, store, server, open, stop, crash, ...first };
  }
  /** Makes one of the store's directories unwritable by putting a file where it was; returns the undo. */
  async function breakDir(name) {
    const dir = path.join(state, name);
    await rename(dir, `${dir}.saved`);
    await writeFile(dir, 'not a directory');
    return async () => { await rm(dir, { force: true }); await rename(`${dir}.saved`, dir); };
  }
  const create = (daemon, params = {}) => daemon.request('session.create', { spec: { cwd: project, persist: true }, ...params });
  return { directory, state, project, runtimes, start, breakDir, create };
}

const text = body => [{ type: 'text', text: body }];
const reason = expected => error => error?.data?.reason === expected;

test('store writes report their failures, keep their order, and recover once the disk does', async t => {
  const { state, breakDir } = await setup(t);
  const store = createStore(state);
  const receipt = state => ({ version: 1, sessionId: 's', clientMessageId: 'm', fingerprint: 'f', state, updatedAt: new Date().toISOString() });
  await store.putReceipt('k', receipt('pending'));
  const undo = await breakDir('receipts');
  await assert.rejects(store.putReceipt('k', receipt('completed')), process.platform === 'win32' ? /ENOENT/ : /ENOTDIR|EEXIST|not a directory/i);
  assert.equal(store.health().ok, false);
  assert.equal(store.health().failures, 1);
  assert.match(store.health().lastError.operation, /receipt m/);
  // A failed write does not stop the ones queued after it.
  await undo();
  await store.putReceipt('k', receipt('completed'));
  assert.equal((await store.receipt('k')).state, 'completed');
  assert.deepEqual((await readdir(path.join(state, 'receipts'))).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left');

  const undoTimeline = await breakDir('timeline');
  await assert.rejects(store.append('root', { sessionId: 'root', epoch: 'e', seq: 1, cursor: 1, ts: '', event: { type: 'session.ready' } }));
  await undoTimeline();
  await store.append('root', { sessionId: 'root', epoch: 'e', seq: 2, cursor: 2, ts: '', event: { type: 'session.ready' } });
  // A timeline that lost a line stays failed: the gap remains.
  assert.deepEqual(await store.drain({ timelines: ['root'] }), ['root']);
  assert.equal(store.health().failures, 2);
});

test('a timeline line cut short is removed before the next append, or completed when it is whole', async t => {
  const { state } = await setup(t);
  const store = createStore(state);
  const file = path.join(state, 'timeline', 'r.jsonl');
  // Creates the store's directories.
  await store.list();
  const line = n => JSON.stringify({ sessionId: 'r', epoch: 'e', seq: n, cursor: n, ts: '', event: { type: 'session.ready' } });
  await writeFile(file, `${line(1)}\n${line(2).slice(0, 25)}`);
  assert.deepEqual((await store.timeline('r')).map(e => e.cursor), [1], 'reading skips the cut line');
  await store.append('r', JSON.parse(line(2)));
  assert.equal(await readFile(file, 'utf8'), `${line(1)}\n${line(2)}\n`);

  // A whole last line missing only its newline is kept.
  const fresh = createStore(state);
  await writeFile(file, `${line(1)}\n${line(2)}`);
  await fresh.append('r', JSON.parse(line(3)));
  assert.deepEqual((await fresh.timeline('r')).map(e => e.cursor), [1, 2, 3]);

  // Lines from before cursors count on from the previous one.
  await writeFile(file, `${JSON.stringify({ sessionId: 'r', epoch: 'e', seq: 1, ts: '', event: { type: 'session.ready' } })}\nnot json\n${JSON.stringify({ sessionId: 'r', epoch: 'e', seq: 2, ts: '', event: { type: 'session.ready' } })}\n`);
  assert.deepEqual((await fresh.timeline('r')).map(e => e.cursor), [1, 2]);
});

// Read-only directories do not stop root, and Windows has no such modes.
const readOnlyDirs = process.platform === 'win32' || process.getuid?.() === 0 ? 'needs POSIX permissions as a regular user' : false;

test('a prompt whose pending receipt cannot be written is refused and not sent; the same id sends once the disk recovers', { skip: readOnlyDirs }, async t => {
  const { runtimes, start, breakDir, create, state } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const prompt = () => daemon.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') });
  // Receipts can be read but not written.
  await chmod(path.join(state, 'receipts'), 0o500);
  t.after(() => chmod(path.join(state, 'receipts'), 0o700).catch(() => {}));
  await assert.rejects(prompt(), error => error.data?.reason === 'persistence_failed' && /it was not sent/.test(error.message));
  assert.equal(runtimes[0].started.length, 0);
  assert.equal((await daemon.request('daemon.status')).persistence.ok, false);
  await chmod(path.join(state, 'receipts'), 0o700);
  // Nor is anything sent when the receipt cannot even be looked up.
  const undo = await breakDir('receipts');
  await assert.rejects(prompt(), reason('persistence_failed'));
  assert.equal(runtimes[0].started.length, 0);
  await undo();
  assert.deepEqual(await daemon.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') }), { outcome: 'accepted', durable: true });
  assert.equal(runtimes[0].started.length, 1);
});

test('a delivered prompt whose completed receipt cannot be written says it is not durable; after a restart the timeline settles it', async t => {
  const { runtimes, start, breakDir, create } = await setup(t);
  const first = await start();
  const { session } = await create(first);
  let release;
  runtimes[0].hold = new Promise(resolve => { release = resolve; });
  const sent = first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') });
  await until(() => runtimes[0].started.length === 1, 'turn/start');
  const undo = await breakDir('receipts');
  release();
  assert.deepEqual(await sent, { outcome: 'accepted', durable: false });
  // This alpd remembers it delivered the message.
  assert.deepEqual(await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') }), { outcome: 'accepted', duplicate: true, durable: false });
  assert.equal(runtimes[0].started.length, 1);
  await undo();
  runtimes[0].finish();
  await first.stop();

  // The disk still holds the pending receipt; the timeline shows how the runtime answered.
  const second = await start();
  await create(second, { sessionId: session.id });
  const kept = await second.store.receipts();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].receipt.state, 'completed', 'the timeline shows the runtime accepted it');
  assert.equal(kept[0].receipt.reconciled, true);
  assert.deepEqual(await second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') }), { outcome: 'accepted', duplicate: true, durable: true });
});

test('a pending receipt with no answer in the timeline stays outcome unknown; an unreadable one too', async t => {
  const { runtimes, start, create, state } = await setup(t);
  const first = await start();
  const { session } = await create(first);
  let release;
  runtimes[0].hold = new Promise(resolve => { release = resolve; });
  void first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') }).catch(() => {});
  await until(() => runtimes[0].started.length === 1, 'turn/start');
  await first.crash();
  try {
    const second = await start();
    await create(second, { sessionId: session.id });
    await assert.rejects(second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') }), reason('outcome_unknown'));
    const [file] = (await readdir(path.join(state, 'receipts'))).filter(name => name.endsWith('.json'));
    await writeFile(path.join(state, 'receipts', file), '{"version":1,"sta');
    await assert.rejects(second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') }), reason('outcome_unknown'));
    assert.equal(runtimes.at(-1).started.length, 0);
  } finally {
    // The first runtime can shut down once its held turn is answered.
    release();
  }
});

test('a session whose record cannot be written is not started; a rename that cannot be saved fails', async t => {
  const { runtimes, start, breakDir, create } = await setup(t);
  const daemon = await start();
  const undo = await breakDir('sessions');
  await assert.rejects(create(daemon, { sessionId: 'unsaved' }), reason('persistence_failed'));
  assert.equal(runtimes.length, 0);
  assert.deepEqual((await daemon.request('session.list', { includeClosed: true })).sessions, []);
  await undo();
  const { session } = await create(daemon);
  const again = await breakDir('sessions');
  await assert.rejects(daemon.request('session.rename', { sessionId: session.id, title: 'Named' }), reason('persistence_failed'));
  assert.equal((await daemon.request('session.get', { sessionId: session.id })).session.title, undefined, 'an unsaved name is not shown either');
  await again();
});

test('a timeline write failure makes the prompt answer not durable and shows in daemon.status', async t => {
  const { start, breakDir, create } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  await daemon.store.flush();
  const undo = await breakDir('timeline');
  const answer = await daemon.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') });
  await undo();
  assert.deepEqual(answer, { outcome: 'accepted', durable: false });
  const { persistence } = await daemon.request('daemon.status');
  assert.equal(persistence.ok, false);
  assert.match(persistence.lastError.operation, new RegExp(`timeline ${session.id}`));
});

test('retries of one id: concurrent ones wait for the first, a failed delivery answers its failure, other content conflicts', async t => {
  const { runtimes, start, create } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const prompt = (id, body) => daemon.request('session.prompt', { sessionId: session.id, clientMessageId: id, content: text(body) });
  const answers = await Promise.all([prompt('m1', 'Hello'), prompt('m1', 'Hello'), prompt('m1', 'Hello')]);
  assert.deepEqual(answers.map(answer => !!answer.duplicate), [false, true, true]);
  assert.equal(runtimes[0].started.length, 1);
  // A turn is running, so a second turn is refused by the runtime: that answer is recorded too.
  const refused = await prompt('m2', 'Again');
  assert.equal(refused.outcome, 'failed');
  assert.match(refused.error.message, /Turn already active/);
  assert.deepEqual(await prompt('m2', 'Again'), { ...refused, duplicate: true });
  await assert.rejects(prompt('m2', 'Changed'), reason('key_conflict'));
  assert.equal(runtimes[0].started.length, 1);
});

test('cancellation races: an interrupt sent with a prompt cancels its turn; a client gone mid-delivery still gets one delivery', async t => {
  const { runtimes, start, create } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  let release;
  runtimes[0].hold = new Promise(resolve => { release = resolve; });
  const prompted = daemon.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Work') });
  await until(() => runtimes[0].started.length === 1, 'turn/start');
  // The runtime orders operations: the interrupt applies to the turn the prompt is starting.
  const interrupted = daemon.request('session.interrupt', { sessionId: session.id });
  release();
  assert.equal((await prompted).outcome, 'accepted');
  await interrupted;
  assert.equal(runtimes[0].calls.filter(call => call.method === 'turn/interrupt').length, 1);
  await until(() => daemon.events.some(e => e.event.type === 'turn.ended'), 'the turn to end');

  // A client that disconnects while its prompt is in flight: delivery completes, and its retry is a duplicate.
  const viewer = await daemon.open();
  await viewer.request('session.attach', { sessionId: session.id });
  runtimes[0].hold = new Promise(resolve => { release = resolve; });
  const lost = viewer.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('More') }).catch(error => error);
  await until(() => runtimes[0].started.length === 2, 'the second turn/start');
  viewer.client.close();
  assert.match(String((await lost).message), /closed/);
  release();
  const back = await daemon.open();
  await back.request('session.attach', { sessionId: session.id, replay: false });
  assert.equal((await back.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('More') })).duplicate, true);
  assert.equal(runtimes[0].started.length, 2);
});

test('reconnect with a cursor replays only what the client missed, in order, and closing does not reset cursors', async t => {
  const { runtimes, start, create } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  await daemon.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('One') });
  runtimes[0].finish('First');
  await until(() => daemon.events.some(e => e.event.type === 'turn.ended'), 'the first turn');
  const seen = daemon.events.at(-1).cursor;
  // The client goes away; the work goes on without it.
  const viewer = await daemon.open();
  await viewer.request('session.attach', { sessionId: session.id, replay: false });
  daemon.client.close();
  await viewer.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('Two') });
  runtimes[0].finish('Second');
  await until(() => viewer.events.filter(e => e.event.type === 'turn.ended').length === 1, 'the second turn');
  const back = await daemon.open();
  const { cursor } = await back.request('session.attach', { sessionId: session.id, after: seen });
  assert.deepEqual(back.events.map(e => e.cursor), viewer.events.map(e => e.cursor));
  assert.deepEqual(back.events.map(e => e.cursor), Array.from({ length: back.events.length }, (_, i) => seen + 1 + i));
  assert.equal(cursor, back.events.at(-1).cursor);
  await assert.rejects(back.request('session.attach', { sessionId: session.id, after: -1 }), error => error.code === -32602);

  // Closed and resumed in the same alpd, the tree continues its cursors.
  viewer.client.close();
  back.client.close();
  await until(() => !daemon.runtime.snapshot(session.id), 'the unwatched root to close');
  const last = await daemon.open();
  await create(last, { sessionId: session.id });
  await last.request('session.prompt', { sessionId: session.id, clientMessageId: 'm3', content: text('Three') });
  assert.ok(last.events.length > 0 && last.events.every(e => e.cursor > cursor), JSON.stringify(last.events.map(e => e.cursor)));
  // Within one runtime, (epoch, seq) does not repeat for a resumed session either.
  const before = Math.max(...back.events.filter(e => e.sessionId === session.id).map(e => e.seq));
  assert.ok(last.events.filter(e => e.sessionId === session.id).every(e => e.epoch !== back.events[0].epoch || e.seq > before));
});
