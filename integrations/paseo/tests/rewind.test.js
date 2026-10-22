// Paseo's rewind through the bridge (docs/protocol/alp-json-rpc-v1.md §12.7, issue #121 C): conversation
// mode only, mapped to session.rewind before the turn the message started; the files and both modes are
// refused (ALP never restores files); agents advertise supportsRewindConversation only where alpd rewinds
// them; Paseo's text-summary fork (agentForkContext) is not advertised. An injected client factory stands
// in for alpd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgents } from '../server/dist/paseo/agents.js';

const directory = {
  load: async () => {}, prepare: async () => {}, workspaceIdFor: () => 'workspace',
  placement: () => ({ projectKey: 'p', projectName: 'p', directory: '/' }), assign: () => {}, changed: () => {},
};
const GENERATION = '0123456789abcdef0123456789abcdef';
const summary = (id, conversation) => ({ id, projectRoot: '/work', agent: 'main', runtime: 'codex', model: 'gpt-5.5', mode: 'workspace-write', thinking: 'medium', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, threadId: 't', persistent: true, busy: false, status: 'idle', ...(conversation ? { conversation } : {}) });
const envelope = (cursor, event) => ({ sessionId: 'ses_a', epoch: 'e', seq: cursor, ts: '2026-10-23T00:00:00.000Z', cursor, event });

function world({ sessions, capabilities = ['session.history', 'session.rewind'] }) {
  const calls = [];
  const connection = {
    capabilities,
    onEvent: () => {}, onClose: () => {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.list') return { sessions };
      if (method === 'question.list') return { questions: [] };
      if (method === 'session.attach') return { session: sessions[0], cursor: 4 };
      if (method === 'session.history') return { generation: GENERATION, hasOlder: false, tipCursor: 6, items: [
        envelope(1, { type: 'item', item: { kind: 'user_message', id: 'user:m1', clientMessageId: 'm1', text: 'one' } }),
        envelope(2, { type: 'prompt.accepted', clientMessageId: 'm1', result: 'turn', turnId: 'turn-1' }),
        envelope(3, { type: 'turn.ended', turnId: 'turn-1', state: 'completed' }),
        envelope(4, { type: 'item', item: { kind: 'user_message', id: 'user:m2', clientMessageId: 'm2', text: 'two' } }),
        envelope(5, { type: 'prompt.accepted', clientMessageId: 'm2', result: 'turn', turnId: 'turn-2' }),
        envelope(6, { type: 'prompt.accepted', clientMessageId: 'm3', result: 'steer', turnId: 'turn-2' }),
      ] };
      if (method === 'session.rewind') return { session: sessions[0], generation: 'fedcba9876543210fedcba9876543210', branch: { branchId: 'br_0123456789abcdef', beforeTurnId: params.beforeTurnId, turns: 1, at: 'now' } };
      throw new Error(`unexpected request ${method}`);
    },
  };
  const agents = createAgents({ clientFactory: async () => connection, broadcast: () => {}, directory });
  return { agents, calls };
}

const rewind = (agents, fields) => agents.handlers['agent.rewind.request']({ type: 'agent.rewind.request', agentId: 'ses_a', requestId: 'req-1', mode: 'conversation', messageId: 'm2', ...fields });

test('a conversation rewind becomes session.rewind before the turn the message started', async () => {
  const { agents, calls } = world({ sessions: [summary('ses_a', { fork: true, rewind: true })] });
  try {
    await agents.start();
    const answer = await rewind(agents);
    assert.deepEqual(answer, { type: 'agent.rewind.response', payload: { requestId: 'req-1', agentId: 'ses_a', ok: true, error: null } });
    const sent = calls.find(call => call.method === 'session.rewind');
    assert.deepEqual(sent.params, { sessionId: 'ses_a', requestId: 'paseo:req-1', ifGeneration: GENERATION, beforeTurnId: 'turn-2' });
    // The agent says it rewinds its conversation, never its files.
    const { payload } = await agents.handlers.fetch_agent_request({ type: 'fetch_agent_request', agentId: 'ses_a', requestId: 'r' });
    assert.equal(payload.agent.capabilities.supportsRewindConversation, true);
    assert.equal(payload.agent.capabilities.supportsRewindFiles, false);
    assert.equal(payload.agent.capabilities.supportsRewindBoth, false);
  } finally { agents.close(); }
});

test('files and both are refused, steers and unknown messages are refused, and nothing is sent', async () => {
  const { agents, calls } = world({ sessions: [summary('ses_a', { fork: true, rewind: true })] });
  try {
    await agents.start();
    for (const mode of ['files', 'both']) assert.match((await rewind(agents, { mode })).payload.error, /never restores or changes files/);
    assert.match((await rewind(agents, { messageId: 'm3' })).payload.error, /running turn/);
    assert.match((await rewind(agents, { messageId: 'nope' })).payload.error, /cannot find/);
    assert.equal(calls.filter(call => call.method === 'session.rewind').length, 0);
  } finally { agents.close(); }
});

test('an agent alpd cannot rewind says so and is refused', async () => {
  for (const [sessions, capabilities] of [[[summary('ses_a', { fork: false, rewind: false, reason: 'runtime_unsupported' })], undefined], [[summary('ses_a', { fork: true, rewind: true })], ['session.history']]]) {
    const { agents, calls } = world({ sessions, ...(capabilities ? { capabilities } : {}) });
    try {
      await agents.start();
      const { payload } = await agents.handlers.fetch_agent_request({ type: 'fetch_agent_request', agentId: 'ses_a', requestId: 'r' });
      assert.equal(payload.agent.capabilities.supportsRewindConversation, false);
      assert.match((await rewind(agents)).payload.error, /cannot be rewound/);
      assert.equal(calls.filter(call => call.method === 'session.rewind').length, 0);
    } finally { agents.close(); }
  }
});
