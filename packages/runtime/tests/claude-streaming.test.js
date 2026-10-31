import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { ClaudeTransport, createAlpRuntime } from '@anhlp/alp-runtime';

const text = text => ({ type: 'text', text });
const start = id => ({ type: 'message_start', message: { id, content: [] } });
const block = (index, content_block = text('')) => ({ type: 'content_block_start', index, content_block });
const delta = (index, text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const final = (id, content) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content } });
const result = { type: 'result', subtype: 'success', is_error: false };
const completed = seen => seen.filter(event => event.method === 'item/completed' && event.item.type === 'agentMessage').map(event => event.item.text);
async function until(check) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected streaming event did not arrive');
}
function fixture() {
  const transport = new ClaudeTransport(process.execPath, tmpdir(), process.env);
  transport.activeTurn = 'turn-1';
  const seen = [];
  transport.onNotification((method, params) => seen.push({ method, ...params }));
  return { transport, seen, stream: (event, parent_tool_use_id = null) => transport.handle({ type: 'stream_event', parent_tool_use_id, event }) };
}

test('Claude exposes growing text before the completed assistant message, then reconciles its final text', () => {
  const { transport, seen, stream } = fixture();
  stream(start('message-1'));
  stream(block(0));
  stream(delta(0, 'Hel'));
  assert.ok(seen.some(event => event.method === 'item/agentMessage/delta' && event.itemId === 'message-1' && event.delta === 'Hel'), 'text must reach viewers before any final assistant message');
  stream(delta(0, 'lo provisional'));
  transport.handle(final('message-1', [text('Hello final')]));
  assert.deepEqual(seen.filter(event => event.method === 'item/completed').map(event => event.item), [{ type: 'agentMessage', id: 'message-1', text: 'Hello final' }]);
});

test('Claude reconciles per-block finals sharing a message ID, preserves later drafts, and deduplicates envelopes', () => {
  const { transport, seen, stream } = fixture();
  stream(start('multi'));
  stream(block(0, { type: 'thinking', thinking: '' }));
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private' } });
  stream(block(1));
  stream(delta(1, 'wrong first'));
  stream({ type: 'content_block_stop', index: 1 });
  stream(block(2));
  stream(delta(2, ' second draft'));
  const first = { ...final('multi', [text('first')]), uuid: 'block-one' };
  transport.handle(first);
  assert.equal(completed(seen).at(-1), 'first second draft');
  transport.handle(first);
  stream({ type: 'content_block_stop', index: 2 });
  stream({ type: 'message_stop' });
  transport.handle({ ...final('multi', [text(' second')]), uuid: 'block-two' });
  assert.deepEqual(completed(seen), ['first second draft', 'first second']);
  assert.ok(!JSON.stringify(seen).includes('private'));
  transport.handle(result);
  assert.equal(transport.assistantText.size, 0);
});

test('Claude keeps text and tools ordered across blocks and messages, including nonstreamed replay', () => {
  const { transport, seen, stream } = fixture();
  const tool = { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo ok' } };
  stream(start('m1'));
  stream(block(0, text('before')));
  stream(block(1, { ...tool, input: {} }));
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } });
  assert.equal(seen.filter(event => event.item?.type === 'commandExecution').length, 0);
  transport.handle(final('m1', [text('before'), tool]));
  transport.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } });
  stream(start('m2'));
  stream(block(0));
  stream(delta(0, 'after'));
  transport.handle(final('m2', [text('after')]));
  transport.handle(final('replay', [text('same'), text('same')]));
  const items = seen.filter(event => event.item).map(event => [event.method, event.item.type, event.item.id, event.item.text]);
  assert.deepEqual(items.slice(0, 3), [
    ['item/completed', 'agentMessage', 'm1', 'before'],
    ['item/started', 'commandExecution', 'tool-1', undefined],
    ['item/completed', 'commandExecution', 'tool-1', undefined],
  ]);
  assert.deepEqual(completed(seen), ['before', 'after', 'same', 'samesame']);
});

test('Claude excludes subagent partials and finals without disturbing the parent stream', () => {
  const { transport, seen, stream } = fixture();
  stream(start('parent'));
  stream(block(0));
  stream(start('child'), 'tool-parent');
  stream(block(0), 'tool-parent');
  stream(delta(0, 'secret'), 'tool-parent');
  transport.handle({ ...final('child', [text('secret')]), parent_tool_use_id: 'tool-parent' });
  stream(delta(0, 'parent'));
  transport.handle(final('parent', [text('parent')]));
  assert.deepEqual(completed(seen), ['parent']);
  assert.deepEqual(seen.filter(event => event.method === 'item/agentMessage/delta').map(event => [event.itemId, event.delta]), [['parent', 'parent']]);
});

test('Claude interrupt, failed result, new turn, fatal failure and close discard stale partial correlation', async () => {
  const { transport, seen, stream } = fixture();
  let interrupted = false;
  transport.query = { interrupt: async () => { interrupted = true; }, close() {} };
  stream(start('old'));
  stream(block(0));
  stream(delta(0, 'unfinished'));
  await transport.request('turn/interrupt', {});
  stream(delta(0, ' stale'));
  assert.equal(interrupted, true);
  // An interrupted SDK block can still deliver authoritative truncated text.
  transport.handle(final('old', [text('truncated')]));
  assert.deepEqual(completed(seen), ['truncated']);
  transport.handle({ ...result, is_error: true, errors: ['stopped'] });
  assert.equal(transport.assistantText.size, 0);
  await transport.request('turn/start', { input: [text('again')] });
  stream(delta(0, ' stale'));
  stream(start('new'));
  stream(block(0));
  stream(delta(0, 'fresh'));
  await transport.request('turn/start', { input: [text('replace unfinished turn')] });
  assert.equal(transport.assistantText.size, 0);
  stream(delta(0, ' stale'));
  stream(start('failure'));
  stream(block(0));
  transport.onFailure(() => {});
  transport.fail(new Error('transport failed'));
  assert.equal(transport.assistantText.size, 0);
  stream(delta(0, ' stale'));
  await transport.close();
  stream(start('closed'));
  stream(block(0, text(' stale')));
  assert.deepEqual(seen.filter(event => event.method === 'item/agentMessage/delta').map(event => event.delta), ['unfinished', 'fresh']);
});

