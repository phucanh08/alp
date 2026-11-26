// The WebSocket transport against socket doubles shaped like the browser's (addEventListener) and
// like implementations that only have on<type> properties (docs/alp/client-sdk.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlpRpcClient, isAlpClientError } from '@anhlp/alp-client/portable';
import { CLOSE_CODE, connectWebSocket, createWebSocketTransport, redactUrl } from '@anhlp/alp-client/websocket';

/**
 * A WebSocket double. `style: 'property'` has no addEventListener, only on<type>. `strict` refuses
 * close codes other than 1000 and 3000-4999 and reasons over 123 bytes, as browsers do.
 */
function socketDouble({ style = 'events', strict = false } = {}) {
  const listeners = new Map();
  const socket = {
    readyState: 0, bufferedAmount: 0, sent: [], closedWith: undefined,
    url: undefined, protocols: undefined,
    send(data) { socket.sent.push(data); },
    close(code, reason) {
      if (strict && code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new Error('InvalidAccessError: invalid code');
      if (strict && reason !== undefined && Buffer.byteLength(reason) > 123) throw new Error('SyntaxError: reason too long');
      if (socket.readyState >= 2) return;
      socket.closedWith = [code, reason];
      socket.readyState = 2;
    },
    emit(type, event = {}) {
      if (type === 'open') socket.readyState = 1;
      if (type === 'close') socket.readyState = 3;
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
      socket[`on${type}`]?.(event);
    },
  };
  if (style === 'events') {
    socket.addEventListener = (type, listener) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); };
    socket.removeEventListener = (type, listener) => listeners.get(type)?.delete(listener);
    socket.listenerCount = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    /** Listeners left besides the 'error' ones the transport keeps for good. */
    socket.liveListeners = () => [...listeners].filter(([type]) => type !== 'error').reduce((sum, [, set]) => sum + set.size, 0);
  } else {
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
  }
  return socket;
}

function implementation(sockets, options) {
  return class {
    constructor(url, protocols) {
      const socket = socketDouble(options);
      socket.url = url;
      socket.protocols = protocols;
      sockets.push(socket);
      return socket;
    }
  };
}

test('connects with the injected WebSocket, passing URL and subprotocols through', async () => {
  const sockets = [];
  const opening = connectWebSocket('wss://alp.example/rpc', { WebSocket: implementation(sockets), protocols: ['alp.v1'] });
  assert.equal(sockets[0].url, 'wss://alp.example/rpc');
  assert.deepEqual(sockets[0].protocols, ['alp.v1']);
  sockets[0].emit('open');
  const transport = await opening;
  assert.equal(transport.state, 'open');
  transport.send('{"jsonrpc":"2.0","id":1,"method":"daemon.hello","params":{}}');
  assert.equal(sockets[0].sent.length, 1);
});

test('createSocket builds the socket however the caller needs, and the global WebSocket is the fallback', async () => {
  const made = [];
  const opening = connectWebSocket('ws://127.0.0.1:1/', { createSocket: url => { const socket = socketDouble(); made.push(url); socket.readyState = 1; return socket; } });
  assert.deepEqual(made, ['ws://127.0.0.1:1/']);
  assert.equal((await opening).state, 'open');

  const sockets = [];
  const original = globalThis.WebSocket;
  globalThis.WebSocket = implementation(sockets);
  try {
    const viaGlobal = connectWebSocket('ws://127.0.0.1:2/');
    sockets[0].emit('open');
    assert.equal((await viaGlobal).state, 'open');
  } finally { globalThis.WebSocket = original; }
});

test('a failed connect rejects as disconnected and never shows the token in its message', async () => {
  const sockets = [];
  const url = 'wss://user:secret@alp.example/rpc?token=abc123#frag';
  const opening = connectWebSocket(url, { WebSocket: implementation(sockets) });
  sockets[0].emit('error', { message: 'refused' });
  await assert.rejects(opening, error => isAlpClientError(error, 'disconnected') && !/secret|abc123|frag/.test(error.message) && error.message.includes('wss://alp.example/rpc'));
  assert.equal(redactUrl(url), 'wss://alp.example/rpc');
  assert.equal(sockets[0].liveListeners(), 0, 'no listener is left on the failed socket but the error sink');
});

