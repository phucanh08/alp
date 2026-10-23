// Paseo's model and thinking pickers on an existing agent through the bridge (docs/protocol/
// alp-json-rpc-v1.md §12.9, issue #121 D): an ALP root's Paseo "model" is its team (a custom root's,
// its runtime:model), so set_agent_model_request is session.configure { team } (or { model }), and
// set_agent_thinking_request session.configure { thinking }, with the current history generation and
// a namespaced requestId. A closed root is opened first; a daemon or session that cannot change a
// running agent, or alpd's refusal, answers accepted: false with the reason. An injected client
// factory stands in for alpd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgents } from '../server/dist/paseo/agents.js';

const directory = {
  load: async () => {}, prepare: async () => {}, workspaceIdFor: () => 'workspace',
  placement: () => ({ projectKey: 'p', projectName: 'p', directory: '/' }), assign: () => {}, changed: () => {},
};
const GENERATION = '0123456789abcdef0123456789abcdef';
const CONVERSATION = { fork: true, rewind: true, reload: true, configure: true };
const summary = (id, extra = {}) => ({ id, projectRoot: '/work', agent: 'main', runtime: 'codex', model: 'gpt-5.6-sol', mode: 'workspace-write', thinking: 'medium', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, threadId: 't', persistent: true, busy: false, status: 'idle', conversation: CONVERSATION, ...extra });

function world({ sessions, capabilities = ['session.history', 'session.configure.live'], configureError }) {
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
      if (method === 'session.create') { const session = sessions.find(row => row.id === params.sessionId); session.status = 'idle'; return { session }; }
      if (method === 'session.configure') {
        if (configureError) throw configureError;
        const session = sessions.find(row => row.id === params.sessionId);
        if (params.team) session.workflow = { ...session.workflow, mode: params.team };
        if (params.model) session.model = params.model.replace(/^codex:/, '');
        if (params.thinking) session.thinking = params.thinking;
        return { session, configured: { status: 'applied', requested: {}, effective: {}, restarted: true } };
      }
      throw new Error(`unexpected request ${method}`);
    },
  };
  const agents = createAgents({ clientFactory: async () => connection, broadcast: () => {}, directory });
  return { agents, calls };
}

const sent = (calls, method) => calls.filter(call => call.method === method).map(call => call.params);
const setModel = (agents, modelId, agentId = 'ses_a', requestId = 'req-1') => agents.handlers.set_agent_model_request({ type: 'set_agent_model_request', agentId, modelId, requestId });
const setThinking = (agents, thinkingOptionId, agentId = 'ses_a', requestId = 'req-2') => agents.handlers.set_agent_thinking_request({ type: 'set_agent_thinking_request', agentId, thinkingOptionId, requestId });

test('the model picker changes a team root\'s team, and a custom root\'s model; the thinking picker its effort', async () => {
  const { agents, calls } = world({ sessions: [summary('ses_a'), summary('ses_c', { workflow: { mode: 'custom', maxPeers: 2, supervisor: false } })] });
  try {
    await agents.start();
    assert.deepEqual(await setModel(agents, 'cafe'), { type: 'set_agent_model_response', payload: { requestId: 'req-1', agentId: 'ses_a', accepted: true, error: null } });
    assert.deepEqual(sent(calls, 'session.configure'), [{ sessionId: 'ses_a', team: 'cafe', requestId: 'paseo:req-1', ifGeneration: GENERATION }]);
    assert.equal((await setThinking(agents, 'high')).payload.accepted, true);
    assert.deepEqual(sent(calls, 'session.configure').at(-1), { sessionId: 'ses_a', thinking: 'high', requestId: 'paseo:req-2', ifGeneration: GENERATION });
    assert.equal((await setModel(agents, 'codex:gpt-6.1-sol', 'ses_c', 'req-3')).payload.accepted, true);
    assert.deepEqual(sent(calls, 'session.configure').at(-1), { sessionId: 'ses_c', model: 'codex:gpt-6.1-sol', requestId: 'paseo:req-3', ifGeneration: GENERATION });
    // The same choice again changes nothing.
    const before = sent(calls, 'session.configure').length;
    assert.equal((await setModel(agents, 'cafe', 'ses_a', 'req-4')).payload.accepted, true);
    assert.equal((await setThinking(agents, 'high', 'ses_a', 'req-5')).payload.accepted, true);
    assert.equal(sent(calls, 'session.configure').length, before);
  } finally { agents.close(); }
});

test('a closed root opens first; a daemon or session that cannot change a running agent, or a refusal, is not accepted', async () => {
  const closed = world({ sessions: [summary('ses_a', { status: 'closed' })] });
  try {
    await closed.agents.start();
    assert.equal((await setModel(closed.agents, 'cafe')).payload.accepted, true);
    assert.deepEqual(sent(closed.calls, 'session.create'), [{ sessionId: 'ses_a', spec: { cwd: '/work' }, resume: true }]);
    assert.equal(sent(closed.calls, 'session.configure').length, 1);
  } finally { closed.agents.close(); }

  const older = world({ sessions: [summary('ses_a')], capabilities: ['session.history'] });
  try {
    await older.agents.start();
    const answer = await setModel(older.agents, 'cafe');
    assert.equal(answer.payload.accepted, false);
    assert.match(answer.payload.error, /start a new agent/);
    assert.deepEqual(sent(older.calls, 'session.configure'), []);
  } finally { older.agents.close(); }

  const unsupported = world({ sessions: [summary('ses_a', { conversation: { fork: false, rewind: false, configure: false, reason: 'runtime_unsupported' } })] });
  try {
    await unsupported.agents.start();
    assert.equal((await setThinking(unsupported.agents, 'high')).payload.accepted, false);
    assert.deepEqual(sent(unsupported.calls, 'session.configure'), []);
  } finally { unsupported.agents.close(); }

  const busy = world({ sessions: [summary('ses_a')], configureError: Object.assign(new Error('Session ses_a is busy: a turn is running; try again when it is idle'), { code: 1004, data: { reason: 'session_busy' } }) });
  try {
    await busy.agents.start();
    const answer = await setModel(busy.agents, 'cafe');
    assert.equal(answer.payload.accepted, false);
    assert.match(answer.payload.error, /busy/);
    assert.equal(answer.payload.agentId, 'ses_a');
    assert.equal((await setModel(busy.agents, null)).payload.accepted, false);
  } finally { busy.agents.close(); }
});
