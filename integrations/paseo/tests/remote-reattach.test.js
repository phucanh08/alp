// The remote provider's recovery after a lost connection, against fake gateway links (provider-core
// relink/reattach). Each link is one connection; a test decides how each answers, what it replays
// and when it drops. Regressions of the 09B-2 review: a drop or a transient gateway error during
// reattach used to fail the root for good and leave the provider on a closed link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteProvider, GatewayAuthError } from 'alp-paseo-plugin/remote';
import { PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';

const principal = { id: 'c1', permissions: ['session.read', 'session.write'], workspaces: ['/w'], workspaceRoots: [{ path: '/w', canonical: '/w' }] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return; await sleep(10); }
  assert.fail(`${what} never happened`);
}
const closedError = () => Object.assign(new Error('ALP daemon connection closed'), { name: 'AlpClientError', reason: 'disconnected' });
const rpcError = (code, message, data) => Object.assign(new Error(message), { code, ...(data ? { data } : {}) });

/** A connection whose answers come from `answer(method, params, connection)`; it can emit events and drop. */
function fakeConnection(name, answer = healthy) {
  const closes = new Set();
  const listeners = new Set();
  const connection = {
    name,
    closed: false,
    requests: [],
    async request(method, params) {
      if (connection.closed) throw closedError();
      connection.requests.push({ method, params });
      return answer(method, params, connection);
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onClose(listener) { closes.add(listener); return () => closes.delete(listener); },
    close() { connection.drop(closedError()); },
    drop(error = closedError()) {
      if (connection.closed) return;
      connection.closed = true;
      for (const listener of [...closes]) listener(error);
    },
    emit(envelope) { for (const listener of [...listeners]) listener(envelope); },
    listenerCount: () => listeners.size,
    sent: method => connection.requests.filter(request => request.method === method),
  };
  return connection;
}

function healthy(method, params) {
  if (method === 'library.models') return { models: [] };
  if (method === 'session.get') return { session: { id: params.sessionId, status: 'idle', projectRoot: '/w' } };
  if (method === 'session.attach') return { cursor: params.after ?? 0 };
  if (method === 'session.prompt') return { result: 'turn' };
  return {};
}

let seq = 0;
const envelope = (sessionId, cursor, event) => ({ sessionId, epoch: 'e1', seq: ++seq, cursor, event });
const started = (sessionId, cursor, turnId) => envelope(sessionId, cursor, { type: 'turn.started', turnId, origin: 'user' });
const ended = (sessionId, cursor, turnId) => envelope(sessionId, cursor, { type: 'turn.ended', turnId, state: 'completed' });

/** Providers still open: a failed assertion must not leave one reconnecting and the process alive. */
const live = new Set();
test.afterEach(async () => { for (const connection of live) await connection.close().catch(() => {}); live.clear(); });

/** A provider over `links` (each open() takes the next; a function entry may throw), with roots opened. */
async function provider(links, sessions = ['p1']) {
  const opened = [];
  const registration = createRemoteProvider({ url: 'http://127.0.0.1:1', token: 'alpgw1.x.y' }, {
    open: async () => {
      const next = links[Math.min(opened.length, links.length - 1)];
      opened.push(next);
      if (typeof next === 'function') return next();
      return { client: next, principal, capabilities: ['attach.after', 'prompt.receipts'] };
    },
  });
  const connection = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  live.add(connection);
  const events = [];
  connection.onEvent(event => events.push(event));
  for (const sessionId of sessions) {
    await connection.send({ type: 'session.open', requestId: `open-${sessionId}`, sessionId, config: { cwd: '/w', model: 'pho', mode: 'workspace-write', settings: {}, env: {}, mcpServers: {}, persist: true }, history: 'skip' });
  }
  return { connection, events, opened };
}

const prompt = (sessionId, clientMessageId) => ({ type: 'session.prompt', sessionId, prompt: { clientMessageId, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'hi' }] } } });
const failedRoots = events => events.filter(event => event.type === 'session.runtime_failed').map(event => event.sessionId);
const turns = (events, sessionId) => events.filter(event => event.type === 'session.turn' && event.sessionId === sessionId).map(event => `${event.turnId}:${event.state}`);
const dropsAt = method => (asked, params, connection) => {
  if (asked === method) { connection.drop(); throw closedError(); }
  return healthy(asked, params);
};

