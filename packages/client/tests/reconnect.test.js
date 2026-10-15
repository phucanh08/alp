// The reconnect helper: backoff, onConnect hooks for handshake and reattach, stop, and never
// resending a request (docs/alp/client-sdk.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlpRpcError, backoffDelay, createReconnectingClient, hello, isAlpClientError, retryable } from '@anhlp/alp-client/portable';
import { fakeTransport, tick } from './fake-transport.js';

const until = async check => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(check(), 'condition never held'); };

/** A daemon side that answers hello and records every transport the helper opened. */
function daemon() {
  const transports = [];
  return {
    transports,
    async connect() {
      const transport = fakeTransport();
      const send = transport.send;
      transport.send = frame => {
        send(frame);
        const message = JSON.parse(frame);
        if (message.method === 'daemon.hello') queueMicrotask(() => transport.reply({ protocolVersion: 1 }, message.id));
      };
      transports.push(transport);
      return transport;
    },
  };
}

test('backoff grows by the factor up to the maximum, with bounded jitter', () => {
  const none = () => 0.5;
  assert.deepEqual([1, 2, 3, 4, 10].map(attempt => backoffDelay(attempt, { initialMs: 100, maxMs: 500, factor: 2, jitter: 0.2 }, none)), [100, 200, 400, 500, 500]);
  assert.equal(backoffDelay(1, { initialMs: 100, jitter: 0.2 }, () => 0), 80);
  assert.equal(backoffDelay(1, { initialMs: 100, jitter: 0.2 }, () => 1), 120);
});

test('after a disconnect it connects again, runs onConnect with reconnect set, and never resends', async () => {
  const side = daemon();
  const hooks = [];
  const disconnects = [];
  const states = [];
  const client = createReconnectingClient({
    connect: side.connect,
    onConnect: async (rpc, context) => { hooks.push(context.reconnect); await hello(rpc, { name: 'test', version: '0' }); },
    onDisconnect: (error, context) => disconnects.push([error.reason, context.reconnect]),
    backoff: { initialMs: 1, jitter: 0 },
  });
  client.onState(state => states.push(state));
  const rpc = await client.ready();
  assert.equal(client.state, 'open');
  const inFlight = client.request('session.prompt', { clientMessageId: 'm1' });
  side.transports[0].drop({ error: new Error('ECONNRESET') });
  await assert.rejects(inFlight, error => isAlpClientError(error, 'disconnected'));
  await assert.rejects(client.request('session.list'), error => isAlpClientError(error, 'disconnected'), 'requests while down fail at once');
  await until(() => client.state === 'open' && client.client !== rpc);
  assert.deepEqual(hooks, [false, true]);
  assert.deepEqual(disconnects, [['disconnected', false]]);
  assert.deepEqual(side.transports[1].sent.map(frame => frame.method), ['daemon.hello'], 'the prompt was not replayed');
  assert.deepEqual(states, ['open', 'waiting', 'connecting', 'open']);
  client.stop();
});

test('events reach listeners across reconnects, including a replay onConnect asks for', async () => {
  const side = daemon();
  const seen = [];
  const client = createReconnectingClient({
    connect: side.connect,
    onConnect: async rpc => {
      await hello(rpc);
      // A replay the protocol defines: here the daemon pushes the missed event before onConnect ends.
      if (side.transports.length === 2) side.transports[1].deliver({ jsonrpc: '2.0', method: 'event', params: { seq: 2 } });
    },
    backoff: { initialMs: 1, jitter: 0 },
  });
  client.onEvent(envelope => seen.push(envelope.seq));
  await client.ready();
  side.transports[0].deliver({ jsonrpc: '2.0', method: 'event', params: { seq: 1 } });
  side.transports[0].drop({});
  await until(() => side.transports.length === 2 && client.state === 'open');
  side.transports[1].deliver({ jsonrpc: '2.0', method: 'event', params: { seq: 3 } });
  assert.deepEqual(seen, [1, 2, 3]);
  client.stop();
});

test('a failing connect is retried with backoff until it succeeds or attempts run out', async () => {
  let calls = 0;
  const side = daemon();
  const client = createReconnectingClient({
    connect: async context => { calls++; if (calls < 3) throw new Error(`refused ${context.attempt}`); return side.connect(); },
    onConnect: rpc => hello(rpc),
    backoff: { initialMs: 1, jitter: 0 },
  });
  await client.ready();
  assert.equal(calls, 3);
  client.stop();

  const states = [];
  const limited = createReconnectingClient({ connect: async () => { throw new Error('down'); }, maxAttempts: 2, backoff: { initialMs: 1, jitter: 0 } });
  limited.onState((state, error) => states.push([state, error?.message]));
  await assert.rejects(limited.ready(), /down/);
  assert.equal(limited.state, 'stopped');
  assert.deepEqual(states.at(-1), ['stopped', 'down']);
});

test('a refused handshake (unsupported protocol version) stops instead of retrying', async () => {
  let calls = 0;
  const client = createReconnectingClient({
    connect: async () => { calls++; return fakeTransport(); },
    onConnect: async () => { throw new AlpRpcError({ code: 1006, message: 'Unsupported protocol version' }); },
    backoff: { initialMs: 1, jitter: 0 },
  });
  await assert.rejects(client.ready(), error => error.code === 1006);
  assert.equal(calls, 1);
  assert.equal(retryable(new Error('ECONNREFUSED')), true);
});

