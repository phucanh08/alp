// Compact context from Paseo (t-de1a): the plugin's alp.agent.compact RPC asks alpd (locally over its
// socket, remotely through the gateway) for session.compact on the first of the agent's ids alpd knows;
// a refusal other than "no such session" is the answer. The client command resolves the agent's ALP
// session from its persistence handle first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCompactRpc } from '@anhlp/alp-paseo/panel/compact';
import { registerRemoteCompactRpc } from '@anhlp/alp-paseo/remote';

// `any`: daemon answers, events and fixtures are JSON of every shape; the tests read their fields.
type Json = any;

const rpcError = (code: Json, message: Json, data?: Json) => Object.assign(new Error(message), { code, ...(data ? { data } : {}) });

function harness(register: Json) {
  const handlers = new Map();
  const server = { handle(contract: Json, handler: Json) { handlers.set(contract.name, { contract, handler }); } };
  register(server);
  const call = async (input: Json) => { const { contract, handler } = handlers.get('alp.agent.compact'); return contract.output.parse(await handler(contract.input.parse(input))); };
  return { handlers, call };
}

function fakeAlpd(known: Json, refuse = {}) {
  const requests: Json[] = [];
  let closed = 0;
  return {
    requests, closed: () => closed,
    client: {
      async request(method: Json, params: Json) {
        requests.push({ method, params });
        if (method !== 'session.compact') throw new Error(`unexpected ${method}`);
        if ((refuse as Json)[params.sessionId]) throw (refuse as Json)[params.sessionId];
        if (!known.includes(params.sessionId)) throw rpcError(1001, `No session ${params.sessionId}`);
        return { status: 'started' };
      },
      close() { closed++; },
    },
  };
}

test('local: the persisted session id first; an unknown id skipped; one connection per request, closed', async () => {
  const alpd = fakeAlpd(['ses_alp']);
  const { call } = harness((server: Json) => registerCompactRpc(server, (async () => alpd.client) as Json));
  assert.deepEqual(await call({ sessions: ['paseo-agent-1', 'ses_alp'] }), { sessionId: 'ses_alp', status: 'started' });
  assert.deepEqual(alpd.requests.map(request => request.params.sessionId), ['paseo-agent-1', 'ses_alp']);
  assert.equal(alpd.closed(), 1);
  await assert.rejects(call({ sessions: ['nobody'] }), (error: Json) => error.code === 1001);
  assert.equal(alpd.closed(), 2);
  await assert.rejects(call({ sessions: [] }), /too_small|at least|>=1/i);
});

test('local: a refusal other than "no such session" is the answer, the next id is not tried', async () => {
  const alpd = fakeAlpd(['child', 'root'], { child: rpcError(1005, 'Only a root session is compacted', { reason: 'runtime_unsupported' }) });
  const { call } = harness((server: Json) => registerCompactRpc(server, (async () => alpd.client) as Json));
  await assert.rejects(call({ sessions: ['child', 'root'] }), (error: Json) => error.code === 1005 && error.data.reason === 'runtime_unsupported');
  assert.deepEqual(alpd.requests.map(request => request.params.sessionId), ['child']);
});

test('remote: through the gateway link, as the local plugin', async () => {
  const alpd = fakeAlpd(['ses_alp']);
  const link: Json = { request: (method: Json, params: Json) => alpd.client.request(method, params) };
  const { call } = harness((server: Json) => registerRemoteCompactRpc(server, link));
  assert.deepEqual(await call({ sessions: ['x', 'ses_alp'] }), { sessionId: 'ses_alp', status: 'started' });
  const denied = fakeAlpd([], { ses_alp: rpcError(1003, 'This credential lacks session.write', { reason: 'grant', permission: 'session.write' }) });
  const refused = harness((server: Json) => registerRemoteCompactRpc(server, { request: ((method: Json, params: Json) => denied.client.request(method, params)) as Json } as Json));
  await assert.rejects(refused.call({ sessions: ['ses_alp'] }), (error: Json) => error.code === 1003 && error.data.permission === 'session.write');
});