test('a connection that drops during reattach does not end the session and is reconnected', async () => {
  const first = fakeConnection('first');
  // The second link drops while the root is being attached again (a gateway or alpd restart).
  const second = fakeConnection('second', dropsAt('session.attach'));
  const third = fakeConnection('third', (method, params, connection) => {
    // alpd replays from the cursor asked for; the provider already saw 1 and 2.
    if (method === 'session.attach') {
      for (const replayed of [started('p1', 1, 't1'), ended('p1', 2, 't1'), started('p1', 3, 't2')]) if (replayed.cursor > params.after) connection.emit(replayed);
      return { cursor: 3 };
    }
    return healthy(method, params);
  });
  const { connection, events, opened } = await provider([first, second, third]);
  first.emit(started('p1', 1, 't1'));
  first.emit(ended('p1', 2, 't1'));

  first.drop(new Error('gateway restarted'));
  await until(() => opened.length >= 3 && third.sent('session.attach').length === 1, 'p1 attached on a third link');
  await until(() => events.some(event => event.type === 'timeline.item' && /reconnected/.test(event.item.message ?? '')), 'the reconnection is reported');

  assert.deepEqual(failedRoots(events), [], 'the session must not be failed for a transient drop');
  assert.equal(third.sent('session.attach')[0].params.after, 2, 'attached after the last cursor seen');
  assert.ok(second.closed);
  // Streaming continues on the new link, and nothing replayed was shown twice.
  third.emit(ended('p1', 4, 't2'));
  assert.deepEqual(turns(events, 'p1'), ['t1:started', 't1:completed', 't2:started', 't2:completed']);
  await connection.send(prompt('p1', 'm1'));
  assert.equal(third.sent('session.prompt').length, 1, 'a later prompt reaches alpd once');
  assert.equal(second.sent('session.prompt').length + first.sent('session.prompt').length, 0);
  assert.equal(second.listenerCount(), 0, 'the failed link keeps no listener');
  await connection.close();
});

test('a connection that drops at session.get during reattach is reconnected too', async () => {
  const first = fakeConnection('first');
  const second = fakeConnection('second', dropsAt('session.get'));
  const third = fakeConnection('third');
  const { connection, events, opened } = await provider([first, second, third]);
  first.drop();
  await until(() => third.sent('session.attach').length === 1, 'p1 attached on the third link');
  assert.deepEqual(failedRoots(events), []);
  assert.equal(opened.length, 3);
  await connection.send(prompt('p1', 'm1'));
  assert.equal(third.sent('session.prompt').length, 1);
  await connection.close();
});

test('a transient error answering reattach keeps the root for the next attempt', async () => {
  const first = fakeConnection('first');
  // The gateway answers but alpd is still coming back: not a verdict on the session.
  const second = fakeConnection('second', (method, params) => {
    if (method === 'session.get') throw rpcError(1000, 'alpd is not reachable', { reason: 'daemon_disconnected' });
    return healthy(method, params);
  });
  const third = fakeConnection('third');
  const { connection, events } = await provider([first, second, third]);
  first.drop(new Error('gateway restarted'));
  await until(() => third.sent('session.attach').length === 1, 'p1 attached on the third link');
  assert.deepEqual(failedRoots(events), [], 'a transient error must not end the session for good');
  assert.ok(second.closed, 'the link that failed the attempt is closed');
  await connection.send(prompt('p1', 'm1'));
  assert.equal(third.sent('session.prompt').length, 1);
  await connection.close();
});

test('with several roots, one that is gone fails alone and the others survive a drop mid-reattach', async () => {
  const first = fakeConnection('first');
  const second = fakeConnection('second', (method, params, connection) => {
    if (method === 'session.get' && params.sessionId === 'p2') throw rpcError(1001, 'No session p2');
    if (method === 'session.attach' && params.sessionId === 'p3') { connection.drop(); throw closedError(); }
    return healthy(method, params);
  });
  const third = fakeConnection('third');
  const { connection, events } = await provider([first, second, third], ['p1', 'p2', 'p3']);
  first.drop();
  await until(() => third.sent('session.attach').length === 2, 'the remaining roots attached on the third link');
  assert.deepEqual(failedRoots(events), ['p2'], 'only the root alpd no longer has fails');
  assert.deepEqual(third.sent('session.attach').map(request => request.params.sessionId).sort(), ['p1', 'p3']);
  await connection.send(prompt('p3', 'm3'));
  assert.equal(third.sent('session.prompt')[0].params.sessionId, 'p3');
  await connection.close();
});

test('closing the provider while it retries opens no further link', async () => {
  const first = fakeConnection('first');
  const unreachable = () => { throw new Error('The ALP gateway at http://127.0.0.1:1 cannot be reached'); };
  const { connection, opened } = await provider([first, unreachable]);
  first.drop();
  await until(() => opened.length >= 3, 'a few attempts');
  await connection.close();
  const after = opened.length;
  await sleep(1_500);
  assert.equal(opened.length, after, 'no link opened after close');
});

test('a refused credential fails the sessions once and stops reconnecting', async () => {
  const first = fakeConnection('first');
  const refused = () => { throw new GatewayAuthError('The ALP gateway refused this credential: it was revoked, rotated, expired or mistyped'); };
  const { connection, events, opened } = await provider([first, refused]);
  first.drop();
  await until(() => failedRoots(events).length === 1, 'the session fails');
  assert.match(events.find(event => event.type === 'session.runtime_failed').error.message, /refused this credential/);
  const attempts = opened.length;
  await sleep(600);
  assert.equal(opened.length, attempts, 'no retry after a refused credential');
  await connection.send(prompt('p1', 'm1'));
  const result = events.find(event => event.type === 'session.prompt_result');
  assert.equal(result.result.type, 'failed');
  assert.match(result.result.error.message, /refused this credential/);
  await connection.close();
});