test('stop() ends a wait for the next attempt, closes the connection and releases listeners', async () => {
  const side = daemon();
  const client = createReconnectingClient({ connect: side.connect, onConnect: rpc => hello(rpc), backoff: { initialMs: 60_000, jitter: 0 } });
  await client.ready();
  side.transports[0].drop({});
  await tick();
  assert.equal(client.state, 'waiting');
  client.stop();
  assert.equal(client.state, 'stopped');
  await assert.rejects(client.ready(), error => isAlpClientError(error, 'closed'));
  await assert.rejects(client.request('session.list'), error => isAlpClientError(error, 'closed'));
  // A 60 s backoff timer left behind would keep node --test from finishing.
});

test('stop() during a connect discards the transport that arrives late', async () => {
  let release;
  const late = fakeTransport();
  const client = createReconnectingClient({ connect: () => new Promise(resolve => { release = () => resolve(late); }) });
  const waiting = client.ready();
  client.stop();
  await assert.rejects(waiting, error => isAlpClientError(error, 'closed'));
  release();
  await tick();
  assert.equal(late.state, 'closed');
  assert.equal(late.closeCalls, 1);
});

test('ready() honours its abort signal', async () => {
  const client = createReconnectingClient({ connect: () => new Promise(() => {}) });
  const controller = new AbortController();
  const waiting = client.ready({ signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, error => isAlpClientError(error, 'aborted'));
  client.stop();
});

test('a caller listener that throws does not stop the others', async () => {
  const side = daemon();
  const reported = [];
  const client = createReconnectingClient({ connect: side.connect, onConnect: rpc => hello(rpc), client: { onListenerError: error => reported.push(error.message) } });
  const heard = [];
  client.onEvent(() => { throw new Error('boom'); });
  client.onEvent(envelope => heard.push(envelope.seq));
  await client.ready();
  side.transports[0].deliver({ jsonrpc: '2.0', method: 'event', params: { seq: 1 } });
  assert.deepEqual(heard, [1]);
  assert.deepEqual(reported, ['boom']);
  client.stop();
});

test('stop() from an onState listener stays stopped, whatever state it heard', async () => {
  for (const at of ['connecting', 'waiting']) {
    const side = daemon();
    const client = createReconnectingClient({ connect: side.connect, onConnect: rpc => hello(rpc), backoff: { initialMs: 1, jitter: 0 } });
    await client.ready();
    let giveUp = true;
    const heard = [];
    client.onState(state => { heard.push(state); if (state === at && giveUp) { giveUp = false; client.stop(); } });
    side.transports[0].drop({});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(client.state, 'stopped', at);
    assert.equal(client.client, undefined, at);
    assert.equal(side.transports.length, 1, `${at}: no connection after stop()`);
    assert.deepEqual(heard.slice(heard.indexOf(at)), [at, 'stopped'], `${at}: only stopped after the state that stopped it`);
  }
});

test('stop() during onConnect closes the connection being set up and sends nothing more on it', async () => {
  const transports = [];
  const client = createReconnectingClient({
    connect: async () => { const transport = fakeTransport(); transports.push(transport); return transport; },
    onConnect: async rpc => {
      await hello(rpc); // never answered
      await rpc.request('session.attach', {});
    },
  });
  await until(() => transports[0]?.sent.length === 1);
  const waiting = client.ready();
  client.stop();
  await assert.rejects(waiting, error => isAlpClientError(error, 'closed'));
  await tick();
  assert.equal(transports[0].state, 'closed', 'the handshaking transport is closed');
  assert.deepEqual(transports[0].sent.map(frame => frame.method), ['daemon.hello'], 'session.attach was never sent');
  assert.equal(transports.length, 1, 'no retry after stop()');
});

test('a connection that drops right after the handshake counts as a failed attempt', async () => {
  const side = daemon();
  const states = [];
  const client = createReconnectingClient({
    connect: side.connect,
    onConnect: async rpc => { await hello(rpc); setTimeout(() => side.transports.at(-1).drop({ code: 4000 }), 1); },
    backoff: { initialMs: 1, jitter: 0 },
    maxAttempts: 3,
    stableMs: 1_000,
  });
  client.onState(state => states.push(state));
  await until(() => client.state === 'stopped');
  assert.equal(side.transports.length, 3, 'three flapping connections, then it gave up');
  assert.equal(states.filter(state => state === 'open').length, 3);
});

test('a connection that stayed up starts the next one from a fresh backoff', async () => {
  const side = daemon();
  const client = createReconnectingClient({ connect: side.connect, onConnect: rpc => hello(rpc), backoff: { initialMs: 1, jitter: 0 }, maxAttempts: 2, stableMs: 20 });
  for (let round = 0; round < 3; round++) {
    await until(() => client.state === 'open' && side.transports.length === round + 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    side.transports.at(-1).drop({});
  }
  await until(() => client.state === 'open' && side.transports.length === 4);
  assert.equal(client.state, 'open', 'maxAttempts counts consecutive failures, not lifetime reconnects');
  client.stop();
});

test('connect and onConnect get a real AbortSignal where the platform has one', async () => {
  const side = daemon();
  const seen = [];
  const client = createReconnectingClient({
    connect: async ({ signal }) => { seen.push(signal instanceof AbortSignal); return side.connect(); },
    onConnect: async (rpc, { signal }) => { seen.push(signal instanceof AbortSignal); AbortSignal.any([signal]); await hello(rpc); },
  });
  await client.ready();
  assert.deepEqual(seen, [true, true]);
  client.stop();
});
