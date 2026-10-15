import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { PROTOCOL_VERSION, ERROR, encodeFrame } from '@anhlp/alp-protocol';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { connect } from '@anhlp/alp-client';
import { fakeTransport } from '../../../test/support/fake-agent.js';

/**
 * Extension RPC over the real socket (ALPD §3, §14): one connection owns a method with
 * extension.register, any caller invokes it, and alpd relays the call as extension.invoke to the
 * owner. These tests drive the wire directly so id crossing, malformed responses and the pending
 * cap are exercised exactly as they happen between processes.
 */

async function start(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-extensions-'));
  const socketPath = path.join(directory, 'alpd.sock');
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport([]), supervisor: false, libraryDir: directory });
  const daemon = createDaemonServer({ runtime, socketPath, version: 'test' });
  await daemon.listen();
  t.after(async () => {
    await daemon.close().catch(() => {});
    await runtime.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { daemon, socketPath };
}

async function untilFrame(frames, predicate, what, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    await sleep(5);
  }
  assert.fail(`Expected ${what} did not arrive`);
}

/** A raw JSON-RPC socket whose request ids the test controls, for exact frame-id scenarios. */
async function rawClient(socketPath) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.setEncoding('utf8');
  let buffer = '';
  const frames = [];
  const waiters = [];
  const deliver = frame => { const waiter = waiters.shift(); if (waiter) waiter(frame); else frames.push(frame); };
  socket.on('data', chunk => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) deliver(JSON.parse(line));
    }
  });
  const client = {
    frames,
    send(frame) { socket.write(encodeFrame(frame)); },
    next(timeout = 3_000) {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeout);
        waiters.push(frame => { clearTimeout(timer); resolve(frame); });
      });
    },
    request(id, method, params = {}) { client.send({ jsonrpc: '2.0', id, method, params }); return client.next(); },
    async hello(id = 1) {
      const reply = await client.request(id, 'daemon.hello', { protocolVersion: PROTOCOL_VERSION, client: { name: 'raw', version: '0' } });
      assert.equal(reply.error, undefined, JSON.stringify(reply));
      return reply;
    },
    close() { socket.destroy(); },
  };
  return client;
}

test('an owner registers a method and a caller invokes it over the socket', async t => {
  const { daemon, socketPath } = await start(t);
  const owner = await connect(socketPath);
  t.after(() => owner.close());
  const seen = [];
  owner.onRequest(async (method, params) => { seen.push([method, params]); return { echo: params.params.value }; });
  assert.deepEqual(await owner.request('extension.register', { method: 'ext.echo' }), { registered: 'ext.echo' });

  const caller = await connect(socketPath);
  t.after(() => caller.close());
  assert.deepEqual(await caller.request('ext.echo', { value: 42 }), { echo: 42 });
  assert.deepEqual(seen, [['extension.invoke', { method: 'ext.echo', params: { value: 42 } }]]);
  void daemon;
});

test('a thrown error travels with its code and data', async t => {
  const { socketPath } = await start(t);
  const owner = await connect(socketPath);
  t.after(() => owner.close());
  owner.onRequest(async () => { throw Object.assign(new Error('agent is busy'), { code: ERROR.conflict, data: { reason: 'busy' } }); });
  await owner.request('extension.register', { method: 'ext.fail' });

  const caller = await connect(socketPath);
  t.after(() => caller.close());
  const error = await caller.request('ext.fail').then(() => assert.fail('expected failure'), value => value);
  assert.equal(error.code, ERROR.conflict);
  assert.match(error.message, /busy/);
  assert.deepEqual(error.data, { reason: 'busy' });
});

test('built-in and duplicate method names are rejected, including daemon.hello', async t => {
  const { socketPath } = await start(t);
  const owner = await connect(socketPath);
  t.after(() => owner.close());
  await owner.request('extension.register', { method: 'ext.dup' });
  for (const method of ['ext.dup', 'daemon.hello', 'session.list', 'extension.register', 'extension.unregister']) {
    const error = await owner.request('extension.register', { method }).then(() => assert.fail(`expected ${method} to be rejected`), value => value);
    assert.equal(error.code, ERROR.conflict, method);
  }
});

test('unsafe prototype names are refused and the registry has no prototype', async t => {
  const { socketPath } = await start(t);
  const owner = await connect(socketPath);
  t.after(() => owner.close());
  for (const method of ['__proto__', 'constructor', 'toString']) {
    const error = await owner.request('extension.register', { method }).then(() => assert.fail(`expected ${method} to be refused`), value => value);
    assert.equal(error.code, ERROR.protocol, method);
  }

  // A null-prototype registry: names that exist on Object.prototype are simply unknown methods.
  const caller = await connect(socketPath);
  t.after(() => caller.close());
  for (const method of ['valueOf', 'hasOwnProperty', 'toString', 'constructor', '__proto__']) {
    const error = await caller.request(method).then(() => assert.fail(`expected ${method} to be unknown`), value => value);
    assert.equal(error.code, -32601, method);
  }
});

