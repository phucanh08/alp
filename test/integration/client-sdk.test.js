// The portable client SDK against a real alpd (docs/alp/client-sdk.md): one RPC engine over Node
// IPC and over WebSocket, the latter through a test-only bridge to alpd's socket (the production
// gateway and its authentication are Task 08). Also: a local abort does not cancel on alpd, a
// reconnect resends nothing and reattaches with the current cursor contract, and the portable
// entries bundle for browsers and React Native with no Node built-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import WebSocket, { WebSocketServer } from 'ws';

import { createAlpRuntime } from '../../dist/runtime/index.js';
import { createDaemonServer } from '../../dist/daemon/index.js';
import { initProject } from '../../packages/core/src/init.js';
import { fakeTransport } from '../support/fake-agent.js';
import { connect, connectSocket, daemonPaths } from '../../packages/client/dist/index.js';
import { AlpRpcClient, MAX_FRAME, createReconnectingClient, hello, isAlpClientError } from '../../packages/client/dist/portable.js';
import { connectWebSocket } from '../../packages/client/dist/websocket.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const text = body => [{ type: 'text', text: body }];

async function until(check, what = 'condition') {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} never arrived`);
}

async function daemon(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-sdk-'));
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] } }));
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents) });
  const socketPath = daemonPaths(directory).socket;
  const server = createDaemonServer({ runtime, socketPath, version: 'test' });
  await server.listen();
  server.extend('test.never', () => new Promise(() => {}));
  t.after(async () => { await server.close(); await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });
  return { project, agents, socketPath };
}

/**
 * A test-only WebSocket bridge: each WebSocket connection gets its own connection to alpd's
 * socket and frames pass through unchanged. No authentication (Task 08 designs that).
 */
async function bridge(t, socketPath) {
  const server = http.createServer();
  const sockets = new WebSocketServer({ server, maxPayload: MAX_FRAME });
  const connections = [];
  sockets.on('connection', ws => {
    const frames = [];
    connections.push({ ws, frames });
    const early = [];
    let transport;
    ws.on('message', (data, binary) => {
      const frame = binary ? '' : data.toString('utf8');
      frames.push(JSON.parse(frame));
      if (transport) transport.send(frame); else early.push(frame);
    });
    connectSocket(socketPath).then(opened => {
      transport = opened;
      if (ws.readyState !== WebSocket.OPEN) return transport.close();
      for (const frame of early.splice(0)) transport.send(frame);
      transport.onMessage(frame => ws.send(frame));
      transport.onClose(() => ws.close(1011, 'alpd connection ended'));
      ws.on('close', () => transport.close());
    }, () => ws.close(1011, 'alpd unreachable'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of sockets.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); });
  return {
    url: `ws://127.0.0.1:${server.address().port}/rpc`,
    connections,
    /** Ends every bridged connection from the server side with `code`. */
    kick(code = 4000, reason = 'kicked') { for (const { ws } of connections) if (ws.readyState === WebSocket.OPEN) ws.close(code, reason); },
  };
}

/** The same scenario over any transport: handshake, a session's events, and a local abort. */
async function scenario(client, { project, agents }) {
  assert.equal((await hello(client, { name: 'sdk-test', version: '0' })).protocolVersion, 1);
  const events = [];
  client.onEvent(envelope => events.push(envelope));
  const status = await client.request('daemon.status');
  assert.equal(status.health.live, true);
  const { session } = await client.request('session.create', { spec: { cwd: project } });
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') });
  agents.at(-1).finish('Hi there');
  await until(() => events.some(e => e.sessionId === session.id && e.event.type === 'turn.ended'), 'turn.ended');
  const types = events.filter(e => e.sessionId === session.id).map(e => e.event.type);
  for (const type of ['session.opened', 'session.ready', 'prompt.accepted', 'turn.started', 'turn.ended']) assert.ok(types.includes(type), `${type} in ${types}`);

  // Aborting a request ends the caller's wait only: alpd still accepts the prompt.
  const controller = new AbortController();
  const prompt = client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('Again') }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(prompt, error => isAlpClientError(error, 'aborted'));
  await until(() => events.some(e => e.event.type === 'prompt.accepted' && e.event.clientMessageId === 'm2'), 'the aborted prompt accepted by alpd');
  agents.at(-1).finish('Again done');
  return session;
}

test('one RPC engine runs the same session over Node IPC and WebSocket transports', async t => {
  const alpd = await daemon(t);
  const ws = await bridge(t, alpd.socketPath);
  const transports = {
    'Node IPC': () => connectSocket(alpd.socketPath),
    'WebSocket (injected ws)': () => connectWebSocket(ws.url, { WebSocket }),
    ...(typeof globalThis.WebSocket === 'function' ? { 'WebSocket (Node global)': () => connectWebSocket(ws.url) } : {}),
  };
  for (const [name, open] of Object.entries(transports)) {
    await t.test(name, async () => {
      const client = new AlpRpcClient(await open());
      try { await scenario(client, alpd); } finally { client.close(); }
    });
  }
});

test('connect, the compatibility entry, still runs the scenario', async t => {
  const alpd = await daemon(t);
  const client = await connect(alpd.socketPath, { name: 'compat', version: '0' });
  t.after(() => client.close());
  await scenario(client, alpd);
});