test('a connect times out or aborts and closes the socket it opened', async () => {
  const sockets = [];
  await assert.rejects(connectWebSocket('ws://a/', { WebSocket: implementation(sockets), timeoutMs: 5 }), error => isAlpClientError(error, 'timeout'));
  assert.ok(sockets[0].closedWith, 'the timed-out socket is closed');
  const controller = new AbortController();
  const aborted = connectWebSocket('ws://b/', { WebSocket: implementation(sockets), signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, error => isAlpClientError(error, 'aborted'));
  assert.ok(sockets[1].closedWith);
  await assert.rejects(connectWebSocket('ws://c/', { WebSocket: implementation(sockets), signal: controller.signal }), error => isAlpClientError(error, 'aborted'));
});

test('without any WebSocket implementation connecting is a clear TypeError', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  try { await assert.rejects(connectWebSocket('ws://a/'), TypeError); } finally { globalThis.WebSocket = original; }
});

for (const style of ['events', 'property']) {
  test(`one RPC client over a ${style}-style socket: requests, events, several messages per frame, close code`, async () => {
    const socket = socketDouble({ style });
    socket.emit('open');
    const client = new AlpRpcClient(createWebSocketTransport(socket));
    const events = [];
    client.onEvent(envelope => events.push(envelope.seq));
    const answer = client.request('daemon.status');
    const { id } = JSON.parse(socket.sent[0]);
    socket.emit('message', { data: `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { seq: 1 } })}\n${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } })}\n` });
    assert.deepEqual(await answer, { ok: true });
    assert.deepEqual(events, [1]);
    const waiting = client.request('session.prompt');
    socket.emit('close', { code: 1012, reason: 'service restart' });
    await assert.rejects(waiting, error => isAlpClientError(error, 'disconnected') && error.data.code === 1012 && error.data.reason === 'service restart');
    assert.equal(client.closed, true);
    if (style === 'property') assert.equal(socket.onmessage, null, 'property handlers are restored');
    else assert.equal(socket.liveListeners(), 0, 'event listeners are removed, but the error sink');
  });
}

test('a binary or oversized message is a protocol error that closes the socket', async () => {
  const binary = socketDouble();
  binary.emit('open');
  const first = new AlpRpcClient(createWebSocketTransport(binary));
  const waiting = first.request('a');
  binary.emit('message', { data: new ArrayBuffer(4) });
  await assert.rejects(waiting, error => isAlpClientError(error, 'protocol'));
  assert.equal(binary.closedWith[0], CLOSE_CODE.unsupportedData);

  const large = socketDouble();
  large.emit('open');
  const second = new AlpRpcClient(createWebSocketTransport(large, { maxFrame: 16 }));
  const pending = second.request('a');
  large.emit('message', { data: 'x'.repeat(17) });
  await assert.rejects(pending, error => isAlpClientError(error, 'protocol'));
  assert.equal(large.closedWith[0], CLOSE_CODE.tooLarge);
});

test('an error event ends the transport even if no close event follows', async () => {
  const socket = socketDouble();
  socket.emit('open');
  const client = new AlpRpcClient(createWebSocketTransport(socket));
  const waiting = client.request('a');
  socket.emit('error', { error: new Error('network down') });
  await assert.rejects(waiting, error => isAlpClientError(error, 'disconnected') && error.message === 'network down');
});

test('a send is refused when the socket is not open or its buffer is over the bound', async () => {
  const socket = socketDouble();
  socket.emit('open');
  const client = new AlpRpcClient(createWebSocketTransport(socket, { maxBufferedBytes: 100 }));
  socket.bufferedAmount = 90;
  await assert.rejects(client.request('session.prompt', { text: 'x'.repeat(50) }), error => isAlpClientError(error, 'send_failed'));
  assert.equal(client.closed, false, 'a full buffer refuses one frame only');
  socket.bufferedAmount = 0;
  // A closing socket is gone: the request fails as a disconnect and the client is closed with it.
  socket.readyState = 2;
  await assert.rejects(client.request('a'), error => isAlpClientError(error, 'disconnected') && client.closed);
  assert.equal(socket.sent.length, 0);
});

test('closing the client closes the socket with 1000 once', () => {
  const socket = socketDouble();
  socket.emit('open');
  const client = new AlpRpcClient(createWebSocketTransport(socket));
  client.close();
  client.close();
  assert.deepEqual(socket.closedWith, [1000, 'client closed']);
  assert.throws(() => createWebSocketTransport(socket), error => isAlpClientError(error, 'disconnected'), 'a socket that is not open cannot be wrapped');
});

