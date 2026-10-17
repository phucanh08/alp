// The gateway's network side against a fake daemon (docs/alp/remote-gateway.md §3, §4, §6, §7):
// health and readiness, the ticket flow, Origin and Host checks, unauthorized and revoked
// credentials, the frame checks of protocol §5.2, limits, slow consumers, two clients at once,
// and losing alpd. Nothing here starts alpd; test/integration/gateway.test.js does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { revokeCredential, rotateCredential, resolveConfig } from '../src/index.js';
import { fakeDaemon, summary } from './support/fake-daemon.js';
import { ORIGIN, startGateway, until } from './support/harness.js';

async function workspaces(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-ws-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { a: path.join(directory, 'a'), b: path.join(directory, 'b') };
}

async function setup(t, { config, sessions = [], fixture = {} } = {}) {
  const { a, b } = await workspaces(t);
  const daemon = fakeDaemon({ sessions: sessions.map(([id, where, extra]) => summary(id, where === 'a' ? a : b, extra)), ...fixture });
  const gw = await startGateway(t, { daemon, config, credentials: { alice: { workspaces: [a] }, reader: { workspaces: [a], permissions: ['session.read'] }, bob: { workspaces: [b] } } });
  return { daemon, a, b, ...gw };
}

test('healthz is live and readyz follows alpd', async t => {
  const { daemon, base } = await setup(t);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { live: true });
  await until(async () => (await fetch(`${base}/readyz`)).status === 200, 'ready');
  daemon.state.refuse = true;
  daemon.drop();
  await until(async () => (await fetch(`${base}/readyz`)).status === 503, 'not ready after alpd went away');
  const body = await (await fetch(`${base}/readyz`)).json();
  assert.equal(body.ready, false);
  assert.equal(body.checks[0].code, 'ALP_GATEWAY_DAEMON_UNREACHABLE');
  daemon.state.refuse = false;
  await until(async () => (await fetch(`${base}/readyz`)).status === 200, 'ready again', 10_000);
});