test('Claude background message_start adopts a turn before its first partial and message_stop does not finish it', () => {
  const { transport, seen, stream } = fixture();
  transport.activeTurn = undefined;
  stream(start('background'));
  stream(block(0, text('hello')));
  stream({ type: 'message_stop' });
  assert.equal(seen[0].method, 'turn/started');
  assert.equal(seen[1].turnId, seen[0].turn.id);
  assert.ok(!seen.some(event => event.method === 'turn/completed'));
  transport.handle(final('background', [text('hello')]));
  transport.handle(result);
  assert.equal(seen.at(-1).method, 'turn/completed');
});

test('the real Agent SDK opts into partials and public runtime items grow before final, including resume', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-claude-stream-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  const transports = [];
  let resumed;
  const runtime = createAlpRuntime({ supervisor: false, libraryDir: path.join(directory, 'home'), transport: () => {
    const transport = new ClaudeTransport(fileURLToPath(new URL('./support/streaming-claude.js', import.meta.url)), root, process.env);
    transports.push(transport);
    return transport;
  } });
  t.after(async () => {
    await resumed?.close();
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const events = [];
  runtime.onEvent(envelope => events.push(envelope.event));
  await runtime.open('root', { cwd: root, model: 'claude:sonnet' });
  await runtime.prompt('root', { clientMessageId: 'one', delivery: 'auto', content: [text('go')] });
  await until(() => events.some(event => event.type === 'turn.ended'));
  const answers = () => events.filter(event => event.type === 'item' && event.item.kind === 'assistant_message').map(event => [event.item.id, event.item.text]);
  assert.deepEqual(answers(), [['sdk-message', 'draft'], ['sdk-message', 'final']]);
  assert.ok(events.findIndex(event => event.item?.text === 'draft') < events.findIndex(event => event.type === 'turn.ended'));
  // Exercise resume through the actual SDK entrypoint without paid provider access.
  const transport = transports[0];
  transport.assistantState('stale').blocks.set(0, { text: 'stale', final: false });
  await transport.close();
  resumed = new ClaudeTransport(fileURLToPath(new URL('./support/streaming-claude.js', import.meta.url)), root, process.env);
  const seen = [];
  resumed.onNotification((method, params) => seen.push({ method, ...params }));
  await resumed.request('thread/resume', { ...transport.config, threadId: 'resumed-session' });
  await resumed.request('turn/start', { input: [text('again')] });
  await until(() => seen.some(event => event.method === 'turn/completed'));
  assert.deepEqual(completed(seen), ['final']);
  assert.equal(seen.find(event => event.method === 'item/agentMessage/delta').delta, 'draft');
});

// #116/#107: a reply main writes before a call that holds its turn (here alp_ask, through the real
// Agent SDK and its in-process MCP server) reaches viewers while that call still waits.
test('a reply written before a blocking ALP tool reaches viewers before the tool returns and the turn ends', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-claude-blocking-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  const runtime = createAlpRuntime({ supervisor: false, libraryDir: path.join(directory, 'home'), transport: () =>
    new ClaudeTransport(fileURLToPath(new URL('./support/blocking-claude.js', import.meta.url)), root, process.env) });
  t.after(async () => {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const events = [];
  runtime.onEvent(envelope => events.push(envelope.event));
  await runtime.open('root', { cwd: root, model: 'claude:sonnet' });
  await runtime.prompt('root', { clientMessageId: 'one', delivery: 'auto', content: [text('go')] });
  await until(() => runtime.questions().length === 1);
  const replies = () => events.filter(event => event.type === 'item' && event.item.kind === 'assistant_message').map(event => event.item.text);
  // The tool is still waiting for the user and the turn has not ended, yet the reply is out.
  assert.ok(replies().includes('Reply written before the blocking call.'), JSON.stringify(replies()));
  assert.equal(events.some(event => event.type === 'turn.ended'), false);
  runtime.answer(runtime.questions()[0].id, { text: 'Option A' });
  await until(() => events.some(event => event.type === 'turn.ended'));
  assert.equal(replies().at(-1), 'Thanks for answering.');
});

// t-efa3: the composer is not offered Claude's /clear, /compact and /rewind, whose work ALP does its own way.
test('Claude\'s commands for the composer leave out /clear, /compact and /rewind', async () => {
  const transport = new ClaudeTransport(process.execPath, tmpdir(), process.env);
  assert.deepEqual(await transport.commands(), [], 'none before the session starts');
  transport.query = { supportedCommands: async () => ['clear', 'compact', 'rewind', 'model', 'alp:xia'].map(name => ({ name, description: name, argumentHint: '' })) };
  assert.deepEqual(await transport.commands(), [{ name: 'model', description: 'model', kind: 'command' }, { name: 'alp:xia', description: 'alp:xia', kind: 'skill' }]);
});
