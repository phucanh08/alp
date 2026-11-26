// Settings' host pages (t-a95b.1 group B; docs/alp/dashboard.md §4.7): the host.* owner methods of
// the `// --- owner: host (group B) ---` block. Only the owner gateway's owner credential on a direct
// loopback socket reaches their handlers, with only the params the matrix lists; a standalone gateway
// and any other credential get exactly a denied method's refusal, and neither the handler nor alpd
// sees anything. The handlers themselves are tested in packages/cli/tests/dashboard-owner-host.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAPABILITY } from '@anhlp/alp-protocol';
import { EXPOSURE } from '../dist/index.js';
import { fakeDaemon } from './support/fake-daemon.ts';
import { startGateway } from './support/harness.ts';
import { teardown } from '../../../test/support/teardown.ts';
import type { TestContext } from 'node:test';

// `any`: daemon answers, events and fixtures are JSON of every shape; the tests read their fields.
type Json = any;

/** The host pages' owner methods, and a valid request of each. */
const HOST: Record<string, Json> = {
  'host.provider.add': { id: 'echo-agent', command: '/usr/bin/true', args: ['--acp'], env: { TOKEN: 's3cret' }, label: 'Echo', description: 'test', models: ['m1'] },
  'host.provider.test': { name: 'echo-agent' },
  'host.provider.diagnose': {},
  'host.terminal.status': {},
  'host.terminal.set': { allow: true, confirm: true },
  'host.usage.setting.get': {},
  'host.usage.setting.set': { enabled: false },
  'host.registry': {},
  'host.workspace.update': { workspaceId: 'wks_1', archived: true, ifRevision: 3, requestId: 'r1' },
  'host.workspace.label': { action: 'assign', workspaceId: 'wks_1', name: 'Client', color: 'sky', ifRevision: 3, requestId: 'r2' },
  'host.project.register': { directory: '/tmp/x', ifRevision: 3, requestId: 'r3' },
  'host.project.remove': { projectId: 'prj_1', ifRevision: 3, requestId: 'r4' },
  'host.workspace.facts': { workspaceIds: ['wks_1', 'wks_2'], refresh: true },
  'host.workspace.reveal': { workspaceId: 'wks_1' },
  'host.workspace.editors': {},
  'host.workspace.open': { workspaceId: 'wks_1', editor: 'vscode' },
};
const METHODS = Object.keys(HOST);

const notExposed = (method: Json) => (error: Json) => error.code === -32601 && error.message === `${method} is not available through the gateway` && error.data?.reason === 'not_exposed';

/** A gateway (owner or not) whose host handlers record what reached them. */
async function world(t: TestContext, { owner = true, registered = METHODS } = {}) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-owner-host-'));
  defer(() => rm(directory, { recursive: true, force: true }));
  const daemon = fakeDaemon();
  const reached: Array<{ method: string, params: Record<string, unknown> }> = [];
  const handlers = Object.fromEntries(registered.map(method => [method, async ({ params, daemon: upstream }: Json) => {
    reached.push({ method, params });
    // A handler may call alpd on the owner's own connection.
    if (method === 'host.registry') return upstream.request('registry.owner', {});
    return { ok: method };
  }]));
  daemon.state.handlers['registry.owner'] = () => ({ registry: { revision: 7, projects: [], workspaces: [], sessions: {}, labels: { catalog: [] } } });
  const current = { id: undefined as string | undefined };
  const gw = await startGateway(t, {
    daemon,
    config: { limits: { rate: 100_000, burst: 100_000 } },
    credentials: { owner: { workspaces: [path.join(directory, 'a')] }, other: { workspaces: [path.join(directory, 'a')] } },
    ...(owner ? { owner: (ids: Json) => { current.id = ids.owner; return { credentialId: () => current.id, methods: handlers }; } } : {}),
  });
  return { daemon, reached, ...gw };
}