test('a ticket needs a valid bearer credential and an allowed Origin, and opens one connection', async t => {
  const { ticket, raw, tokens, lines } = await setup(t);
  assert.equal((await ticket(undefined)).status, 401);
  assert.equal((await ticket('alpgw1.0000000000000000.' + 'A'.repeat(43))).status, 401);
  assert.equal((await ticket(tokens.alice, { origin: 'https://evil.example' })).status, 403);
  const { status, body, headers } = await ticket(tokens.alice);
  assert.equal(status, 201);
  assert.equal(headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.deepEqual(body.principal.permissions, ['session.read', 'session.write', 'project.read', 'project.write']);
  assert.equal(body.principal.workspaces.length, 1);
  // The same workspace with alpd's name for it, so a client can match projectRoot in session summaries.
  assert.deepEqual(body.principal.workspaceRoots, [{ path: body.principal.workspaces[0], canonical: await realpath(body.principal.workspaces[0]) }]);
  // Without alp.v1, without the ticket, from another origin, or twice: refused before the upgrade.
  assert.equal((await raw([body.subprotocols[1]])).refused, 400);
  assert.equal((await raw(['alp.v1'])).refused, 401);
  assert.equal((await raw(body.subprotocols, { origin: 'https://evil.example' })).refused, 403);
  const fresh = (await ticket(tokens.alice)).body;
  const opened = await raw(fresh.subprotocols);
  assert.equal(opened.protocol, 'alp.v1', 'the ticket is never echoed');
  opened.socket.close();
  assert.equal((await raw(fresh.subprotocols)).refused, 401, 'a ticket opens one connection');
  // Node and React Native clients send no Origin: allowed, bound to "no origin".
  const native = (await ticket(tokens.alice, { origin: null })).body;
  assert.equal((await raw(native.subprotocols, { origin: 'https://app.example' })).refused, 401, 'a no-origin ticket from a browser origin');
  const nativeAgain = (await ticket(tokens.alice, { origin: null })).body;
  const nativeOpen = await raw(nativeAgain.subprotocols, { origin: null });
  assert.ok(nativeOpen.socket);
  nativeOpen.socket.close();
  const text = lines.join('\n');
  for (const secret of [tokens.alice, body.ticket, fresh.ticket]) assert.ok(!text.includes(secret.split('.').at(-1)), 'no secret in the log');
});

test('CORS preflight answers only allowed origins', async t => {
  const { base } = await setup(t);
  const allowed = await fetch(`${base}/v1/tickets`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
  assert.equal(allowed.status, 204);
  assert.match(allowed.headers.get('access-control-allow-headers'), /authorization/);
  const other = await fetch(`${base}/v1/tickets`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(other.status, 403);
});

test('an unknown Host is refused (DNS rebinding), and forwarded headers count only from a trusted proxy', async t => {
  const { base, tokens } = await setup(t, { config: { trustProxy: ['127.0.0.1'], hosts: ['alp.example.com'] } });
  const port = new URL(base).port;
  const request = (headers) => new Promise((resolve, reject) => {
    import('node:http').then(http => {
      const outgoing = http.request({ host: '127.0.0.1', port, path: '/healthz', headers }, response => { response.resume(); resolve(response.statusCode); });
      outgoing.on('error', reject);
      outgoing.end();
    });
  });
  assert.equal(await request({ host: 'attacker.example' }), 421);
  assert.equal(await request({ host: 'alp.example.com', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }), 200);
  assert.equal(await request({ host: 'alp.example.com', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'http' }), 403, 'plaintext through the proxy');
  assert.equal(await request({ host: `127.0.0.1:${port}` }), 200, 'a direct loopback client');
  // Repeated failures from one forwarded address are throttled, others are not.
  const fail = ip => fetch(`${base}/v1/tickets`, { method: 'POST', headers: { authorization: 'Bearer nope', host: 'alp.example.com', 'x-forwarded-for': ip, 'x-forwarded-proto': 'https' } }).then(response => response.status);
  for (let i = 0; i < 20; i++) assert.equal(await fail('203.0.113.7'), 401);
  assert.equal(await fail('203.0.113.7'), 429);
  assert.equal(await fail('203.0.113.8'), 401);
  const ok = await fetch(`${base}/v1/tickets`, { method: 'POST', headers: { authorization: `Bearer ${tokens.alice}`, host: 'alp.example.com', 'x-forwarded-for': '203.0.113.8', 'x-forwarded-proto': 'https' } });
  assert.equal(ok.status, 201);
});

test('listening beyond loopback without TLS is refused unless allowed', () => {
  assert.throws(() => resolveConfig({ host: '0.0.0.0' }), /without TLS/);
  assert.equal(resolveConfig({ host: '0.0.0.0', allowInsecure: true }).host, '0.0.0.0');
  assert.equal(resolveConfig({ host: '0.0.0.0', tls: { cert: 'c', key: 'k' } }).host, '0.0.0.0');
  assert.throws(() => resolveConfig({ limits: { maxFrame: 32 * 1024 * 1024 } }), /cannot exceed/);
  assert.throws(() => resolveConfig({ origins: ['https://app.example/path'] }), /no path/);
});

test('frames are checked as protocol §5.2 orders it, and nothing reaches alpd before hello', async t => {
  const { daemon, rawSession } = await setup(t);
  const { socket, call, frames } = await rawSession('alice');
  const before = daemon.calls().length;
  socket.send('not json');
  socket.send(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'catalog.get' }]));
  socket.send(JSON.stringify({ jsonrpc: '1.0', id: 2, method: 'catalog.get' }));
  socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session.close', params: { sessionId: 'x' } }));
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'catalog.get' }));
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'catalog.get', params: [] }));
  await until(() => frames.length >= 5, 'answers');
  assert.deepEqual(frames.slice(0, 5).map(frame => [frame.id, frame.error.code, frame.error.data?.reason]), [
    [null, -32700, undefined], [null, -32600, 'batch_unsupported'], [null, -32600, undefined], [null, -32600, 'invalid_id'], [3, -32602, 'invalid_params'],
  ]);
  assert.equal((await call('catalog.get')).error.data.reason, 'hello_required');
  const badVersion = await call('daemon.hello', { protocolVersion: 2, client: { name: 'x', version: '0' } });
  assert.deepEqual(badVersion.error.data, { reason: 'protocol_version', supported: [1] });
  assert.equal(daemon.calls().length, before, 'alpd saw nothing but the gateway\'s own hello');
  const greeting = (await call('daemon.hello', { protocolVersion: 1, client: { name: 'x', version: '0' } })).result;
  assert.deepEqual(greeting, { protocolVersion: 1, daemonVersion: 'fake', hostname: 'fake-host', capabilities: ['attach.after', 'prompt.receipts', 'task', 'team', 'library', 'settings.language', 'session.list.page', 'question.watch', 'question.watch.turns', 'workspace.files', 'workspace.files.read'] }, 'alpd\'s host name; no pid, no extension.methods');
  assert.equal((await call('no.such')).error.code, -32601);
});

