// The ALP web app's Paseo facade (server/paseo/agents.ts, prompt-content.ts; issue #121 J): it sends a
// message's inline images as ALP image parts, refuses attachments (and Paseo's file upload) instead
// of dropping them, and reports a prompt alpd answered failed as not accepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAgents } from '../server/dist/paseo/agents.js';

const directory = { load: async () => {}, prepare: async () => {}, workspaceIdFor: () => 'workspace', placement: () => ({ projectKey: 'p', projectName: 'p', directory: '/' }), assign: () => {}, changed: () => {} };

async function facade(t, { promptAnswer = () => ({ outcome: 'accepted' }) } = {}) {
  const summary = id => ({ id, status: 'idle', projectRoot: '/', agent: 'main', title: 'root', runtime: 'claude', model: 'opus', mode: 'default', workflow: { mode: 'custom' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const session = summary('root-1');
  const sessions = [session];
  const calls = [];
  const clientFactory = async () => ({
    closed: false,
    onEvent: () => () => {},
    onClose: () => () => {},
    close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.list') return { sessions: structuredClone(sessions) };
      if (method === 'question.list') return { questions: [] };
      if (method === 'session.create') { sessions.push(summary(params.sessionId)); return { session: summary(params.sessionId) }; }
      if (method === 'session.prompt') return promptAnswer(params);
      return {};
    },
  });
  const agents = createAgents({ clientFactory, broadcast: () => {}, directory });
  t.after(() => agents.close());
  await agents.start();
  const send = message => agents.handlers.send_agent_message_request({ type: 'send_agent_message_request', requestId: 'r1', agentId: session.id, text: 'Hello', messageId: `m-${randomUUID()}`, ...message });
  const prompts = () => calls.filter(call => call.method === 'session.prompt');
  return { agents, send, prompts, calls };
}

test('the facade sends inline images as ALP image parts after the text', async t => {
  const { send, prompts } = await facade(t);
  const reply = await send({ images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }, { data: 'R0lGODlh', mimeType: 'image/gif' }] });
  assert.deepEqual(reply.payload, { requestId: 'r1', agentId: 'root-1', accepted: true, error: null });
  assert.deepEqual(prompts()[0].params.content, [{ type: 'text', text: 'Hello' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }, { type: 'image', mimeType: 'image/gif', data: 'R0lGODlh' }]);
  // Images without words: no empty text part.
  await send({ text: '', images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }] });
  assert.deepEqual(prompts()[1].params.content, [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]);
  // Text alone is as before.
  await send({});
  assert.deepEqual(prompts()[2].params.content, [{ type: 'text', text: 'Hello' }]);
});

test('the facade refuses attachments instead of dropping them, and nothing is sent', async t => {
  const { send, prompts, calls, agents } = await facade(t);
  const uploaded = { type: 'uploaded_file', id: `upload_${randomUUID()}`, fileName: 'plan.pdf', mimeType: 'application/pdf', size: 3, path: '/Users/someone/.paseo/uploads/x/plan.pdf' };
  const reply = await send({ attachments: [uploaded], activeTurnBehavior: 'interrupt' });
  assert.equal(reply.payload.accepted, false);
  assert.match(reply.payload.error, /ALP cannot send files \("plan\.pdf"\) attached in this app yet; nothing was sent/);
  assert.ok(!reply.payload.error.includes('/Users/someone'), 'no host path');
  const review = await send({ attachments: [{ type: 'review', mimeType: 'application/paseo-review', cwd: '/w', mode: 'uncommitted', comments: [] }, { type: 'text', mimeType: 'text/plain', title: 't', text: 'ctx' }] });
  assert.equal(review.payload.accepted, false);
  assert.match(review.payload.error, /review comments or text context/);
  assert.equal(prompts().length, 0, 'no prompt was sent');
  assert.ok(!calls.some(call => call.method === 'session.interrupt'), 'a refused message does not interrupt the running turn');

  // Paseo's upload itself is refused at once (the binary frames that follow are ignored).
  const upload = await agents.handlers['file.upload.request']({ type: 'file.upload.request', requestId: 'u1', fileName: 'plan.pdf', mimeType: 'application/pdf', size: 3, modifiedAt: new Date().toISOString() });
  assert.deepEqual(upload, { type: 'file.upload.response', payload: { requestId: 'u1', file: null, error: 'ALP does not take files uploaded through this app yet; nothing was uploaded.' } });

  // A new agent whose first message has attachments is not created.
  const created = await agents.handlers.create_agent_request({ type: 'create_agent_request', requestId: 'c1', config: { provider: 'alp', cwd: '/w' }, initialPrompt: 'go', attachments: [uploaded] }, { clientId: 'c', emit: () => {} });
  assert.equal(created.payload.status, 'agent_create_failed');
  assert.match(created.payload.error, /ALP cannot send files/);
  assert.ok(!calls.some(call => call.method === 'session.create'), 'no session was created');
});

test('the facade reports a prompt alpd answered failed as not accepted', async t => {
  const { send } = await facade(t, { promptAnswer: () => ({ outcome: 'failed', error: { message: 'Antigravity takes no images; send the message as text' } }) });
  const reply = await send({ images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }] });
  assert.deepEqual(reply.payload, { requestId: 'r1', agentId: 'root-1', accepted: false, error: 'Antigravity takes no images; send the message as text' });
});

test('a new agent\'s first message carries its images', async t => {
  const { agents, prompts } = await facade(t);
  const emitted = [];
  const reply = await agents.handlers.create_agent_request({ type: 'create_agent_request', requestId: 'c1', config: { provider: 'alp', cwd: '/w' }, initialPrompt: 'look', clientMessageId: 'cm1', images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }, { clientId: 'c', emit: frame => emitted.push(frame) });
  assert.equal(reply, undefined, JSON.stringify(reply));
  assert.equal(emitted[0]?.payload?.status, 'agent_created');
  const sent = prompts().find(call => call.params.clientMessageId === 'cm1');
  assert.deepEqual(sent.params.content, [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]);
});

test('a new agent whose first message failed is reported as a failure', async t => {
  const { agents } = await facade(t, { promptAnswer: () => ({ outcome: 'failed', error: { message: 'Antigravity takes no images; send the message as text' } }) });
  const reply = await agents.handlers.create_agent_request({ type: 'create_agent_request', requestId: 'c1', config: { provider: 'alp', cwd: '/w' }, initialPrompt: 'look', images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }, { clientId: 'c', emit: () => {} });
  assert.equal(reply.payload.status, 'agent_create_failed');
  assert.match(reply.payload.error, /its first message failed: Antigravity takes no images/);
});