test('an owner disconnect rejects its pending call and removes the method', async t => {
  const { socketPath } = await start(t);
  const owner = await connect(socketPath);
  owner.onRequest(() => new Promise(() => {}));
  await owner.request('extension.register', { method: 'ext.slow' });

  const caller = await connect(socketPath);
  t.after(() => caller.close());
  const pending = caller.request('ext.slow', {});
  await sleep(50);
  owner.close();

  const error = await pending.then(() => assert.fail('expected the call to fail'), value => value);
  assert.match(error.message, /closed/i);
  const gone = await caller.request('ext.slow').then(() => assert.fail('expected the method to be gone'), value => value);
  assert.equal(gone.code, -32601);
});

test('unregister removes a method, is not found twice, and is refused for another owner', async t => {
  const { socketPath } = await start(t);
  const owner = await connect(socketPath);
  t.after(() => owner.close());
  const caller = await connect(socketPath);
  t.after(() => caller.close());

  await owner.request('extension.register', { method: 'ext.tmp' });
  assert.deepEqual(await owner.request('extension.unregister', { method: 'ext.tmp' }), { unregistered: 'ext.tmp' });
  const gone = await caller.request('ext.tmp').then(() => assert.fail('expected removal'), value => value);
  assert.equal(gone.code, -32601);
  const twice = await owner.request('extension.unregister', { method: 'ext.tmp' }).then(() => assert.fail('expected not found'), value => value);
  assert.equal(twice.code, ERROR.notFound);

  await owner.request('extension.register', { method: 'ext.owned' });
  const foreign = await caller.request('extension.unregister', { method: 'ext.owned' }).then(() => assert.fail('expected conflict'), value => value);
  assert.equal(foreign.code, ERROR.conflict);
});