test('a protocol violation closes a browser-like socket, whose close() refuses 1003 and 1009', async () => {
  for (const data of [new ArrayBuffer(4), 'x'.repeat(64)]) {
    const socket = socketDouble({ strict: true });
    socket.emit('open');
    const client = new AlpRpcClient(createWebSocketTransport(socket, { maxFrame: 32 }));
    const waiting = client.request('a');
    socket.emit('message', { data });
    await assert.rejects(waiting, error => isAlpClientError(error, 'protocol'));
    assert.equal(socket.readyState, 2, 'the socket is closing, not left open');
    assert.ok([CLOSE_CODE.unsupportedData, CLOSE_CODE.tooLarge].includes(socket.closedWith[0]));
  }
});

test('a socket whose close() throws for every code is still closed plainly', async () => {
  const socket = socketDouble();
  socket.emit('open');
  const close = socket.close;
  socket.close = (code, reason) => { if (code !== undefined) throw new Error('nope'); return close(code, reason); };
  const client = new AlpRpcClient(createWebSocketTransport(socket));
  const waiting = client.request('a');
  socket.emit('message', { data: new ArrayBuffer(1) });
  await assert.rejects(waiting, error => isAlpClientError(error, 'protocol'));
  assert.equal(socket.readyState, 2);
});

test('an error followed by close ends with the close code and a message that is not empty', async () => {
  const socket = socketDouble();
  socket.emit('open');
  const client = new AlpRpcClient(createWebSocketTransport(socket));
  const waiting = client.request('a');
  socket.emit('error', { error: new Error('') });
  socket.emit('close', { code: 1006, reason: '' });
  await assert.rejects(waiting, error => isAlpClientError(error, 'disconnected') && error.message === 'WebSocket error' && error.data?.code === 1006);
});

test('redaction drops a password holding @, and a constructor error never carries the raw URL', async () => {
  assert.equal(redactUrl('ws://user:pa@ss@host:9/rpc?token=t#f'), 'ws://host:9/rpc');
  const url = 'wss://user:hunter2@gw.example/rpc?token=SECRET';
  const thrown = Object.assign(new TypeError(`Invalid URL: ${url}`), { input: url });
  await assert.rejects(connectWebSocket(url, { createSocket: () => { throw thrown; } }), error => {
    const seen = JSON.stringify({ message: error.message, cause: error.cause?.message, keys: Object.keys(error.cause ?? {}) });
    return isAlpClientError(error, 'disconnected') && error.cause.name === 'TypeError' && !/hunter2|SECRET/.test(seen) && error.cause.input === undefined;
  });
});

test('timeouts beyond what a timer can wait mean none; invalid ones are TypeErrors', async () => {
  const sockets = [];
  const opening = connectWebSocket('ws://a/', { WebSocket: implementation(sockets), timeoutMs: 2 ** 31 });
  await new Promise(resolve => setTimeout(resolve, 10));
  sockets[0].emit('open');
  assert.equal((await opening).state, 'open', 'a 2^31 ms timeout did not fire at once');
  await assert.rejects(connectWebSocket('ws://b/', { WebSocket: implementation(sockets), timeoutMs: -1 }), TypeError);
});

test('every socket the transport owns keeps an error listener, so ws cannot throw an unheard error', async () => {
  const sockets = [];
  const opening = connectWebSocket('ws://a/', { WebSocket: implementation(sockets), timeoutMs: 5 });
  await assert.rejects(opening, error => isAlpClientError(error, 'timeout'));
  assert.ok(sockets[0].listenerCount() >= 1, 'an abandoned connect keeps its error sink');
  const open = socketDouble();
  open.emit('open');
  createWebSocketTransport(open).close();
  assert.ok(open.listenerCount() >= 1, 'a closed transport keeps its error sink');
});

test('synchronous close after an error clears the fallback timer', async t => {
  const { liveTimers } = await import('./fake-transport.js');
  const timers = liveTimers(t);
  {
    const socket = socketDouble();
    socket.readyState = 1;
    socket.close = () => socket.emit('close', { code: 1006 });
    const transport = createWebSocketTransport(socket);
    socket.emit('error', { message: 'lost' });
    assert.equal(transport.state, 'closed');
    assert.equal(timers.size, 0);
  }
});