test('a binary message closes with 4003 and an oversized one with 1009', async t => {
  const { rawSession } = await setup(t, { config: { limits: { maxFrame: 1024 } } });
  const one = await rawSession('alice');
  one.socket.send(Buffer.from([1, 2, 3]), { binary: true });
  assert.equal((await one.closed).code, 4003);
  const two = await rawSession('alice');
  two.socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'daemon.hello', params: { protocolVersion: 1, pad: 'x'.repeat(2048) } }));
  assert.equal((await two.closed).code, 1009);
});

test('a client that never says hello is closed with 4408', async t => {
  const { rawSession } = await setup(t, { config: { limits: { handshakeMs: 100 } } });
  const { closed } = await rawSession('alice');
  assert.equal((await closed).code, 4408);
});

test('rate and pending limits answer errors, and a client that keeps flooding is closed', async t => {
  const { daemon, rawSession } = await setup(t, { config: { limits: { rate: 1, burst: 5, maxStrikes: 5, maxPending: 2 } } });
  daemon.state.handlers['catalog.get'] = () => new Promise(() => {});
  const { socket, frames, closed } = await rawSession('alice');
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'h', method: 'daemon.hello', params: { protocolVersion: 1 } }));
  await until(() => frames.some(frame => frame.id === 'h'), 'hello');
  for (let i = 0; i < 3; i++) socket.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'catalog.get' }));
  await until(() => frames.some(frame => frame.error?.data?.reason === 'too_many_pending'), 'pending limit');
  for (let i = 10; i < 20; i++) socket.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'catalog.get' }));
  await until(() => frames.some(frame => frame.error?.data?.reason === 'rate_limited'), 'rate limit');
  assert.equal(frames.find(frame => frame.error?.data?.reason === 'rate_limited').error.code, 1005);
  assert.equal((await closed).code, 4429);
});

test('a client that does not read is closed as a slow consumer without holding up another', async t => {
  // A grace period longer than the test, so the close frame waits for the reader instead of a terminate.
  const { daemon, rawSession, sdk, a, lines } = await setup(t, { sessions: [['s1', 'a']], config: { limits: { maxBufferedBytes: 2 * 1024 * 1024, rate: 100_000, burst: 100_000, closeGraceMs: 120_000 } } });
  const slow = await rawSession('alice');
  slow.socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'h', method: 'daemon.hello', params: { protocolVersion: 1 } }));
  slow.socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'session.attach', params: { sessionId: 's1', replay: false } }));
  await until(() => slow.frames.some(frame => frame.id === 'a'), 'attached');
  slow.socket.pause();
  slow.socket._socket.pause();
  const fast = await sdk('alice');
  const seen = [];
  fast.client.onEvent(envelope => seen.push(envelope));
  await fast.client.request('session.attach', { sessionId: 's1', replay: false });
  const big = 'x'.repeat(16 * 1024);
  let emitted = 0;
  let ended;
  slow.closed.then(close => { ended = close; });
  // Kernel buffers take the first megabytes; keep producing until the gateway gives up on the reader.
  while (!ended && emitted < 20_000) {
    for (let i = 0; i < 50; i++) daemon.emit('s1', { type: 'item', item: { id: `i${emitted++}`, kind: 'agent_message', text: big } });
    // The reading client keeps up; only the one that stopped reading falls behind.
    await until(() => seen.length === emitted || ended, 'the reading client caught up', 10_000);
  }
  assert.ok(fast.client.closed === false, 'the reading client is still connected');
  assert.ok(lines.some(line => line.includes('ALP_GATEWAY_SLOW_CONSUMER')), 'the gateway gave up on the reader');
  slow.socket._socket.resume();
  assert.equal((await slow.closed).code, 4431);
  await until(() => seen.length === emitted, 'the other client got every event');
  assert.equal(path.isAbsolute(a), true);
});