test('a crossed id is served as a request and never consumes the pending invocation', async t => {
  const { daemon, socketPath } = await start(t);
  const ownerFrames = [];
  const owner = daemon.accept(frame => ownerFrames.push(frame));
  owner.receive({ jsonrpc: '2.0', id: 1, method: 'daemon.hello', params: { protocolVersion: PROTOCOL_VERSION, client: { name: 'owner', version: '0' } } });
  owner.receive({ jsonrpc: '2.0', id: 2, method: 'extension.register', params: { method: 'ext.cross' } });
  await untilFrame(ownerFrames, frame => frame.id === 2 && frame.result, 'the registration reply');

  const caller = await connect(socketPath);
  t.after(() => caller.close());
  const pending = caller.request('ext.cross', { n: 1 });
  const invoke = await untilFrame(ownerFrames, frame => frame.method === 'extension.invoke', 'the extension.invoke');
  assert.equal(invoke.id, 1);

  // The owner sends its own request with the same id as the in-flight invoke. It must be answered as
  // a request without touching the daemon's pending invocation.
  owner.receive({ jsonrpc: '2.0', id: 1, method: 'daemon.status', params: {} });
  const status = await untilFrame(ownerFrames, frame => frame.id === 1 && frame.result, 'the daemon.status reply');
  assert.ok(Number.isSafeInteger(status.result.pid));

  owner.receive({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
});

test('a malformed or unknown response is dropped without leaking or mis-correlating the call', async t => {
  const { daemon, socketPath } = await start(t);
  const ownerFrames = [];
  const owner = daemon.accept(frame => ownerFrames.push(frame));
  owner.receive({ jsonrpc: '2.0', id: 1, method: 'daemon.hello', params: { protocolVersion: PROTOCOL_VERSION, client: { name: 'owner', version: '0' } } });
  owner.receive({ jsonrpc: '2.0', id: 2, method: 'extension.register', params: { method: 'ext.malformed' } });
  await untilFrame(ownerFrames, frame => frame.id === 2 && frame.result, 'the registration reply');

  const caller = await connect(socketPath);
  t.after(() => caller.close());
  const pending = caller.request('ext.malformed', { n: 2 });
  const invoke = await untilFrame(ownerFrames, frame => frame.method === 'extension.invoke', 'the extension.invoke');

  owner.receive({ id: invoke.id, result: { bad: true } }); // no jsonrpc
  owner.receive({ jsonrpc: '2.0', id: invoke.id, result: {}, error: { code: 1, message: 'both' } });
  owner.receive({ jsonrpc: '2.0', id: 9999, result: {} }); // unknown id
  await sleep(40);

  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await sleep(40);
  assert.equal(settled, false, 'no malformed frame may settle the invocation');

  owner.receive({ jsonrpc: '2.0', id: invoke.id, result: { ok: 2 } });
  assert.deepEqual(await pending, { ok: 2 });
});

test('the pending cap rejects the overflow call without leaving a timer behind', async t => {
  const { daemon, socketPath } = await start(t);
  const ownerFrames = [];
  const owner = daemon.accept(frame => ownerFrames.push(frame));
  owner.receive({ jsonrpc: '2.0', id: 1, method: 'daemon.hello', params: { protocolVersion: PROTOCOL_VERSION, client: { name: 'owner', version: '0' } } });
  owner.receive({ jsonrpc: '2.0', id: 2, method: 'extension.register', params: { method: 'ext.many' } });
  await untilFrame(ownerFrames, frame => frame.id === 2 && frame.result, 'the registration reply');

  const caller = await connect(socketPath);
  t.after(() => caller.close());
  const calls = Array.from({ length: 129 }, (_, index) => caller.request('ext.many', { index }).then(value => ({ ok: true, value }), error => ({ ok: false, error })));
  await untilFrame(ownerFrames, () => ownerFrames.filter(frame => frame.method === 'extension.invoke').length === 128, '128 in-flight invocations');

  const invokes = ownerFrames.filter(frame => frame.method === 'extension.invoke');
  assert.equal(invokes.length, 128, 'the cap admits 128 in-flight invocations');
  for (const frame of invokes) owner.receive({ jsonrpc: '2.0', id: frame.id, result: { id: frame.id } });
  const settles = await Promise.all(calls);
  const rejected = settles.filter(result => !result.ok);
  assert.equal(rejected.length, 1, 'exactly the overflow call is rejected');
  assert.equal(rejected[0].error.code, ERROR.conflict);

  const results = settles.filter(result => result.ok).map(result => result.value);
  assert.equal(results.length, 128);
  assert.deepEqual(results.map(result => result.id), invokes.map(frame => frame.id));
});

test('raw hello, jsonrpc and malformed request handling on a real socket', async t => {
  const { socketPath } = await start(t);
  const raw = await rawClient(socketPath);
  t.after(() => raw.close());

  raw.send({ id: 1, method: 'daemon.hello', params: { protocolVersion: PROTOCOL_VERSION } });
  const noJsonrpc = await raw.next();
  assert.equal(noJsonrpc.error.code, -32600);

  const before = await raw.request(2, 'daemon.status');
  assert.equal(before.error.code, ERROR.protocol);

  await raw.hello(3);
  const status = await raw.request(4, 'daemon.status');
  assert.equal(status.result.protocolVersion, PROTOCOL_VERSION);
});

test('security: closed callers release extension capacity and cannot register after disconnect', async t => {
  const { daemon } = await start(t);
  const frames = [];
  const owner = daemon.accept(frame => frames.push(frame));
  t.after(() => owner.close());
  owner.receive({ jsonrpc: '2.0', id: 1, method: 'daemon.hello', params: { protocolVersion: PROTOCOL_VERSION } });
  owner.receive({ jsonrpc: '2.0', id: 2, method: 'extension.register', params: { method: 'ext.cleanup' } });
  await untilFrame(frames, frame => frame.id === 2 && frame.result, 'registration');
  const caller = daemon.local();
  for (let i = 0; i < 128; i++) void caller.request('ext.cleanup').catch(() => {});
  await untilFrame(frames, () => frames.filter(frame => frame.method === 'extension.invoke').length === 128, 'full quota');
  caller.close();
  const fresh = daemon.local();
  t.after(() => fresh.close());
  const pending = fresh.request('ext.cleanup').catch(error => ({ unexpectedError: error.message }));
  await sleep(20);
  const invokes = frames.filter(frame => frame.method === 'extension.invoke');
  assert.equal(invokes.length, 129, 'disconnected calls must release owner quota');
  owner.receive({ jsonrpc: '2.0', id: invokes.at(-1).id, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });

  const gone = daemon.local();
  const registration = gone.request('extension.register', { method: 'ext.orphan' }).catch(() => {});
  gone.close();
  await registration;
  assert.deepEqual(await fresh.request('extension.register', { method: 'ext.orphan' }), { registered: 'ext.orphan' });
});

test('security: extension namespaces, names and registrations are bounded', async t => {
  const { daemon } = await start(t);
  const owner = daemon.local();
  t.after(() => owner.close());
  for (const method of ['daemon.attacker', 'session.attacker', 'extension.attacker', 'x'.repeat(129)]) {
    await assert.rejects(owner.request('extension.register', { method }), { code: ERROR.protocol });
  }
  for (let i = 0; i < 128; i++) await owner.request('extension.register', { method: `ext.limit${i}` });
  await assert.rejects(owner.request('extension.register', { method: 'ext.overflow' }), { code: ERROR.conflict });
  await owner.request('extension.unregister', { method: 'ext.limit0' });
  await owner.request('extension.register', { method: 'web.pairing' });
});

test('security: oversized UTF-8 extension payload is rejected before invoking handler', async t => {
  const { daemon } = await start(t);
  let invoked = false;
  daemon.extend('ext.payload', () => { invoked = true; return {}; });
  const caller = daemon.local();
  t.after(() => caller.close());
  // Below 16 Mi characters, above the 16 MiB wire limit.
  await assert.rejects(caller.request('ext.payload', { text: '界'.repeat(6 * 1024 * 1024) }), /size limit/);
  assert.equal(invoked, false);
});
