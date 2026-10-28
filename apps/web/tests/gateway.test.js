// The browser's link to the gateway: which addresses it accepts, how each ticket answer is read,
// and that the token goes only in the Authorization header and never into an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { can, gatewayUrl, grantedWorkspace, openGateway } from '../src/lib/gateway.js';
import { AuthenticationError, ConfigurationError, TransientError, describe } from '../src/lib/errors.js';

const TOKEN = 'alpgw1.0123456789abcdef.c2VjcmV0LXNlY3JldC1zZWNyZXQ';
const principal = { id: 'p', label: 'web', permissions: ['session.read', 'session.write'], workspaces: ['/w'], workspaceRoots: [{ path: '/w', canonical: '/real/w' }] };

test('gateway addresses: https anywhere, http only on loopback, nothing that can carry a secret', () => {
  assert.equal(gatewayUrl('https://alp.example.com/'), 'https://alp.example.com');
  assert.equal(gatewayUrl(' https://alp.example.com/alp/ '), 'https://alp.example.com/alp');
  assert.equal(gatewayUrl('http://127.0.0.1:7434'), 'http://127.0.0.1:7434');
  assert.equal(gatewayUrl('http://localhost:7434'), 'http://localhost:7434');
  for (const bad of ['http://alp.example.com', 'http://192.168.1.5:7434', 'https://user:pw@alp.example.com', 'https://alp.example.com/?token=x', 'https://alp.example.com/#t', 'ftp://alp.example.com', 'not a url']) {
    assert.throws(() => gatewayUrl(bad), ConfigurationError, bad);
  }
});

/** A fetch double that records requests and answers with `status` and `body`. */
function fetchDouble(status, body) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); };
  return { fetch, calls };
}

/** A WebSocket double that opens at once, offering the subprotocols it was given. */
function socketDouble() {
  const opened = [];
  class FakeSocket {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.readyState = 0; this.listeners = {};
      opened.push(this);
      queueMicrotask(() => { this.readyState = 1; for (const listener of this.listeners.open ?? []) listener({}); });
    }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(entry => entry !== listener); }
    send() {}
    close() { this.readyState = 3; }
  }
  return { WebSocket: FakeSocket, opened };
}

test('a ticket opens the socket with its subprotocols; the token stays in the header', async () => {
  const { fetch, calls } = fetchDouble(201, { ticket: 'alpgwt.t', expiresAt: '', websocket: '/v1/ws', subprotocols: ['alp.v1', 'alp.ticket.alpgwt.t'], principal: { ...principal, extra: 'dropped' } });
  const { WebSocket, opened } = socketDouble();
  const link = await openGateway({ url: 'https://alp.example.com/base', token: TOKEN, fetch, WebSocket });
  assert.equal(calls[0].url, 'https://alp.example.com/base/v1/tickets');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(opened[0].url, 'wss://alp.example.com/base/v1/ws');
  assert.deepEqual(opened[0].protocols, ['alp.v1', 'alp.ticket.alpgwt.t']);
  assert.ok(!opened[0].url.includes(TOKEN));
  assert.deepEqual(link.principal, principal);
  link.transport.close();
});

test('ticket refusals: 401 stops, 403 and 421 are configuration, 429 and 503 are worth retrying', async () => {
  const cases = [[401, {}, AuthenticationError], [403, { error: 'origin_not_allowed' }, ConfigurationError], [403, { error: 'tls_required' }, ConfigurationError], [421, {}, ConfigurationError], [429, {}, TransientError], [503, {}, TransientError]];
  for (const [status, body, kind] of cases) {
    const { fetch } = fetchDouble(status, body);
    const error = await openGateway({ url: 'https://alp.example.com', token: TOKEN, fetch }).catch(failure => failure);
    assert.ok(error instanceof kind, `${status} ${JSON.stringify(body)} → ${error?.name}`);
    assert.ok(!String(error.message).includes(TOKEN));
    assert.equal(describe(error).terminal, kind !== TransientError);
  }
});

test('an unreachable gateway (or a refused origin, which a browser cannot tell apart) is transient and says why', async () => {
  const fetch = async () => { throw new TypeError(`Failed to fetch https://alp.example.com with Bearer ${TOKEN}`); };
  const error = await openGateway({ url: 'https://alp.example.com', token: TOKEN, fetch }).catch(failure => failure);
  assert.ok(error instanceof TransientError);
  assert.match(error.message, /origin/);
  assert.ok(!error.message.includes(TOKEN));
});

test('a malformed ticket answer is refused before any socket opens', async () => {
  const { fetch } = fetchDouble(201, { websocket: '/elsewhere', subprotocols: ['alp.v1'], principal });
  const { WebSocket, opened } = socketDouble();
  await assert.rejects(openGateway({ url: 'https://alp.example.com', token: TOKEN, fetch, WebSocket }), ConfigurationError);
  assert.equal(opened.length, 0);
});

test('a token with whitespace is refused without a request', async () => {
  const { fetch, calls } = fetchDouble(201, {});
  await assert.rejects(openGateway({ url: 'https://alp.example.com', token: 'a b', fetch }), AuthenticationError);
  assert.equal(calls.length, 0);
});

test('workspaces match whole strings, by the granted or the canonical path; write implies read', () => {
  assert.equal(grantedWorkspace(principal, '/w')?.path, '/w');
  assert.equal(grantedWorkspace(principal, '/real/w')?.path, '/w');
  assert.equal(grantedWorkspace(principal, '/w/sub'), undefined);
  assert.equal(grantedWorkspace(principal, '/w/'), undefined);
  assert.equal(can(principal, 'session.read'), true);
  assert.equal(can({ ...principal, permissions: ['project.write'] }, 'project.read'), true);
  assert.equal(can(principal, 'project.read'), false);
});

test('describe handles 1003 content_type specifically instead of generic host refusal', () => {
  const errorWithMessage = { code: 1003, message: 'Prompt content of type "unknown" cannot be sent through the gateway', data: { reason: 'content_type' } };
  const described1 = describe(errorWithMessage);
  assert.equal(described1.message, 'Prompt content of type "unknown" cannot be sent through the gateway.');
  assert.equal(described1.code, 1003);

  const errorWithoutMessage = { code: 1003, data: { reason: 'content_type' } };
  const described2 = describe(errorWithoutMessage);
  assert.equal(described2.message, 'This message contains content the host does not accept.');
});
