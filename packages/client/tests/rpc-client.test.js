// The portable JSON-RPC engine against a fake transport (docs/alp/client-sdk.md): correlation,
// notifications, malformed frames, send failure, local timeout and abort, disconnect and cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlpClientError, AlpRpcClient, AlpRpcError, hello, isAlpClientError, PROTOCOL_VERSION } from '@anhlp/alp-client/portable';
import { fakeTransport, tick } from './fake-transport.js';

const reason = expected => error => isAlpClientError(error, expected);

test('responses reach their requests whatever order they arrive in', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  const first = client.request('session.get', { sessionId: 'a' });
  const second = client.request('session.get', { sessionId: 'b' });
  assert.deepEqual(transport.sent.map(frame => [frame.jsonrpc, frame.method, frame.params.sessionId]), [['2.0', 'session.get', 'a'], ['2.0', 'session.get', 'b']]);
  assert.notEqual(transport.sent[0].id, transport.sent[1].id);
  transport.reply({ id: 'b' }, transport.sent[1].id);
  transport.deliver({ jsonrpc: '2.0', id: transport.sent[0].id, error: { code: 1001, message: 'No session a', data: { reason: 'missing' } } });
  assert.deepEqual(await second, { id: 'b' });
  await assert.rejects(first, error => error instanceof AlpRpcError && error.code === 1001 && error.data.reason === 'missing');
  assert.equal(client.pendingCount, 0);
});

test('hello sends the protocol version and client name', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  const answer = hello(client, { name: 'web', version: '1.2.3' });
  assert.deepEqual(transport.sent[0].params, { protocolVersion: PROTOCOL_VERSION, client: { name: 'web', version: '1.2.3' } });
  assert.equal(transport.sent[0].method, 'daemon.hello');
  transport.reply({ protocolVersion: PROTOCOL_VERSION });
  assert.equal((await answer).protocolVersion, PROTOCOL_VERSION);
});

test('event notifications reach onEvent and onNotification; other notifications only onNotification', () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  const events = [];
  const notifications = [];
  client.onEvent(envelope => events.push(envelope));
  const stop = client.onNotification((method, params) => notifications.push([method, params]));
  const envelope = { sessionId: 'ses_1', epoch: 'e', seq: 1, ts: '2026-10-14T00:00:00.000Z', event: { type: 'session.ready' } };
  transport.deliver({ jsonrpc: '2.0', method: 'event', params: envelope });
  transport.deliver({ jsonrpc: '2.0', method: 'daemon.future', params: { x: 1 } });
  assert.deepEqual(events, [envelope]);
  assert.deepEqual(notifications, [['event', envelope], ['daemon.future', { x: 1 }]]);
  stop();
  transport.deliver({ jsonrpc: '2.0', method: 'daemon.future', params: {} });
  assert.equal(notifications.length, 2, 'a removed listener hears nothing more');
});

test('a throwing listener does not stop the others and is reported', () => {
  const transport = fakeTransport();
  const reported = [];
  const client = new AlpRpcClient(transport, { onListenerError: error => reported.push(error.message) });
  const heard = [];
  client.onEvent(() => { throw new Error('boom'); });
  client.onEvent(envelope => heard.push(envelope.seq));
  transport.deliver({ jsonrpc: '2.0', method: 'event', params: { seq: 7 } });
  assert.deepEqual(heard, [7]);
  assert.deepEqual(reported, ['boom']);
});

test('a frame that is not JSON closes the connection as a protocol error and rejects what waits', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  const closes = [];
  client.onClose(error => closes.push(error));
  const waiting = client.request('daemon.status');
  transport.deliver('{not json');
  await assert.rejects(waiting, reason('protocol'));
  assert.equal(client.closed, true);
  assert.equal(transport.state, 'closed', 'the client closed its transport');
  assert.equal(closes.length, 1);
  await assert.rejects(client.request('daemon.status'), reason('disconnected'));
});