test('a WebSocket disconnect rejects the waiting request with the close code', async t => {
  const alpd = await daemon(t);
  const ws = await bridge(t, alpd.socketPath);
  const client = new AlpRpcClient(await connectWebSocket(ws.url, { WebSocket }));
  await hello(client);
  const closes = [];
  client.onClose(error => closes.push(error));
  const waiting = client.request('test.never');
  await until(() => ws.connections[0]?.frames.some(frame => frame.method === 'test.never'), 'the request at alpd');
  ws.kick(4000, 'kicked');
  await assert.rejects(waiting, error => isAlpClientError(error, 'disconnected') && error.data?.code === 4000 && error.data?.reason === 'kicked');
  assert.equal(closes.length, 1);
});

test('reconnecting over WebSocket resends nothing and reattaches after the last cursor it saw', async t => {
  const alpd = await daemon(t);
  const ws = await bridge(t, alpd.socketPath);
  // A viewer on IPC keeps the tree open and drives it while the WebSocket client is away.
  const viewer = await connect(alpd.socketPath, { name: 'viewer', version: '0' });
  t.after(() => viewer.close());
  const { session } = await viewer.request('session.create', { spec: { cwd: alpd.project } });

  const seen = [];
  let cursor;
  const reconnecting = createReconnectingClient({
    connect: ({ signal }) => connectWebSocket(ws.url, { WebSocket, signal }),
    // The caller's hook: handshake, then reattach with the cursor contract alpd has today (ALPD §66).
    onConnect: async client => {
      await hello(client, { name: 'sdk-reconnect', version: '0' });
      await client.request('session.attach', cursor === undefined ? { sessionId: session.id } : { sessionId: session.id, after: cursor });
    },
    backoff: { initialMs: 10, jitter: 0 },
  });
  t.after(() => reconnecting.stop());
  reconnecting.onEvent(envelope => { if (envelope.sessionId === session.id) { seen.push(envelope.cursor); cursor = envelope.cursor; } });
  await reconnecting.ready();

  await viewer.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('One') });
  alpd.agents[0].finish('First');
  await until(() => seen.length && seen.at(-1) >= 1 && ws.connections.length === 1, 'events over WebSocket');
  const inFlight = reconnecting.request('test.never');
  await until(() => ws.connections[0].frames.some(frame => frame.method === 'test.never'), 'the request at alpd');
  ws.kick(1012, 'restart');
  await assert.rejects(inFlight, error => isAlpClientError(error, 'disconnected'));

  // Work goes on while the client is away; it must catch up without duplicates or gaps.
  await viewer.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('Two') });
  alpd.agents[0].finish('Second');
  await until(() => reconnecting.state === 'open' && ws.connections.length === 2, 'the reconnect');
  const viewerLast = async () => (await viewer.request('session.attach', { sessionId: session.id, replay: false })).cursor;
  await until(async () => cursor === await viewerLast(), 'the missed events');
  assert.deepEqual(seen, Array.from({ length: seen.length }, (_, index) => seen[0] + index), 'contiguous cursors, no duplicate');
  assert.deepEqual(ws.connections[1].frames.map(frame => frame.method), ['daemon.hello', 'session.attach'], 'nothing resent after the reconnect');
});

test('the portable entries bundle for browsers and React Native with no Node built-in or global', async () => {
  const allowed = /^packages\/(client\/src\/(portable|websocket|rpc\/(client|errors|framing|handshake|reconnect|registry|timers))|protocol\/src\/(public|wire))\.js$/;
  for (const [platform, conditions] of [['browser', []], ['neutral', ['react-native', 'import']]]) {
    const result = await build({
      absWorkingDir: root, bundle: true, write: false, metafile: true, format: 'esm', platform, conditions, mainFields: ['react-native', 'browser', 'module', 'main'],
      stdin: { contents: "export * from '@anhlp/alp-client/portable';\nexport * from '@anhlp/alp-client/websocket';", resolveDir: root, loader: 'js' },
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs).filter(input => input !== '<stdin>');
    for (const input of inputs) assert.match(input, allowed, `${platform} bundle pulls in ${input}`);
    assert.ok(inputs.length >= 8, `${platform}: ${inputs}`);
    const output = result.outputFiles[0].text;
    assert.doesNotMatch(output, /\bnode:|\bprocess\.|\bBuffer\b|\brequire\(/, `${platform} bundle`);
  }
  // The Node entry stays Node-only: bundling it for a browser fails on its built-ins.
  await assert.rejects(build({ absWorkingDir: root, bundle: true, write: false, platform: 'browser', stdin: { contents: "export * from '@anhlp/alp-client';", resolveDir: root }, logLevel: 'silent' }));
});

test('real ws timeout and abort reject without an unhandled socket error', async t => {
  const net = await import('node:net');
  const peers = new Set();
  const server = net.createServer(socket => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    socket.on('error', () => {});
    socket.resume(); // Accept TCP but never answer the WebSocket upgrade.
  });
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}`;
  await assert.rejects(connectWebSocket(url, { WebSocket, timeoutMs: 20 }), error => isAlpClientError(error, 'timeout'));
  const abort = new AbortController();
  const pending = connectWebSocket(url, { WebSocket, signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, error => isAlpClientError(error, 'aborted'));
  await new Promise(resolve => setTimeout(resolve, 30));
});
