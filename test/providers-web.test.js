import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { validateWSOutboundMessage } from '@getpaseo/protocol/validation/ws-outbound';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { createDaemonServer, createPaseoBridge, createWebServer } from '../dist/daemon/index.js';
import { fakeTransport } from './support/fake-agent.js';

const FAKE = fileURLToPath(new URL('./support/fake-acp.js', import.meta.url));

/** alpd with its web socket, and an app past hello whose frames must pass Paseo's validator. */
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-providers-'));
  const home = path.join(directory, 'home');
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport([]), supervisor: false, libraryDir: home });
  const daemon = createDaemonServer({ runtime, socketPath: '', version: 'test' });
  let web;
  const gateway = createPaseoBridge({ daemon, version: 'test', home, token: () => web.token, serverId: () => web.serverId });
  web = createWebServer({ home, port: 0, app: { dir: directory, gateway } });
  const info = await web.listen();
  t.after(async () => { await web.close(); await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, { headers: { Origin: `http://127.0.0.1:${info.port}` } });
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const frames = [];
  const waiting = [];
  ws.on('message', data => {
    const frame = JSON.parse(String(data));
    const checked = validateWSOutboundMessage(frame);
    assert.ok(checked.success, `alpd sent a frame Paseo's app drops: ${JSON.stringify(frame).slice(0, 400)}`);
    frames.push(frame);
    for (const wait of [...waiting]) if (wait.test(frame)) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(frame); }
  });
  const next = test => new Promise(resolve => { const found = frames.find(test); if (found) resolve(found); else waiting.push({ test, resolve }); });
  /** Waits for a frame that arrives from now on. */
  const later = test => new Promise(resolve => waiting.push({ test, resolve }));
  const send = frame => ws.send(JSON.stringify(frame));
  send({ type: 'hello', clientId: 'cid-providers', clientType: 'browser', protocolVersion: 1, capabilities: { helloRejection: true }, auth: { kind: 'password', password: info.token } });
  await next(frame => frame.message?.payload?.status === 'server_info');
  let sequence = 0;
  const ask = async message => {
    const requestId = `r${++sequence}`;
    send({ type: 'session', message: { ...message, requestId } });
    return (await next(frame => frame.message?.payload?.requestId === requestId)).message;
  };
  return { home, ask, later };
}

const providerOf = (frame, id) => frame.message.payload.entries.find(entry => entry.provider === id);
const ready = id => frame => frame.message?.type === 'providers_snapshot_update' && providerOf(frame, id)?.status === 'ready';

test('the app adds an ACP agent from its catalog; alpd keeps it in the library and lists its models', async t => {
  const { home, ask, later } = await setup(t);
  const discovered = later(ready('fake'));
  const added = await ask({ type: 'set_daemon_config_request', config: { providers: { fake: {
    extends: 'acp', label: 'Fake', description: 'A scripted agent', command: [process.execPath, FAKE], env: { FAKE_ACP_MODELS: 'fast,deep' }, params: { supportsMcpServers: false },
  } } } });
  assert.equal(added.type, 'set_daemon_config_response');
  assert.deepEqual(added.payload.config.providers.fake.command, [process.execPath, FAKE]);
  const file = JSON.parse(await readFile(path.join(home, 'providers', 'fake.json'), 'utf8'));
  assert.deepEqual(file, { kind: 'acp', label: 'Fake', description: 'A scripted agent', command: process.execPath, args: [FAKE], env: { FAKE_ACP_MODELS: 'fast,deep' }, params: { supportsMcpServers: false } });

  const snapshot = await ask({ type: 'get_providers_snapshot_request' });
  assert.deepEqual(snapshot.payload.entries.map(entry => [entry.provider, entry.source]), [['alp', 'builtin'], ['fake', 'custom']]);
  const fake = providerOf(await discovered, 'fake');
  assert.deepEqual(fake.models.map(model => [model.id, model.isDefault ?? false]), [['fast', true], ['deep', false]]);
  assert.equal(fake.label, 'Fake');
  assert.equal(fake.enabled, true);

  const extra = later(frame => frame.message?.type === 'providers_snapshot_update' && providerOf(frame, 'fake')?.models.some(model => model.id === 'extra'));
  await ask({ type: 'set_daemon_config_request', config: { providers: { fake: { additionalModels: [{ id: 'extra', label: 'Extra', isDefault: false }] } } } });
  assert.deepEqual(providerOf(await extra, 'fake').models.map(model => model.id), ['fast', 'deep', 'extra'], 'added models come after the agent\'s own');
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'providers', 'fake.json'), 'utf8')).additionalModels, [{ id: 'extra', label: 'Extra' }]);

  const diagnostic = await ask({ type: 'provider_diagnostic_request', provider: 'fake' });
  assert.match(diagnostic.payload.diagnostic, /Command: .*fake-acp\.js/);
  assert.match(diagnostic.payload.diagnostic, /Models: fast, deep/);
  assert.equal((await ask({ type: 'refresh_providers_snapshot_request', providers: ['fake'] })).payload.acknowledged, true);

  const off = later(frame => frame.message?.type === 'providers_snapshot_update' && providerOf(frame, 'fake')?.enabled === false);
  const disabled = await ask({ type: 'set_daemon_config_request', config: { providers: { fake: { enabled: false } } } });
  assert.equal(disabled.payload.config.providers.fake.enabled, false);
  await off;

  const removed = await ask({ type: 'set_daemon_config_request', config: { removeProviders: ['fake'] } });
  assert.deepEqual(removed.payload.config.providers, {});
  await assert.rejects(access(path.join(home, 'providers', 'fake.json')));
  assert.deepEqual((await ask({ type: 'get_providers_snapshot_request' })).payload.entries.map(entry => entry.provider), ['alp']);
});

test('ALP itself, other kinds of provider and ids Paseo would not make are refused', async t => {
  const { ask } = await setup(t);
  for (const [config, error] of [
    [{ providers: { alp: { enabled: false } } }, /built into ALP/],
    [{ providers: { mine: { extends: 'claude', label: 'Mine' } } }, /ACP agents only/],
    [{ providers: { Bad_ID: { extends: 'acp', command: ['x'] } } }, /cannot name a provider/],
    [{ providers: { empty: { extends: 'acp', label: 'Empty' } } }, /needs a command/],
    [{ removeProviders: ['alp'] }, /cannot be removed/],
  ]) {
    const answer = await ask({ type: 'set_daemon_config_request', config });
    assert.equal(answer.type, 'rpc_error', JSON.stringify(config));
    assert.match(answer.payload.error, error);
  }
  const diagnostic = await ask({ type: 'provider_diagnostic_request', provider: 'alp' });
  assert.match(diagnostic.payload.diagnostic, /alp doctor/);
});