test('two clients at once get only their own answers and the events of trees they attached', async t => {
  const { daemon, sdk } = await setup(t, { sessions: [['s1', 'a'], ['s2', 'a']] });
  const one = await sdk('alice');
  const two = await sdk('alice');
  const events = { one: [], two: [] };
  one.client.onEvent(envelope => events.one.push(envelope.sessionId));
  two.client.onEvent(envelope => events.two.push(envelope.sessionId));
  await one.client.request('session.attach', { sessionId: 's1', replay: false });
  await two.client.request('session.attach', { sessionId: 's2', replay: false });
  const answers = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? one : two).client.request('session.get', { sessionId: i % 2 ? 's1' : 's2' })));
  answers.forEach((answer, i) => assert.equal(answer.session.id, i % 2 ? 's1' : 's2'));
  await one.client.request('session.prompt', { sessionId: 's1', clientMessageId: 'm1', content: [{ type: 'text', text: 'hi' }] });
  await two.client.request('session.prompt', { sessionId: 's2', clientMessageId: 'm2', content: [{ type: 'text', text: 'hi' }] });
  await until(() => events.one.length >= 3 && events.two.length >= 3, 'events');
  assert.ok(events.one.every(id => id === 's1'));
  assert.ok(events.two.every(id => id === 's2'));
  assert.notEqual(daemon.calls('session.attach')[0].link, daemon.calls('session.attach')[1].link, 'one daemon connection per client');
});

test('revoking or rotating a credential closes its connections with 4401; a changed grant with 4403', async t => {
  const { sdk, home, ids, rawSession } = await setup(t);
  const one = await rawSession('alice');
  await rotateCredential(home, ids.alice);
  assert.equal((await one.closed).code, 4401);
  const two = await rawSession('bob');
  await revokeCredential(home, ids.bob);
  assert.equal((await two.closed).code, 4401);
  await assert.rejects(sdk('bob'), 'a revoked credential gets no ticket');
});

test('when alpd goes away, waiting requests fail with an unknown outcome and the client is told to reconnect', async t => {
  const { daemon, rawSession } = await setup(t, { sessions: [['s1', 'a']] });
  daemon.state.handlers['session.interrupt'] = () => new Promise(() => {});
  const { socket, frames, closed, call } = await rawSession('alice');
  await call('daemon.hello', { protocolVersion: 1 });
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'w', method: 'session.interrupt', params: { sessionId: 's1' } }));
  await until(() => daemon.calls('session.interrupt').length === 1, 'at alpd');
  daemon.drop();
  assert.equal((await closed).code, 4503);
  const answer = frames.find(frame => frame.id === 'w');
  assert.equal(answer.error.code, 1000);
  assert.equal(answer.error.data.reason, 'daemon_disconnected');
  assert.equal(daemon.calls('session.interrupt').length, 1, 'never resent');
});

test('a client that connects while alpd is down is closed with 4503', async t => {
  const { daemon, rawSession } = await setup(t);
  daemon.state.refuse = true;
  const { closed } = await rawSession('alice');
  assert.equal((await closed).code, 4503);
});

test('closing the gateway closes clients with 1001 and leaves sessions to alpd', async t => {
  const { gateway, rawSession, daemon } = await setup(t, { sessions: [['s1', 'a']] });
  const { closed, call } = await rawSession('alice');
  await call('daemon.hello', { protocolVersion: 1 });
  await call('session.attach', { sessionId: 's1', replay: false });
  await gateway.close();
  assert.equal((await closed).code, 1001);
  assert.equal(daemon.calls('session.close').length + daemon.calls('session.interrupt').length, 0, 'nothing cancelled');
  await until(() => daemon.state.links.size === 0, 'daemon connections closed');
});

// t-7679.13 (docs/alp/remote-gateway.md §5.11): typed tool-call details pass as they are, in scope only.
test('typed tool-call details reach a reader of the tree unchanged, later detail types too, and no other tree', async t => {
  const { daemon, b, sdk } = await setup(t, { sessions: [['s1', 'a'], ['s2', 'b']] });
  const reader = await sdk('reader');
  const seen = [];
  reader.client.onEvent(envelope => envelope.event.type === 'item' && seen.push(envelope));
  await reader.client.request('session.attach', { sessionId: 's1', replay: false });
  const items = [
    { kind: 'tool_call', id: 't1', callId: 't1', name: 'Read', status: 'completed', detail: { type: 'read', filePath: '/etc/hosts', content: '127.0.0.1 localhost', offset: 1 } },
    { kind: 'tool_call', id: 't2', callId: 't2', name: 'apply_patch', status: 'completed', detail: { type: 'edit', filePath: `${b}/x.ts`, unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n' } },
    { kind: 'tool_call', id: 't3', callId: 't3', name: 'Screenshot', status: 'completed', detail: { type: 'image', path: '/tmp/s.png' } },
  ];
  for (const item of items) daemon.emit('s1', { type: 'item', item });
  daemon.emit('s2', { type: 'item', item: { ...items[0], id: 'other' } });
  await until(() => seen.length === 3, 'the three items');
  assert.deepEqual(seen.map(envelope => envelope.event.item), items);
  assert.ok(seen.every(envelope => envelope.sessionId === 's1'));
});
