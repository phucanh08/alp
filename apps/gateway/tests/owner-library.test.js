// The host owner's library, file and language methods (t-a95b group C; policy.js "owner: library"
// block, docs/alp/remote-gateway.md §5.4 and §5.19). Each answers only the credential an owner
// gateway names, on a direct loopback socket. A gateway without the owner option (standalone
// alp-gateway) and any other credential of an owner gateway get exactly a denied method's refusal
// (-32601 not_exposed): no handler runs and nothing reaches alpd. The handlers themselves are alp
// dashboard's (packages/cli/src/dashboard/owner/library.js, tested in packages/cli/tests); here they
// are stand-ins that record their calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXPOSURE } from '../src/index.js';
import { fakeDaemon } from './support/fake-daemon.js';
import { startGateway } from './support/harness.js';
import { teardown } from '../../../test/support/teardown.js';

const notExposed = method => error => error.code === -32601 && error.message === `${method} is not available through the gateway` && error.data?.reason === 'not_exposed';

/** One valid request per group C owner method, as the app sends it. */
const REQUESTS = {
  'host.library.get': { kind: 'mcp', name: 'search', scope: 'library' },
  'host.library.save': { kind: 'mcp', name: 'search', scope: 'library', content: { server: { command: 'npx', env: { TOKEN: { $secret: 'keep' } } } }, revision: 'r1' },
  'host.library.delete': { kind: 'hooks', name: 'notify', scope: 'library', revision: 'r1' },
  'host.library.test': { kind: 'hooks', name: 'notify' },
  'host.files.list': { projectRoot: '/w', path: 'src' },
  'host.files.read': { projectRoot: '/w', path: 'src/a.ts' },
  'host.files.write': { projectRoot: '/w', path: 'src/a.ts', content: 'x', baseSha256: 'a'.repeat(64) },
};
const HANDLED = Object.keys(REQUESTS);
const LANGUAGE = { language: 'English', applies: 'English', default: 'Vietnamese' };

async function world(t, { owner = true, without = [] } = {}) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-owner-library-'));
  defer(() => rm(directory, { recursive: true, force: true }));
  const daemon = fakeDaemon();
  daemon.state.handlers['catalog.refresh'] = () => ({ models: [], modes: [], fetchedAt: '2026-11-21T00:00:00.000Z', providers: [] });
  daemon.state.handlers['settings.language.set'] = params => ({ ...LANGUAGE, language: params.language, applies: params.language ?? 'Vietnamese' });
  const ran = [];
  const handlers = Object.fromEntries(HANDLED.filter(method => !without.includes(method)).map(method => [method, async context => {
    ran.push({ method, params: context.params });
    return { handled: method };
  }]));
  const current = { id: undefined };
  const gw = await startGateway(t, {
    daemon,
    config: { limits: { rate: 100_000, burst: 100_000 } },
    credentials: {
      owner: { workspaces: [path.join(directory, 'a')] },
      // Even a credential that holds every permission a library or file write could need is not the owner.
      other: { workspaces: [path.join(directory, 'a')], permissions: ['session.read', 'project.read', 'project.write', 'files.read', 'library.write', 'workspace.write'] },
      plain: { workspaces: [path.join(directory, 'a')], permissions: ['session.read', 'project.read'] },
    },
    ...(owner ? { owner: ids => { current.id = ids.owner; return { credentialId: () => current.id, methods: handlers }; } } : {}),
  });
  return { daemon, ran, ...gw };
}

test('owner-library: the group C entries are owner methods; the dashboard\'s are host.* handlers with listed params', () => {
  for (const method of HANDLED) {
    const entry = EXPOSURE[method];
    assert.equal(entry?.status, 'owner', method);
    assert.equal(entry.handler, true, method);
    assert.ok(entry.tests.includes('owner'), method);
    assert.equal(entry.permission, undefined, method);
    // Every key the app sends is listed, so it reaches the handler.
    assert.deepEqual(Object.keys(REQUESTS[method]).filter(key => !entry.params.includes(key)), [], method);
  }
  assert.equal(EXPOSURE['settings.language.set'].status, 'owner');
  assert.deepEqual(EXPOSURE['settings.language.set'].params, ['language']);
  assert.equal(EXPOSURE['settings.language.set'].handler, undefined, 'alpd answers it');
});

