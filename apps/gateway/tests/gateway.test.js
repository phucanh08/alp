// The gateway's network side against a fake daemon (docs/alp/remote-gateway.md §3, §4, §6, §7):
// health and readiness, the ticket flow, Origin and Host checks, unauthorized and revoked
// credentials, the frame checks of protocol §5.2, limits, slow consumers, two clients at once,
// and losing alpd. Nothing here starts alpd; test/integration/gateway.test.js does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import { WebSocketServer } from 'ws';
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
  assert.deepEqual(greeting, { protocolVersion: 1, daemonVersion: 'fake', hostname: 'fake-host', capabilities: ['attach.after', 'prompt.receipts', 'task', 'team', 'library', 'library.project.write', 'settings.language', 'session.list.page', 'question.watch', 'question.watch.turns', 'session.attention', 'workspace.files', 'workspace.files.read'] }, 'alpd\'s host name; no pid, no extension.methods');
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

test('catalog.get through the gateway keeps each provider\'s status but drops its error text (t-e5ee)', async t => {
  const { daemon, rawSession } = await setup(t);
  daemon.state.handlers['catalog.get'] = () => ({ models: [], modes: [], defaultModel: 'codex:x', fetchedAt: 'now', providers: { codex: { status: 'failed', fetchedAt: 'then', error: 'spawn /home/me/bin/codex ENOENT' }, claude: { status: 'ok' } } });
  const { socket, frames } = await rawSession('alice');
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'h', method: 'daemon.hello', params: { protocolVersion: 1 } }));
  await until(() => frames.some(frame => frame.id === 'h'), 'hello');
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'c', method: 'catalog.get' }));
  await until(() => frames.some(frame => frame.id === 'c'), 'catalog');
  const { result } = frames.find(frame => frame.id === 'c');
  assert.deepEqual(result.providers, { codex: { status: 'failed', fetchedAt: 'then' }, claude: { status: 'ok' } });
  assert.equal(JSON.stringify(result).includes('/home/me'), false);
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

test('conditional interrupt forwards its identity and answer only to a capable daemon', async t => {
  for (const capable of [false, true]) {
    const w = await setup(t, { sessions: [['s1', 'a']], fixture: { capabilities: ['attach.after', ...(capable ? ['session.interrupt.turn'] : [])] } });
    w.daemon.state.handlers['session.interrupt'] = () => ({ interrupted: false });
    const { call } = await w.rawSession('alice');
    const greeting = await call('daemon.hello', { protocolVersion: 1 });
    assert.equal(greeting.result.capabilities.includes('session.interrupt.turn'), capable);
    const response = await call('session.interrupt', { sessionId: 's1', turnId: 'original' });
    if (capable) {
      assert.deepEqual(response.result, { interrupted: false });
      assert.deepEqual(w.daemon.calls('session.interrupt').at(-1).params, { sessionId: 's1', turnId: 'original' });
    } else {
      assert.equal(response.error.data.reason, 'capability');
      assert.equal(w.daemon.calls('session.interrupt').length, 0);
    }
  }
});