test('owner host: every host page method is an owner entry with a handler, its params listed and no credential permission', () => {
  for (const method of METHODS) {
    const entry = EXPOSURE[method];
    assert.ok(entry, method);
    assert.equal(entry.status, 'owner', method);
    assert.equal(entry.handler, true, method);
    assert.equal(entry.permission, undefined, method);
    assert.ok(Array.isArray(entry.params), method);
    assert.ok(entry.tests!.includes('owner'), method);
    for (const key of Object.keys(HOST[method])) assert.ok(entry.params.includes(key), `${method} lists ${key}`);
  }
  // Remote credentials keep today's workspace.update: no labels, no placement.
  assert.equal(EXPOSURE['workspace.update'].status, 'exposed');
  assert.ok(!EXPOSURE['workspace.update'].params!.includes('labels'));
  assert.equal(EXPOSURE['registry.owner'].status, 'prohibited');
});

test('owner host: a standalone gateway (no owner option) refuses every host method as a denied one; nothing reaches alpd', async t => {
  const { daemon, sdk, reached } = await world(t, { owner: false });
  const { client } = await sdk('owner');
  const mark = daemon.calls().length;
  for (const method of METHODS) await assert.rejects(client.request(method, HOST[method]), notExposed(method), method);
  assert.deepEqual(daemon.calls().slice(mark), []);
  assert.deepEqual(reached, []);
});

test('owner host: another credential of the owner gateway is refused as a denied method; nothing reaches the handler or alpd', async t => {
  const { daemon, sdk, reached } = await world(t);
  const { client, hello } = await sdk('other');
  assert.ok(!hello.capabilities.includes(CAPABILITY.hostOwner));
  const mark = daemon.calls().length;
  for (const method of METHODS) await assert.rejects(client.request(method, HOST[method]), notExposed(method), method);
  assert.deepEqual(daemon.calls().slice(mark), []);
  assert.deepEqual(reached, []);
});

test('owner host: on an owner gateway without the handler registered, the owner is refused as a denied method; nothing is forwarded to alpd', async t => {
  // The dashboard registers only some handlers: a handler: true method without one is never sent to alpd under its name.
  const { daemon, sdk, reached } = await world(t, { registered: ['host.terminal.status'] });
  const { client, hello } = await sdk('owner');
  assert.ok(hello.capabilities.includes(CAPABILITY.hostOwner));
  const mark = daemon.calls().length;
  for (const method of METHODS.filter(method => method !== 'host.terminal.status')) await assert.rejects(client.request(method, HOST[method]), notExposed(method), method);
  assert.deepEqual(daemon.calls().slice(mark), []);
  assert.deepEqual(reached, []);
  // The one that is registered answers.
  assert.deepEqual(await client.request('host.terminal.status', {}), { ok: 'host.terminal.status' });
});

test('owner host: a forwarded owner connection is refused too', async t => {
  const { daemon, sdk, reached } = await world(t);
  const { client } = await sdk('owner', { headers: { 'x-forwarded-for': '203.0.113.9' } });
  const mark = daemon.calls().length;
  for (const method of METHODS) await assert.rejects(client.request(method, HOST[method]), notExposed(method), method);
  assert.deepEqual(daemon.calls().slice(mark), []);
  assert.deepEqual(reached, []);
});

test('owner host: the owner reaches each handler with only the listed params; no host method is forwarded to alpd under its own name', async t => {
  const { daemon, sdk, reached } = await world(t);
  const { client, hello } = await sdk('owner');
  assert.ok(hello.capabilities.includes(CAPABILITY.hostOwner));
  const mark = daemon.calls().length;
  for (const method of METHODS) {
    const answer = await client.request(method, { ...HOST[method], extra: 'dropped' });
    if (method === 'host.registry') assert.equal(answer.registry.revision, 7);
    else assert.deepEqual(answer, { ok: method });
  }
  assert.deepEqual(reached.map(entry => entry.method), METHODS);
  for (const entry of reached) assert.deepEqual(entry.params, HOST[entry.method], entry.method);
  // Only what a handler asked for reached alpd.
  assert.deepEqual(daemon.calls().slice(mark).map(call => call.method), ['registry.owner']);
});
