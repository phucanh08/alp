// Compact context from Paseo (t-de1a): the plugin's alp.agent.compact RPC asks alpd (locally over its
// socket, remotely through the gateway) for session.compact on the first of the agent's ids alpd knows;
// a refusal other than "no such session" is the answer. The client command resolves the agent's ALP
// session from its persistence handle first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCompactRpc } from '@anhlp/alp-paseo/panel/compact';
import { registerRemoteCompactRpc } from '@anhlp/alp-paseo/remote';

const rpcError = (code, message, data) => Object.assign(new Error(message), { code, ...(data ? { data } : {}) });

function harness(register) {
  const handlers = new Map();
  const server = { handle(contract, handler) { handlers.set(contract.name, { contract, handler }); } };
  register(server);
  const call = async input => { const { contract, handler } = handlers.get('alp.agent.compact'); return contract.output.parse(await handler(contract.input.parse(input))); };
  return { handlers, call };
}

function fakeAlpd(known, refuse = {}) {
  const requests = [];
  let closed = 0;
  return {
    requests, closed: () => closed,
    client: {
      async request(method, params) {
        requests.push({ method, params });
        if (method !== 'session.compact') throw new Error(`unexpected ${method}`);
        if (refuse[params.sessionId]) throw refuse[params.sessionId];
        if (!known.includes(params.sessionId)) throw rpcError(1001, `No session ${params.sessionId}`);
        return { status: 'started' };
      },
      close() { closed++; },
    },
  };
}

test('local: the persisted session id first; an unknown id skipped; one connection per request, closed', async () => {
  const alpd = fakeAlpd(['ses_alp']);
  const { call } = harness(server => registerCompactRpc(server, async () => alpd.client));
  assert.deepEqual(await call({ sessions: ['paseo-agent-1', 'ses_alp'] }), { sessionId: 'ses_alp', status: 'started' });
  assert.deepEqual(alpd.requests.map(request => request.params.sessionId), ['paseo-agent-1', 'ses_alp']);
  assert.equal(alpd.closed(), 1);
  await assert.rejects(call({ sessions: ['nobody'] }), error => error.code === 1001);
  assert.equal(alpd.closed(), 2);
  await assert.rejects(call({ sessions: [] }), /too_small|at least|>=1/i);
});

test('local: a refusal other than "no such session" is the answer, the next id is not tried', async () => {
  const alpd = fakeAlpd(['child', 'root'], { child: rpcError(1005, 'Only a root session is compacted', { reason: 'runtime_unsupported' }) });
  const { call } = harness(server => registerCompactRpc(server, async () => alpd.client));
  await assert.rejects(call({ sessions: ['child', 'root'] }), error => error.code === 1005 && error.data.reason === 'runtime_unsupported');
  assert.deepEqual(alpd.requests.map(request => request.params.sessionId), ['child']);
});

test('remote: through the gateway link, as the local plugin', async () => {
  const alpd = fakeAlpd(['ses_alp']);
  const link = { request: (method, params) => alpd.client.request(method, params) };
  const { call } = harness(server => registerRemoteCompactRpc(server, link));
  assert.deepEqual(await call({ sessions: ['x', 'ses_alp'] }), { sessionId: 'ses_alp', status: 'started' });
  const denied = fakeAlpd([], { ses_alp: rpcError(1003, 'This credential lacks session.write', { reason: 'grant', permission: 'session.write' }) });
  const refused = harness(server => registerRemoteCompactRpc(server, { request: (method, params) => denied.client.request(method, params) }));
  await assert.rejects(refused.call({ sessions: ['ses_alp'] }), error => error.code === 1003 && error.data.permission === 'session.write');
});
