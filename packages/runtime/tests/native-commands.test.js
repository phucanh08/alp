// t-e906: Claude's /clear starts a new conversation ALP does not follow; ALP refuses it before sending.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { createAlpRuntime, nativeCommandRefusal } from '@anhlp/alp-runtime';
import { fakeTransport, until } from '../../../test/support/fake-agent.js';

const text = value => [{ type: 'text', text: value }];

test('nativeCommandRefusal: /clear, /reset and /new on Claude only, at the start of the text', () => {
  for (const value of ['/clear', '  /clear', '/clear now', '/clear\nplease', '/new', '/reset', '/new idea']) assert.match(nativeCommandRefusal('claude', text(value)), /does not pass \/clear \(or \/new, \/reset\) to Claude[\s\S]*new session[\s\S]*compact/, value);
  for (const value of ['/clearly', 'please /clear', '/compact', 'clear', '/CLEARx', '/newline', '/resets']) assert.equal(nativeCommandRefusal('claude', text(value)), undefined, value);
  assert.equal(nativeCommandRefusal('codex', text('/clear')), undefined);
  assert.equal(nativeCommandRefusal('claude', [{ type: 'image', mimeType: 'image/png', data: '' }]), undefined);
  // The text parts as Claude gets them, joined: an empty first part does not hide it.
  assert.ok(nativeCommandRefusal('claude', [{ type: 'text', text: '' }, { type: 'text', text: '/clear' }]));
  assert.ok(nativeCommandRefusal('claude', [{ type: 'image', mimeType: 'image/png', data: '' }, { type: 'text', text: '/new' }]));
});

async function open(t, model) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-native-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  const runtimes = [];
  const events = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs') });
  t.after(() => runtime.shutdown());
  runtime.onEvent(envelope => events.push(envelope.event));
  await runtime.open('root', { cwd: root, model });
  return { runtime, runtimes, events };
}

test('a Claude session refuses /clear: refusesPrompt says why, and a prompt that gets through fails without reaching Claude', async t => {
  const { runtime, runtimes, events } = await open(t, 'claude:claude-sonnet-4-6');
  assert.match(runtime.refusesPrompt('root', text('/clear')), /new session/);
  assert.equal(runtime.refusesPrompt('root', text('hello')), undefined);
  await runtime.prompt('root', { clientMessageId: 'c1', delivery: 'auto', content: text('/clear') });
  await until(() => events.some(event => event.type === 'prompt.failed' && event.clientMessageId === 'c1'));
  assert.match(events.find(event => event.type === 'prompt.failed').error.message, /does not pass \/clear/);
  assert.equal(runtimes[0].calls.filter(call => call.method === 'turn/start').length, 0, 'nothing reached Claude');
});

test('a Codex session is not affected', async t => {
  const { runtime } = await open(t, 'codex:gpt-5.4');
  assert.equal(runtime.refusesPrompt('root', text('/clear')), undefined);
});