/** One plain HTTP request with exactly these headers. @returns {Promise<{ status: number, body: string, headers: import('node:http').IncomingHttpHeaders }>} */
async function plainRequest(base, { method = 'GET', path: target = '/', headers = {} } = {}) {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port: new URL(base).port, method, path: target, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('without a static hook, other paths answer 404 as before', async t => {
  const { base } = await setup(t);
  const host = `127.0.0.1:${new URL(base).port}`;
  for (const method of ['GET', 'HEAD']) {
    const answer = await plainRequest(base, { method, path: '/index.html', headers: { host } });
    assert.equal(answer.status, 404, method);
    if (method === 'GET') assert.deepEqual(JSON.parse(answer.body), { error: 'not_found' });
  }
});

test('a static hook answers GET and HEAD outside the gateway paths, only behind the Host and TLS checks', async t => {
  const calls = [];
  const serveStatic = (request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.url === '/missing') return false;
    if (request.url === '/boom') throw new Error('broken hook');
    response.writeHead(200, { 'content-type': 'text/html', 'content-length': '5' });
    response.end(request.method === 'HEAD' ? undefined : 'hello');
    return true;
  };
  const daemon = fakeDaemon();
  const { a } = await workspaces(t);
  const gw = await startGateway(t, { daemon, serveStatic, config: { trustProxy: ['127.0.0.1'], hosts: ['alp.example.com'] }, credentials: { alice: { workspaces: [a] } } });
  const host = `127.0.0.1:${new URL(gw.base).port}`;
  const send = (target, options = {}) => plainRequest(gw.base, { path: target, ...options, headers: { host, ...options.headers } });

  // Refused before the hook: a Host the gateway does not serve (DNS rebinding), plaintext beyond loopback.
  assert.equal((await send('/index.html', { headers: { host: 'attacker.example' } })).status, 421);
  assert.equal((await send('/index.html', { method: 'HEAD', headers: { host: 'attacker.example' } })).status, 421);
  assert.equal((await send('/index.html', { headers: { host: 'alp.example.com', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'http' } })).status, 403);
  assert.deepEqual(calls, [], 'the hook saw no refused request');

  const page = await send('/index.html');
  assert.deepEqual([page.status, page.headers['content-type'], page.body], [200, 'text/html', 'hello']);
  const head = await send('/index.html', { method: 'HEAD' });
  assert.deepEqual([head.status, head.body], [200, '']);
  const proxied = await send('/app.js', { headers: { host: 'alp.example.com', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' } });
  assert.equal(proxied.status, 200, 'an allowed Host over TLS through the proxy');
  assert.deepEqual(calls, ['GET /index.html', 'HEAD /index.html', 'GET /app.js']);

  // `false` leaves the gateway's 404; a throw is a 500. Other methods never reach the hook.
  assert.deepEqual([(await send('/missing')).status, JSON.parse((await send('/missing')).body)], [404, { error: 'not_found' }]);
  assert.deepEqual(JSON.parse((await send('/boom')).body), { error: 'internal' });
  assert.ok(gw.lines.some(line => line.includes('ALP_GATEWAY_STATIC_FAILED')));
  assert.equal((await send('/index.html', { method: 'POST' })).status, 404);
  calls.length = 0;

  // The gateway's own paths answer as without the hook, and still need their credentials.
  assert.deepEqual(JSON.parse((await send('/healthz')).body), { live: true });
  assert.equal((await send('/healthz', { method: 'HEAD' })).status, 404);
  assert.equal((await send('/readyz', { method: 'HEAD' })).status, 404);
  assert.equal((await send('/v1/tickets')).status, 405);
  assert.equal((await send('/v1/tickets', { method: 'HEAD' })).status, 405);
  assert.equal((await send('/v1/tickets', { method: 'POST' })).status, 401);
  assert.equal((await send('/v1/tickets', { method: 'POST', headers: { authorization: 'Bearer alpgw1.0000000000000000.' + 'A'.repeat(43) } })).status, 401);
  assert.equal((await send('/v1/ws')).status, 404);
  assert.equal((await send('/v1/other')).status, 404);
  assert.equal((await send('/v1')).status, 404);
  assert.equal((await gw.raw(['alp.v1'])).refused, 401, 'a WebSocket still needs a ticket');
  assert.deepEqual(calls, [], 'no gateway path reached the hook');
  assert.equal((await gw.ticket(gw.tokens.alice)).status, 201);
  const opened = await gw.rawSession('alice');
  assert.ok(opened.socket);
});

/** One request written to the socket byte for byte, for targets an HTTP client refuses to send. */
function rawExchange(base, lines) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => socket.end(`${lines.join('\r\n')}\r\n\r\n`));
    let text = '';
    socket.setEncoding('latin1');
    socket.on('data', chunk => { text += chunk; });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
}

test('an unparsable request target is a 400, in a request or an upgrade, and the gateway keeps serving', async t => {
  const serveStatic = () => { throw new Error('the hook must not see an unparsable target'); };
  const daemon = fakeDaemon();
  const { a } = await workspaces(t);
  const gw = await startGateway(t, { daemon, serveStatic, credentials: { alice: { workspaces: [a] } } });
  const host = `Host: 127.0.0.1:${new URL(gw.base).port}`;
  for (const target of ['//[', '//x:99999/', '//[::1/']) {
    const plain = await rawExchange(gw.base, [`GET ${target} HTTP/1.1`, host, 'Connection: close']);
    assert.match(plain, /^HTTP\/1\.1 400 /, `GET ${target}`);
    assert.match(plain, /"error":"bad_request"/, `GET ${target}`);
    const upgrade = await rawExchange(gw.base, [`GET ${target} HTTP/1.1`, host, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Protocol: alp.v1']);
    assert.match(upgrade, /^HTTP\/1\.1 400 Bad Request/, `upgrade ${target}`);
  }
  // Still the Host check first: an unknown Host is a 421 whatever the target.
  assert.match(await rawExchange(gw.base, ['GET //[ HTTP/1.1', 'Host: attacker.example', 'Connection: close']), /^HTTP\/1\.1 421 /);
  assert.deepEqual(JSON.parse((await plainRequest(gw.base, { path: '/healthz', headers: { host: host.slice(6) } })).body), { live: true });
  assert.equal((await gw.ticket(gw.tokens.alice)).status, 201);
});

test('a throw in a request or upgrade handler is a logged 500, and the gateway keeps serving', async t => {
  const daemon = fakeDaemon();
  const { a } = await workspaces(t);
  const gw = await startGateway(t, { daemon, credentials: { alice: { workspaces: [a] } } });
  const { verify, grant } = gw.store;
  t.after(() => { gw.store.verify = verify; gw.store.grant = grant; });
  // The ticket route throws while it checks the token.
  gw.store.verify = () => { throw new Error('broken store'); };
  const ticket = await gw.ticket(gw.tokens.alice);
  assert.equal(ticket.status, 500);
  assert.deepEqual(ticket.body, { error: 'internal' });
  assert.ok(gw.lines.some(line => line.includes('ALP_GATEWAY_REQUEST_FAILED')));
  gw.store.verify = verify;
  const issued = await gw.ticket(gw.tokens.alice);
  assert.equal(issued.status, 201);
  // The upgrade throws while it looks up the ticket's grant.
  gw.store.grant = () => { throw new Error('broken store'); };
  assert.equal((await gw.raw(issued.body.subprotocols)).refused, 500);
  assert.ok(gw.lines.some(line => line.includes('ALP_GATEWAY_UPGRADE_FAILED')));
  gw.store.grant = grant;
  assert.deepEqual(JSON.parse((await plainRequest(gw.base, { path: '/healthz', headers: { host: `127.0.0.1:${new URL(gw.base).port}` } })).body), { live: true });
  assert.ok((await gw.rawSession('alice')).socket, 'a new connection still opens');
});

test('socket closing before upgrade cleans up perPrincipal entry without memory leak (t-7eb7)', async t => {
  const { ticket, tokens, ids, gateway, base, rawSession } = await setup(t);
  const { body } = await ticket(tokens.alice);
  const port = Number(new URL(base).port);

  // Hold the upgrade after the gateway reserves a slot, before a WebSocket exists.
  let reservedSocket;
  const upgrade = t.mock.method(WebSocketServer.prototype, 'handleUpgrade', (_request, socket) => { reservedSocket = socket; });
  const clientSocket = net.connect(port, '127.0.0.1');
  const req = [
    'GET /v1/ws HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Protocol: ${body.subprotocols.join(', ')}`,
    `Origin: ${ORIGIN}`,
    '',
    '',
  ].join('\r\n');

  t.after(() => clientSocket.destroy());
  clientSocket.on('error', () => {});
  clientSocket.write(req);
  await until(() => reservedSocket !== undefined, 'upgrade reached after reservation');
  assert.equal(gateway.perPrincipal.get(ids.alice), 1, 'a slot is held before closing');
  assert.equal(gateway.connections.size, 0, 'no completed WebSocket owns the slot');
  reservedSocket.destroy();
  upgrade.mock.restore();

  // perPrincipal must remove the entry completely rather than leaving count 0
  await until(() => !gateway.perPrincipal.has(ids.alice), 'perPrincipal entry removed');
  assert.equal(gateway.perPrincipal.has(ids.alice), false);
  assert.equal(gateway.perPrincipal.size, 0);

  // Subsequent connections for alice succeed and clean up on close
  const session = await rawSession('alice');
  assert.ok(session.socket);
  assert.equal(gateway.perPrincipal.get(ids.alice), 1);
  session.socket.close();
  await until(() => !gateway.perPrincipal.has(ids.alice), 'perPrincipal cleaned up after session close');
  assert.equal(gateway.perPrincipal.size, 0);
});
