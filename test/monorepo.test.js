import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import Ajv from 'ajv';
import { PROTOCOL_VERSION, MAX_FRAME, RPC_METHODS, ERROR, encodeFrame, decodeFrame } from '@anhlp/alp-protocol';
import { createTransport, createProviderRegistry, ProviderRegistry } from '@anhlp/alp-runtime/providers';
import { createAlpRuntime } from '../dist/runtime/index.js';

const root = path.resolve(import.meta.dirname, '..');
const schema = JSON.parse(await readFile(new URL('../packages/protocol/schema/ipc-v1.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);
const validateEnvelope = ajv.compile({ $ref: `${schema.$id}#/$defs/envelope` });

test('workspace source dependencies are declared, acyclic and stay inside their packages', () => {
  const result = spawnSync(process.execPath, ['scripts/check-boundaries.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('v1 fixtures and method inventory remain compatible with existing daemon handlers', async () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(MAX_FRAME, 16 * 1024 * 1024);
  assert.deepEqual(ERROR, { failed: 1000, notFound: 1001, conflict: 1004, protocol: 1006 });
  const validate = ajv.getSchema(schema.$id);
  const notification = ajv.compile({ $ref: `${schema.$id}#/$defs/notification` });
  const lines = (await readFile(new URL('../packages/protocol/fixtures/ipc-v1.jsonl', import.meta.url), 'utf8')).trim().split('\n');
  for (const line of lines) {
    const frame = decodeFrame(line);
    assert.deepEqual(decodeFrame(encodeFrame(frame)), frame);
    assert.ok(validate(frame), JSON.stringify(validate.errors));
    if (frame.method === 'event') assert.ok(notification(frame), JSON.stringify(notification.errors));
  }
  const server = await readFile(new URL('../packages/daemon/src/server.ts', import.meta.url), 'utf8');
  const methods = ['daemon.hello', ...Array.from(server.matchAll(/^\s*(?:async )?'([a-z]+\.[a-z]+)'(?:\(|:)/gm), match => match[1])].sort();
  assert.deepEqual([...RPC_METHODS].sort(), methods);
  const methodSchema = JSON.parse(await readFile(new URL('../packages/protocol/schema/methods-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(methodSchema.methods).sort(), methods);
  for (const method of methods) ajv.compile({ ...methodSchema.methods[method].params, $defs: methodSchema.$defs });
  const eventTypes = Array.from((await readFile(new URL('../packages/protocol/src/events.ts', import.meta.url), 'utf8')).split('export type AlpEvent =')[1].matchAll(/\{ type: '([^']+)'/g), match => match[1]);
  assert.deepEqual(schema.$defs.event.oneOf.map(event => event.properties.type.const).sort(), eventTypes.sort());
  assert.equal(validateEnvelope({ sessionId: 'a', epoch: 'e', seq: -1, ts: 't', event: { type: 'session.ready' } }), false);
  assert.equal(validateEnvelope({ sessionId: 'a', epoch: 'e', seq: 0, ts: 't', event: { type: 'item' } }), false);
});

test('provider adapters are extensible per instance and preserve legacy factory precedence', () => {
  const native = createProviderRegistry();
  assert.deepEqual(native.list(), ['codex', 'claude', 'acp', 'antigravity']);
  const transport = { adapter: 'fake' };
  let received;
  const registry = createProviderRegistry({ claude: context => { received = context; return transport; } });
  const environment = { CUSTOM: 'yes' };
  assert.equal(createTransport({ providerRegistry: registry }, 'claude', '/tmp/project', environment), transport);
  assert.equal(received.cwd, '/tmp/project');
  assert.equal(received.environment, environment);
  assert.equal(received.runtime, 'claude');
  const custom = new ProviderRegistry({ 'acp:custom': () => transport });
  assert.equal(createTransport({ providerRegistry: custom }, 'acp', '/tmp/project', {}, { id: 'custom' }), transport);
  const legacy = { adapter: 'legacy' };
  let args;
  assert.equal(createTransport({ providerRegistry: registry, transport: (...passed) => { args = passed; return legacy; } }, 'claude', '/tmp/project', environment), legacy);
  assert.deepEqual(args, ['/tmp/project', environment, 'claude', undefined, undefined]);
  assert.throws(() => custom.register('', () => transport), /needs an id/);
  assert.throws(() => custom.create('missing', {}), /Unknown runtime provider/);
});

test('runtime emits schema-compatible v1 events through the existing provider injection seam', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'alp-contract-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const emitted = [];
  const runtime = createAlpRuntime({ transport: () => ({
    initialize: async () => {}, onNotification() {}, onFailure() {}, onRequest() {}, close: async () => {},
    request: async method => method.startsWith('thread/') ? { thread: { id: 'native' } } : {},
  }) });
  t.after(() => runtime.shutdown());
  runtime.onEvent(envelope => emitted.push(envelope));
  await runtime.open('contract', { cwd, persist: true, mode: 'read-only' });
  await runtime.close('contract');
  assert.ok(emitted.length >= 3);
  for (const envelope of emitted) assert.ok(validateEnvelope(envelope), JSON.stringify(validateEnvelope.errors));
});


test('canonical Paseo plugin and root compatibility distribution remain buildable without legacy folders', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.workspaces.includes('packages/paseo'));
  assert.ok(!manifest.workspaces.includes('integrations/paseo-plugin'));
  assert.equal(manifest.bin.alp, 'packages/cli/dist/cli.js');
  const pkg = JSON.parse(await readFile(path.join(root, 'packages/paseo/package.json'), 'utf8'));
  assert.equal(pkg.name, 'alp-paseo-plugin');
  assert.equal(pkg.version, '0.9.5');
  const pluginManifest = await readFile(path.join(root, 'packages/paseo/paseo-plugin.json'), 'utf8');
  assert.match(pluginManifest, /"id":/);
  const loaded = await import('../packages/paseo/server/dist/index.js');
  assert.equal(typeof loaded.default, 'function');
  for (const file of ['index.js', 'alpd.js']) {
    assert.ok(existsSync(path.join(root, 'packages/paseo/server/dist', file)), `missing ${file}`);
    assert.ok(existsSync(path.join(root, 'packages/cli/dist/cli.js')), 'missing root CLI build');
  }
  for (const legacy of ['src', 'plugins/paseo', 'integrations/paseo-plugin']) {
    assert.ok(!existsSync(path.join(root, legacy)), `${legacy} must not be recreated`);
  }
});
