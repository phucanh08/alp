import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { validateWSOutboundMessage } from '@getpaseo/protocol/validation/ws-outbound';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { createWebServer } from '@anhlp/alp-paseo';
import { createPaseoBridge } from '@anhlp/alp-paseo';
import { fakeTransport } from '../../../test/support/fake-agent.js';
import { seedLibrary } from '@anhlp/alp-core/library';
import { saveEntry } from '@anhlp/alp-core/library-edit';
import { loadProvider } from '@anhlp/alp-core/providers';
import { initProject } from '@anhlp/alp-core/init';
import { resolveSession } from '@anhlp/alp-runtime';

const FAKE = fileURLToPath(new URL('../../../test/support/fake-acp.js', import.meta.url));

/** alpd with its web socket, and an app past hello whose frames must pass Paseo's validator. */
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-providers-'));
  const home = path.join(directory, 'home');
  await seedLibrary(home);
  // No installed CLIs or account access in the websocket tests.
  for (const id of ['opencode', 'antigravity']) {
    const file = JSON.parse(await readFile(path.join(home, 'providers', `${id}.json`), 'utf8'));
    await saveEntry('providers', id, { provider: { ...file, command: `alp-test-missing-${id}` } }, { scope: 'library', library: home });
  }
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport([]), supervisor: false, libraryDir: home });
  const daemon = createDaemonServer({ runtime, socketPath: '', version: 'test', home });
  let web;
  const gateway = createPaseoBridge({ clientFactory: async (onEvent) => {
    const client = daemon.local();
    client.onEvent(onEvent);
    return { request: client.request.bind(client), close: client.close.bind(client), onClose: client.onClose.bind(client) };
  }, version: 'test', home, token: () => web.token, serverId: () => web.serverId });
  web = createWebServer({ home, port: 0, gateway });
  const info = await web.listen();
  t.after(async () => { await web.close(); await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
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
  const hello = await next(frame => frame.message?.payload?.status === 'server_info');
  assert.equal(hello.message.payload.features.providerRemoval, true, 'the app offers Remove on providers');
  let sequence = 0;
  const ask = async message => {
    const requestId = `r${++sequence}`;
    send({ type: 'session', message: { ...message, requestId } });
    return (await next(frame => frame.message?.payload?.requestId === requestId)).message;
  };
  return { home, ask, later, runtime };
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

  const snapshot = await ask({ type: 'get_providers_snapshot_request', cwd: home });
  assert.deepEqual(snapshot.payload.entries.map(entry => [entry.provider, entry.source]), [['alp', 'builtin'], ['claude', 'builtin'], ['codex', 'builtin'], ['antigravity', 'custom'], ['fake', 'custom'], ['opencode', 'custom']]);
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
  assert.deepEqual(Object.keys(removed.payload.config.providers), ['antigravity', 'opencode']);
  await assert.rejects(access(path.join(home, 'providers', 'fake.json')));
  assert.deepEqual((await ask({ type: 'get_providers_snapshot_request', cwd: home })).payload.entries.map(entry => entry.provider), ['alp', 'claude', 'codex', 'antigravity', 'opencode']);
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

test('host Settings lists providers without previewing a project in the home directory', async t => {
  const { ask, runtime } = await setup(t);
  runtime.preview = async () => { throw new Error('Host settings must not preview a project'); };
  const snapshot = await ask({ type: 'get_providers_snapshot_request' });
  assert.equal(snapshot.type, 'get_providers_snapshot_response');
  assert.equal(snapshot.payload.entries[0].provider, 'alp');
  assert.deepEqual(snapshot.payload.entries[0].models.map(model => model.id), ['pho', 'cafe']);
});

test('provider snapshots expose native runtimes and ACP agents alongside the internal team entry', async t => {
  const { ask } = await setup(t);
  const snapshot = await ask({ type: 'get_providers_snapshot_request' });
  assert.deepEqual(snapshot.payload.entries.map(entry => entry.provider), ['alp', 'claude', 'codex', 'antigravity', 'opencode']);
  for (const provider of ['claude', 'codex']) {
    const entry = snapshot.payload.entries.find(entry => entry.provider === provider);
    assert.equal(entry.source, 'builtin');
    assert.ok(entry.models.length > 0);
    assert.ok(entry.models.every(model => model.provider === provider));
  }
});

test('native providers list the models of alpd\'s live catalog cache (t-e5ee), read fresh on each snapshot', async t => {
  const { home, ask } = await setup(t);
  const before = await ask({ type: 'get_providers_snapshot_request' });
  assert.ok(!before.payload.entries.find(entry => entry.provider === 'codex').models.some(model => model.id === 'gpt-6.1-terra'));
  await mkdir(path.join(home, 'cache'), { recursive: true });
  await writeFile(path.join(home, 'cache', 'models.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), providers: { codex: { status: 'ok', models: [{ id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', efforts: ['low'] }] } } }));
  const after = await ask({ type: 'get_providers_snapshot_request' });
  const codex = after.payload.entries.find(entry => entry.provider === 'codex');
  assert.equal(codex.models[0].id, 'gpt-6.1-terra');
  assert.equal(codex.models[0].isDefault, true);
  assert.ok(codex.models.some(model => model.id === 'gpt-6.1-sol'), 'static rows stay as fallback');
});

test('default provider switches persist and disabled providers cannot open sessions', async t => {
  const { home, ask } = await setup(t);
  const root = path.join(home, 'project');
  await initProject(root);
  for (const [id, model, kind] of [
    ['opencode', 'acp:opencode/opencode/cat-jam-free', 'acp'],
    ['antigravity', 'antigravity:gemini-3.8-flash-high', 'antigravity'],
  ]) {
    const changed = await ask({ type: 'set_daemon_config_request', config: { providers: { [id]: { enabled: false } } } });
    assert.equal(changed.type, 'set_daemon_config_response');
    assert.equal(changed.payload.config.providers[id].enabled, false);
    await seedLibrary(home);
    assert.equal((await loadProvider(home, id)).enabled, false);
    const snapshot = await ask({ type: 'get_providers_snapshot_request' });
    const entry = snapshot.payload.entries.find(entry => entry.provider === id);
    assert.equal(entry.enabled, false);
    assert.equal(entry.source, 'custom', 'library providers have an enabled switch');
    await assert.rejects(resolveSession({ cwd: root, model, mode: 'full-access' }, { library: home }), /turned off/);
    await ask({ type: 'set_daemon_config_request', config: { providers: { [id]: { enabled: true } } } });
    assert.equal((await resolveSession({ cwd: root, model, mode: 'full-access' }, { library: home })).runtimeKind, kind);
  }
});

test('Antigravity supports partial provider edits and can be disabled', async t => {
  const { home, ask } = await setup(t);
  const added = await ask({ type: 'set_daemon_config_request', config: { providers: { antigravity: {
    extends: 'antigravity', command: [process.execPath, fileURLToPath(new URL('../../../test/support/fake-agy.js', import.meta.url))],
  } } } });
  assert.equal(added.type, 'set_daemon_config_response');
  const changed = await ask({ type: 'set_daemon_config_request', config: { providers: { antigravity: { enabled: false, label: 'AGY local' } } } });
  assert.equal(changed.type, 'set_daemon_config_response');
  const config = JSON.parse(await readFile(path.join(home, 'providers/antigravity.json'), 'utf8'));
  assert.equal(config.enabled, false);
  assert.equal(config.label, 'AGY local');
});
