// Wire behaviour of alpd that the conformance suite cannot reach from outside: a daemon without a
// store, an in-memory log past its limit, and frames near the size limit (docs/protocol/alp-json-rpc-v1.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { CAPABILITY, ERROR, MAX_FRAME, PROTOCOL_VERSION } from '@anhlp/alp-protocol';
import { validateParams, validateResult, validateSchema } from '@anhlp/alp-protocol/contract';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { createStore } from '@anhlp/alp-daemon/store';

/** A runtime with one root whose events the test emits itself. */
function scriptedRuntime() {
  const listeners = new Set();
  const sessions = new Map();
  let seq = 0;
  const emit = (sessionId, event) => { for (const listener of listeners) listener({ sessionId, epoch: 'scripted', seq: ++seq, ts: new Date().toISOString(), event }); };
  return {
    emit,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: id => sessions.get(id),
    list: () => [...sessions.values()],
    questions: () => [],
    recoverable: () => [],
    async open(id, spec) {
      const session = { id, projectRoot: spec.cwd, agent: 'main', runtime: 'codex', model: 'm', mode: 'read-only', thinking: 'low', workflow: { mode: 'pho', maxPeers: 0, supervisor: false }, threadId: 't', persistent: false, busy: true };
      sessions.set(id, session);
      emit(id, { type: 'session.opened', session, cwd: spec.cwd, effective: { model: 'm', thinking: 'low' } });
      return session;
    },
    async close(id) { sessions.delete(id); emit(id, { type: 'session.closed' }); },
  };
}

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-wire-'));
  const runtime = scriptedRuntime();
  const socketPath = daemonPaths(directory).socket;
  const server = createDaemonServer({ runtime, socketPath, version: 'test' });
  await server.listen();
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, server, socketPath };
}

test('without a store, hello lists no prompt.receipts and a cursor before the kept log answers reset', async t => {
  const { runtime, server } = await setup(t);
  const client = server.local();
  t.after(() => client.close());
  const frames = [];
  const raw = server.accept(frame => frames.push(frame));
  raw.receive({ jsonrpc: '2.0', id: 1, method: 'daemon.hello', params: { protocolVersion: PROTOCOL_VERSION } });
  await new Promise(resolve => setImmediate(resolve));
  // Tasks need only a project; the library, team and settings methods need the daemon user's home, which this server has not.
  assert.deepEqual(frames[0].result.capabilities.sort(), [CAPABILITY.attachAfter, CAPABILITY.extensionMethods, CAPABILITY.sessionListPage, CAPABILITY.questionWatch, CAPABILITY.questionWatchTurns, CAPABILITY.sessionAttention, CAPABILITY.workspaceFiles, CAPABILITY.workspaceFilesRead, CAPABILITY.promptImages, CAPABILITY.task].sort());
  raw.close();

  await client.request('session.create', { sessionId: 'root', spec: { cwd: '/work' } });
  // 20 000 events stay in memory: with 20 010 emitted after session.opened, the first kept cursor is 12.
  for (let index = 0; index < 20_010; index++) runtime.emit('root', { type: 'item', item: { kind: 'notice', id: `n${index}`, level: 'info', text: String(index) } });

  const replayed = [];
  const watcher = server.local();
  t.after(() => watcher.close());
  watcher.onEvent(envelope => replayed.push(envelope.cursor));
  const kept = await watcher.request('session.attach', { sessionId: 'root', after: 11 });
  assert.equal(kept.reset, undefined, 'after = first kept cursor - 1 continues');
  assert.equal(kept.cursor, 20_011);
  assert.equal(replayed[0], 12);
  assert.equal(replayed.length, 20_000);
  assert.deepEqual(validateResult('session.attach', kept), []);

  replayed.length = 0;
  const gap = await watcher.request('session.attach', { sessionId: 'root', after: 10 });
  assert.equal(gap.reset, true, 'a cursor whose successor is gone resets');
  assert.equal(replayed[0], 12);
  assert.equal(replayed.length, 20_000);
});