test('a JSON value that is not a message object is a protocol error too', async () => {
  for (const frame of ['[1,2]', 'null', '42', '"text"']) {
    const transport = fakeTransport();
    const client = new AlpRpcClient(transport);
    const waiting = client.request('daemon.status');
    transport.deliver(frame);
    await assert.rejects(waiting, reason('protocol'), frame);
  }
});

test('a response without result or error rejects that request only; the connection stays up', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  const broken = client.request('daemon.status');
  const fine = client.request('daemon.status');
  transport.deliver({ jsonrpc: '2.0', id: transport.sent[0].id });
  await assert.rejects(broken, reason('protocol'));
  transport.reply({ ok: true }, transport.sent[1].id);
  assert.deepEqual(await fine, { ok: true });
  assert.equal(client.closed, false);
});

test('responses to unknown ids and id-less errors are ignored', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  const waiting = client.request('daemon.status');
  transport.deliver({ jsonrpc: '2.0', id: 999, result: {} });
  transport.deliver({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  transport.reply('ok');
  assert.equal(await waiting, 'ok');
});

test('a send the transport refuses rejects as send_failed and leaves nothing pending', async () => {
  const transport = fakeTransport({ failSend: new Error('EPIPE') });
  const client = new AlpRpcClient(transport);
  await assert.rejects(client.request('daemon.status'), error => isAlpClientError(error, 'send_failed') && error.cause.message === 'EPIPE');
  assert.equal(client.pendingCount, 0);
  assert.equal(client.closed, false, 'one failed send does not end the connection');
});

test('a request larger than the frame limit is refused before it is sent', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport, { maxFrame: 64 });
  await assert.rejects(client.request('session.prompt', { text: 'x'.repeat(100) }), reason('send_failed'));
  assert.equal(transport.sent.length, 0);
});

test('too many requests waiting fail as overloaded without being sent', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport, { maxPending: 2 });
  client.request('a').catch(() => {});
  client.request('b').catch(() => {});
  await assert.rejects(client.request('c'), reason('overloaded'));
  assert.deepEqual(transport.sent.map(frame => frame.method), ['a', 'b']);
  transport.reply({}, transport.sent[0].id);
  await tick();
  const next = client.request('d');
  assert.equal(transport.sent.at(-1).method, 'd', 'room again once an answer arrived');
  transport.reply('done');
  assert.equal(await next, 'done');
});

test('a timeout ends only the local wait: nothing is sent to the daemon and a late answer is dropped', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  const waiting = client.request('session.prompt', {}, { timeoutMs: 10 });
  await assert.rejects(waiting, reason('timeout'));
  assert.equal(client.pendingCount, 0);
  assert.deepEqual(transport.sent.map(frame => frame.method), ['session.prompt'], 'no cancellation was sent');
  transport.reply({ late: true }, transport.sent[0].id);
  assert.equal(client.closed, false);
});

test('a default timeout applies unless the request overrides it', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport, { timeoutMs: 5 });
  await assert.rejects(client.request('a'), reason('timeout'));
  const unlimited = client.request('b', {}, { timeoutMs: Infinity });
  await new Promise(resolve => setTimeout(resolve, 15));
  transport.reply('kept');
  assert.equal(await unlimited, 'kept');
});

test('an abort ends only the local wait and removes its listener', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  const controller = new AbortController();
  const waiting = client.request('session.prompt', {}, { signal: controller.signal });
  controller.abort(new Error('user left'));
  await assert.rejects(waiting, error => isAlpClientError(error, 'aborted') && error.cause.message === 'user left');
  assert.deepEqual(transport.sent.map(frame => frame.method), ['session.prompt'], 'no cancellation was sent');
  assert.equal(client.pendingCount, 0);
  await assert.rejects(client.request('session.get', {}, { signal: controller.signal }), reason('aborted'));
  assert.equal(transport.sent.length, 1, 'an already aborted signal sends nothing');
});

