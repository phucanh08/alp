import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { createAgents } from '../server/dist/paseo/agents.js';

/**
 * The four lifecycle-review fixes on the agents bridge: a failed first factory must not poison
 * every later handler, and a connection that connected but whose first refresh failed is
 * half-open and must be dropped and retried rather than spun on. Both are driven with an injected
 * client factory, so no daemon is involved and the failure order is exact.
 */
const directory = {
  load: async () => {},
  workspaceIdFor: () => 'workspace',
  placement: () => ({ projectKey: 'p', projectName: 'p', directory: '/' }),
  assign: () => {},
  changed: () => {},
};

/** A DaemonConnection the bridge can attach to, recording calls and answering the two list RPCs. */
function fakeConnection({ onRequest } = {}) {
  const listeners = { event: [], close: [] };
  const connection = {
    calls: [],
    closed: false,
    onEvent: listener => listeners.event.push(listener),
    onClose: listener => listeners.close.push(listener),
    close() { if (connection.closed) return; connection.closed = true; for (const listener of listeners.close) listener(); },
    async request(method, params) {
      connection.calls.push(method);
      if (onRequest) return onRequest(method, params, connection);
      if (method === 'session.list') return { sessions: [] };
      if (method === 'question.list') return { questions: [] };
      if (method === 'session.attach') return {};
      throw new Error(`unexpected request ${method}`);
    },
  };
  return connection;
}

async function until(check, what, tries = 200) {
  for (let i = 0; i < tries; i++) { if (check()) return; await sleep(25); }
  assert.fail(`Expected ${what} did not happen`);
}

test('a failed first factory is retried, not memoized, and the bridge recovers', async () => {
  const connections = [];
  let factoryCalls = 0;
  const clientFactory = async () => {
    factoryCalls += 1;
    if (factoryCalls === 1) throw new Error('daemon not up yet');
    const connection = fakeConnection();
    connections.push(connection);
    return connection;
  };
  const agents = createAgents({ clientFactory, broadcast: () => {}, directory });
  try {
    await assert.rejects(() => agents.start(), /daemon not up yet/);
    // The scheduled initial reconnect brings a connection up without any second start() call.
    await until(() => connections.length === 1 && connections[0].calls.includes('session.list'), 'the scheduled reconnect to refresh');
    // The rejected promise is not memoized: a later start() must attempt again and resolve.
    await agents.start();
    assert.equal(factoryCalls, 3, 'a fresh attempt followed the failure');
  } finally { agents.close(); }
});

test('a connection whose first refresh fails is dropped as half-open and replaced', async () => {
  const connections = [];
  let factoryCalls = 0;
  const clientFactory = async () => {
    factoryCalls += 1;
    const call = factoryCalls;
    const connection = fakeConnection({
      onRequest: method => {
        if (method === 'session.list' && call === 2) throw new Error('daemon is restarting');
        if (method === 'session.list') return { sessions: [] };
        if (method === 'question.list') return { questions: [] };
        return {};
      },
    });
    connections.push(connection);
    return connection;
  };
  const agents = createAgents({ clientFactory, broadcast: () => {}, directory });
  try {
    await agents.start();
    assert.equal(connections.length, 1, 'the first connection is live');
    // Lose the live socket: the bridge schedules a reconnect.
    connections[0].close();
    // The reconnect's first connection connects but fails its refresh; it must be closed, and a
    // third connection must be used instead of spinning on the dead one.
    await until(() => connections.length >= 3 && connections[2].calls.includes('session.list'), 'the refresh to succeed on a replacement connection');
    assert.equal(connections[1].closed, true, 'the half-open connection was dropped');
    assert.equal(connections[2].calls.filter(method => method === 'session.list').length, 1, 'the replacement refreshed exactly once');
  } finally { agents.close(); }
});
