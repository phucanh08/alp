// Paseo's Reload agent through the bridge (docs/protocol/alp-json-rpc-v1.md §12.8, issue #121 G2):
// refresh_agent_request on a live root is session.reload with the current history generation and a
// namespaced requestId; a closed root opens again on its conversation (session.create resume); an
// archived one is unarchived first, as Paseo's refresh does. A runtime alpd cannot reload, or a refusal,
// answers an error and the app's toast shows it. Paseo's Copy resume command is built by the app from a
// provider template; the bridge's provider has none, so it never offers a native command. An injected
// client factory stands in for alpd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgents } from '../server/dist/paseo/agents.js';

const directory = {
  load: async () => {}, prepare: async () => {}, workspaceIdFor: () => 'workspace',
  placement: () => ({ projectKey: 'p', projectName: 'p', directory: '/' }), assign: () => {}, changed: () => {},
};
const GENERATION = '0123456789abcdef0123456789abcdef';
const summary = (id, extra = {}) => ({ id, projectRoot: '/work', agent: 'main', runtime: 'codex', model: 'gpt-5.5', mode: 'workspace-write', thinking: 'medium', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, threadId: 't', persistent: true, busy: false, status: 'idle', conversation: { fork: true, rewind: true, reload: true }, ...extra });

function world({ sessions, capabilities = ['session.history', 'session.reload'], reloadError }) {
  const calls = [];
  const connection = {
    capabilities,
    onEvent: () => {}, onClose: () => {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.list') return { sessions };
      if (method === 'question.list') return { questions: [] };
      if (method === 'session.attach') return { session: sessions.find(session => session.id === params.sessionId), cursor: 0 };
      if (method === 'session.history') return { generation: GENERATION, hasOlder: false, tipCursor: 0, items: [] };
      if (method === 'session.reload') { if (reloadError) throw reloadError; return { session: sessions.find(session => session.id === params.sessionId) }; }
      if (method === 'session.create') { const session = sessions.find(row => row.id === params.sessionId); session.status = 'idle'; return { session }; }
      if (method === 'session.archive') { const session = sessions.find(row => row.id === params.sessionId); session.archived = params.archived !== false; return { session }; }
      throw new Error(`unexpected request ${method}`);
    },
  };
  const agents = createAgents({ clientFactory: async () => connection, broadcast: () => {}, directory });
  return { agents, calls };
}

const refreshAgent = (agents, agentId = 'ses_a', requestId = 'req-1') => agents.handlers.refresh_agent_request({ type: 'refresh_agent_request', agentId, requestId });
const sent = (calls, method) => calls.filter(call => call.method === method).map(call => call.params);

test('Reload agent on a live root is session.reload; Paseo gets agent_refreshed', async () => {
  const { agents, calls } = world({ sessions: [summary('ses_a')] });
  try {
    await agents.start();
    const answer = await refreshAgent(agents);
    assert.deepEqual(answer, { type: 'status', payload: { status: 'agent_refreshed', agentId: 'ses_a', requestId: 'req-1' } });
    assert.deepEqual(sent(calls, 'session.reload'), [{ sessionId: 'ses_a', requestId: 'paseo:req-1', ifGeneration: GENERATION }]);
    assert.deepEqual(sent(calls, 'session.create'), [], 'a live root is not reopened');
  } finally { agents.close(); }
});

test('Reload agent on a closed root opens it on its conversation; an archived one is unarchived first', async () => {
  const { agents, calls } = world({ sessions: [summary('ses_a', { status: 'closed' }), summary('ses_b', { status: 'closed', archived: true })] });
  try {
    await agents.start();
    assert.equal((await refreshAgent(agents, 'ses_a')).payload.status, 'agent_refreshed');
    assert.deepEqual(sent(calls, 'session.create'), [{ sessionId: 'ses_a', spec: { cwd: '/work' }, resume: true }]);
    assert.equal((await refreshAgent(agents, 'ses_b', 'req-2')).payload.status, 'agent_refreshed');
    assert.deepEqual(sent(calls, 'session.archive'), [{ sessionId: 'ses_b', archived: false }]);
    assert.deepEqual(sent(calls, 'session.create').at(-1), { sessionId: 'ses_b', spec: { cwd: '/work' }, resume: true });
    assert.deepEqual(sent(calls, 'session.reload'), []);
  } finally { agents.close(); }
});

test('a root alpd cannot reload, or a busy one, answers an error and nothing else is sent', async () => {
  for (const options of [
    { sessions: [summary('ses_a', { conversation: { fork: false, rewind: false, reload: false, reason: 'runtime_unsupported' } })] },
    { sessions: [summary('ses_a')], capabilities: ['session.history'] },
  ]) {
    const { agents, calls } = world(options);
    try {
      await agents.start();
      await assert.rejects(refreshAgent(agents), /cannot reload/);
      assert.deepEqual(sent(calls, 'session.reload'), []);
    } finally { agents.close(); }
  }
  const busy = world({ sessions: [summary('ses_a')], reloadError: Object.assign(new Error('Session ses_a is busy: a turn is running; try again when it is idle'), { code: 1004, data: { reason: 'session_busy' } }) });
  try {
    await busy.agents.start();
    await assert.rejects(refreshAgent(busy.agents), /busy/);
  } finally { busy.agents.close(); }
});

test('agents name the bridge\'s provider, for which Paseo has no resume template: no native command is offered', async () => {
  const { agents } = world({ sessions: [summary('ses_a')] });
  try {
    await agents.start();
    const { payload } = await agents.handlers.fetch_agent_request({ type: 'fetch_agent_request', agentId: 'ses_a', requestId: 'r' });
    // Paseo builds "codex resume <id>" / "claude --resume <id>" from these; an ALP agent is neither.
    assert.ok(!['codex', 'claude'].includes(payload.agent.provider), payload.agent.provider);
    assert.notEqual(payload.agent.persistence?.sessionId, 't', 'the native thread id is never the persistence handle');
  } finally { agents.close(); }
});