test('owner-library: without the owner option (standalone alp-gateway) each method is refused as a denied one, no handler runs and nothing reaches alpd', async t => {
  const { daemon, ran, sdk } = await world(t, { owner: false });
  const { client } = await sdk('owner');
  const mark = daemon.calls().length;
  for (const [method, params] of Object.entries({ ...REQUESTS, 'settings.language.set': { language: 'English' }, 'catalog.refresh': {} })) await assert.rejects(client.request(method, params), notExposed(method), method);
  assert.deepEqual(daemon.calls().slice(mark), []);
  assert.deepEqual(ran, []);
});

test('owner-library: another credential of an owner gateway (with files.read and library.write, or without) is refused, no handler runs and nothing reaches alpd', async t => {
  const { daemon, ran, sdk } = await world(t);
  for (const name of ['other', 'plain']) {
    const { client } = await sdk(name);
    const mark = daemon.calls().length;
    for (const [method, params] of Object.entries({ ...REQUESTS, 'settings.language.set': { language: 'English' }, 'catalog.refresh': {} })) await assert.rejects(client.request(method, params), notExposed(method), `${name}: ${method}`);
    assert.deepEqual(daemon.calls().slice(mark), [], name);
  }
  assert.deepEqual(ran, []);
});

test('owner-library: the owner gets each handler\'s answer with only the listed params, and settings.language.set from alpd', async t => {
  const { daemon, ran, sdk } = await world(t);
  const { client } = await sdk('owner');
  for (const [method, params] of Object.entries(REQUESTS)) {
    assert.deepEqual(await client.request(method, { ...params, unlisted: 'dropped' }), { handled: method }, method);
  }
  assert.deepEqual(ran.map(call => call.method), HANDLED);
  for (const call of ran) assert.deepEqual(call.params, REQUESTS[call.method], call.method);
  const mark = daemon.calls().length;
  assert.deepEqual(await client.request('settings.language.set', { language: 'English', extra: 1 }), LANGUAGE);
  assert.deepEqual(await client.request('settings.language.set', { language: null }), { ...LANGUAGE, language: null, applies: 'Vietnamese' });
  assert.deepEqual(daemon.calls().slice(mark).map(call => [call.method, call.params]), [['settings.language.set', { language: 'English' }], ['settings.language.set', { language: null }]]);
  // catalog.refresh (Overview's Refresh): alpd's own method, forwarded with no params for the owner only.
  const before = daemon.calls().length;
  assert.equal((await client.request('catalog.refresh', { force: true })).fetchedAt, '2026-11-21T00:00:00.000Z');
  assert.deepEqual(daemon.calls().slice(before).map(call => [call.method, call.params]), [['catalog.refresh', {}]]);
  // alpd's v1 schema still checks the language before alpd sees it.
  await assert.rejects(client.request('settings.language.set', { language: 'x'.repeat(41) }), error => error.code === -32602);
});

test('owner-library: on an owner gateway with no handler registered for a handler method, even the owner is refused and nothing reaches alpd', async t => {
  const { daemon, ran, sdk } = await world(t, { without: ['host.files.write', 'host.library.save'] });
  const { client } = await sdk('owner');
  const mark = daemon.calls().length;
  for (const method of ['host.files.write', 'host.library.save']) await assert.rejects(client.request(method, REQUESTS[method]), notExposed(method), method);
  assert.deepEqual(daemon.calls().slice(mark), [], 'never forwarded to alpd');
  assert.deepEqual(ran, []);
  // The methods that do have a handler still answer.
  assert.deepEqual(await client.request('host.files.read', REQUESTS['host.files.read']), { handled: 'host.files.read' });
});