test('a response over the frame limit becomes response_too_large; large frames in one chunk are each answered', async t => {
  const { server, socketPath } = await setup(t);
  server.extend('test.big', ({ bytes }) => ({ text: 'x'.repeat(bytes) }));
  const client = await connect(socketPath, { name: 'wire-test', version: '0' });
  t.after(() => client.close());
  await assert.rejects(client.request('test.big', { bytes: MAX_FRAME }), error => error.code === ERROR.failed && error.data?.reason === 'response_too_large');
  assert.equal((await client.request('test.big', { bytes: 10 })).text.length, 10, 'the connection stays usable');

  // A frame exactly at the limit followed immediately by another frame must not overflow the buffer.
  const socket = net.createConnection(socketPath);
  await new Promise(resolve => socket.once('connect', resolve));
  t.after(() => socket.destroy());
  let received = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { received += chunk; });
  const frame = (id, pad) => `${JSON.stringify({ jsonrpc: '2.0', id, method: id === 1 ? 'daemon.hello' : 'catalog.get', params: { ...(id === 1 ? { protocolVersion: 1 } : {}), pad } })}\n`;
  socket.write(frame(1, 'h') + frame(2, 'y'.repeat(MAX_FRAME - Buffer.byteLength(frame(2, '')))) + frame(3, 'z'));
  for (let i = 0; i < 3000 && received.split('\n').filter(Boolean).length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const answers = received.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(answers.map(answer => [answer.id, !!answer.result]).sort(), [[1, true], [2, true], [3, true]]);
  assert.equal(socket.destroyed, false);
});


test('an attach to a forgotten no-store timeline signals a gap', async t => {
  const { server } = await setup(t);
  const client = server.local();
  t.after(() => client.close());
  await client.request('session.create', { sessionId: 'gone', spec: { cwd: '/work' } });
  await client.request('session.close', { sessionId: 'gone' });
  await new Promise(resolve => setImmediate(resolve));
  const reply = await client.request('session.attach', { sessionId: 'gone', after: 0 });
  assert.equal(reply.reset, true);
  assert.equal(reply.cursor, 2);
});

test('attach without replay reports a persisted closed timeline tip after restart', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-wire-store-'));
  const store = createStore(directory);
  const ts = new Date().toISOString();
  const session = await scriptedRuntime().open('closed', { cwd: '/work' });
  await store.put({ version: 1, id: 'closed', rootId: 'closed', session, spec: { cwd: '/work' }, status: 'closed', createdAt: ts, updatedAt: ts });
  store.append('closed', { sessionId: 'closed', epoch: 'old', seq: 1, cursor: 7, ts, event: { type: 'session.closed' } });
  await store.drain({ records: ['closed'], timelines: ['closed'] });
  const server = createDaemonServer({ runtime: scriptedRuntime(), socketPath: daemonPaths(directory).socket, version: 'test', store });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const client = server.local();
  t.after(() => client.close());
  const reply = await client.request('session.attach', { sessionId: 'closed', replay: false, after: 7 });
  assert.equal(reply.cursor, 7);
  assert.equal(reply.reset, undefined);
});

test('stream frame limit measures received bytes rather than expanded JSON numbers', async t => {
  const { server, socketPath } = await setup(t);
  server.extend('test.numbers', ({ pad }) => ({ length: pad.length }));
  const client = await connect(socketPath, { name: 'wire-test', version: '0' });
  t.after(() => client.close());
  // 8 MiB on the stream, over 16 MiB if re-serialized (1e9 becomes 1000000000).
  const socket = net.createConnection(socketPath);
  await new Promise(resolve => socket.once('connect', resolve));
  t.after(() => socket.destroy());
  const lines = [];
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { buffered += chunk; for (let at; (at = buffered.indexOf('\n')) >= 0;) { lines.push(JSON.parse(buffered.slice(0, at))); buffered = buffered.slice(at + 1); } });
  socket.write('{"jsonrpc":"2.0","id":1,"method":"daemon.hello","params":{"protocolVersion":1}}\n');
  const count = 1_600_000;
  socket.write('{"jsonrpc":"2.0","id":2,"method":"test.numbers","params":{"pad":[' + '1e9,'.repeat(count - 1) + '1e9]}}\n');
  for (let i = 0; i < 1000 && lines.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(lines.find(line => line.id === 2)?.result, { length: count });
});