test('an answered request leaves no abort listener or timer behind', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  let listeners = 0;
  const signal = { aborted: false, addEventListener() { listeners++; }, removeEventListener() { listeners--; } };
  const waiting = client.request('a', {}, { signal, timeoutMs: 60_000 });
  assert.equal(listeners, 1);
  transport.reply('ok');
  assert.equal(await waiting, 'ok');
  assert.equal(listeners, 0);
  // A leftover 60 s timer would keep this test process alive; node --test would report it.
});

test('a disconnect rejects every waiting request as disconnected, once, and clears listeners', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  const closes = [];
  client.onClose(error => closes.push(error));
  client.onEvent(() => {});
  const waiting = [client.request('a'), client.request('b', {}, { timeoutMs: 60_000 })];
  transport.drop({ error: new Error('ECONNRESET') });
  for (const request of waiting) await assert.rejects(request, error => isAlpClientError(error, 'disconnected') && error.message === 'ECONNRESET');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].reason, 'disconnected');
  assert.equal(transport.listenerCount, 0, 'the transport holds no listener of this client');
  transport.drop({});
  assert.equal(closes.length, 1);
  await assert.rejects(client.request('c'), reason('disconnected'));
  assert.equal(client.onEvent(() => {})(), false, 'a listener added after the end is never kept');
});

test('a WebSocket close code and reason come with the disconnect', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  const waiting = client.request('a');
  transport.drop({ code: 1012, reason: 'restart' });
  await assert.rejects(waiting, error => isAlpClientError(error, 'disconnected') && error.data.code === 1012 && error.data.reason === 'restart');
});

test('close() rejects waiting requests as closed, closes the transport and is idempotent', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  const closes = [];
  client.onClose(error => closes.push(error));
  const waiting = client.request('a');
  client.close();
  client.close();
  await assert.rejects(waiting, error => isAlpClientError(error, 'closed') && /connection closed/.test(error.message));
  assert.equal(transport.closeCalls, 1);
  assert.equal(closes.length, 1);
  await assert.rejects(client.request('b'), reason('closed'));
});

test('a transport that is already closed gives a closed client', async () => {
  const transport = fakeTransport();
  transport.drop({});
  const client = new AlpRpcClient(transport);
  assert.equal(client.closed, true);
  await assert.rejects(client.request('a'), reason('disconnected'));
});

test('requests from the daemon are answered by the first handler, with its errors', async () => {
  const transport = fakeTransport();
  const client = new AlpRpcClient(transport);
  transport.deliver({ jsonrpc: '2.0', id: 'x1', method: 'extension.call', params: {} });
  await tick();
  assert.deepEqual(transport.sent.at(-1), { jsonrpc: '2.0', id: 'x1', error: { code: -32601, message: "Unknown method 'extension.call'" } });
  client.onRequest(async (method, params) => {
    if (params.fail) throw Object.assign(new Error('nope'), { code: 1004, data: { reason: 'busy' } });
    return { method };
  });
  client.onRequest(() => 'second handler never answers');
  transport.deliver({ jsonrpc: '2.0', id: 'x2', method: 'extension.call', params: {} });
  transport.deliver({ jsonrpc: '2.0', id: 'x3', method: 'extension.call', params: { fail: true } });
  await tick();
  assert.deepEqual(transport.sent.slice(-2), [
    { jsonrpc: '2.0', id: 'x2', result: { method: 'extension.call' } },
    { jsonrpc: '2.0', id: 'x3', error: { code: 1004, message: 'nope', data: { reason: 'busy' } } },
  ]);
});

test('client errors are recognised across copies of the module by their brand', () => {
  const error = new AlpClientError('x', { reason: 'timeout' });
  assert.equal(isAlpClientError(error), true);
  assert.equal(isAlpClientError(error, 'timeout'), true);
  assert.equal(isAlpClientError(error, 'closed'), false);
  assert.equal(isAlpClientError(new Error('x')), false);
  assert.equal(error.name, 'AlpClientError');
});