test('portable checks reject null params, non-finite numbers and array holes like JSON data', () => {
  assert.notDeepEqual(validateParams('catalog.get', null), []);
  assert.notDeepEqual(validateSchema({ type: 'number' }, NaN), []);
  assert.notDeepEqual(validateSchema({ type: 'number' }, Infinity), []);
  assert.notDeepEqual(validateSchema({ type: 'array', items: { type: 'string' } }, Array(1)), []);
  assert.deepEqual(validateSchema({ type: 'array', items: { type: 'null' } }, Array(1)), []);
});

test('history tail then generation-bound attach closes a >memory-retention append gap, including huge events', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-history-gap-'));
  const store = createStore(directory);
  const runtime = scriptedRuntime();
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(directory).socket, version: 'test', store });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const client = server.local(); t.after(() => client.close());
  await client.request('session.create', { sessionId: 'root', spec: { cwd: '/work' } });
  for (let i = 0; i < 650; i++) runtime.emit('root', { type: 'item', item: { kind: 'notice', id: `initial${i}`, level: 'info', text: String(i) } });
  const page = await client.request('session.history', { sessionId: 'root' });
  assert.equal(page.tipCursor, 651);
  for (let i = 0; i < 20005; i++) runtime.emit('root', { type: 'item', item: { kind: 'notice', id: `gap${i}`, level: 'info', text: i === 3 ? 'x'.repeat(MAX_FRAME + 1) : String(i) } });
  const watcher = server.local(); t.after(() => watcher.close());
  const replay = [];
  watcher.onEvent(envelope => replay.push(envelope));
  const attached = await watcher.request('session.attach', { sessionId: 'root', after: page.tipCursor, generation: page.generation });
  assert.equal(attached.reset, undefined);
  assert.equal(replay.length, 20005);
  assert.equal(replay[0].cursor, page.tipCursor + 1);
  assert.equal(new Set(replay.map(event => event.cursor)).size, replay.length);
  assert.ok(replay.every(event => Buffer.byteLength(JSON.stringify(event)) <= 512 * 1024));
  assert.match(replay[3].event.item.text, /too large/);
  runtime.emit('root', { type: 'item', item: { kind: 'notice', id: 'live-huge', level: 'info', text: 'x'.repeat(700000) } });
  assert.match(replay.at(-1).event.item.text, /too large/);
});

test('attach refuses a generation replacement whose numeric tip still exceeds the old watermark', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-history-stale-'));
  const store = createStore(directory);
  const runtime = scriptedRuntime();
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(directory).socket, version: 'test', store });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const client = server.local(); t.after(() => client.close());
  await client.request('session.create', { sessionId: 'root', spec: { cwd: '/work' } });
  const page = await client.request('session.history', { sessionId: 'root' });
  const file = path.join(directory, 'timeline/root.jsonl');
  await unlink(file);
  await writeFile(file, JSON.stringify({ sessionId: 'root', epoch: 'replacement', seq: 50, cursor: 50, ts: '', event: { type: 'session.closed' } }) + '\n');
  await assert.rejects(client.request('session.attach', { sessionId: 'root', after: page.tipCursor, generation: page.generation }), error => error.code === 1004 && error.data.reason === 'stale_cursor');
});

test('append overrunning memory during generation await refuses a replay gap, then retry catches up', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-history-await-'));
  const store = createStore(directory);
  const runtime = scriptedRuntime();
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(directory).socket, version: 'test', store });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const client = server.local(); t.after(() => client.close());
  await client.request('session.create', { sessionId: 'root', spec: { cwd: '/work' } });
  const page = await client.request('session.history', { sessionId: 'root' });
  const history = store.history.bind(store);
  let race = true;
  store.history = async (...args) => {
    const result = await history(...args);
    if (race && args[2]?.limit === 1) {
      race = false;
      for (let i = 0; i < 20005; i++) runtime.emit('root', { type: 'item', item: { kind: 'notice', id: `await${i}`, level: 'info', text: String(i) } });
    }
    return result;
  };
  const watcher = server.local(); t.after(() => watcher.close());
  const replay = []; watcher.onEvent(event => replay.push(event.cursor));
  const params = { sessionId: 'root', after: page.tipCursor, generation: page.generation };
  await assert.rejects(watcher.request('session.attach', params), error => error.code === 1005 && error.data.reason === 'history_gap');
  assert.equal(replay.length, 0, 'no incomplete replay is announced as successful');
  await watcher.request('session.attach', params);
  assert.equal(replay.length, 20005);
  assert.equal(replay[0], 2);
});
