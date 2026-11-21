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
import WebSocket from 'ws';
import { AGENT_CAPABILITY, AlpRpcClient } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';
import { ORIGIN, startGateway } from './support/harness.js';
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
  return { daemon, ran, directory, ...gw };
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

test('owner-library: in a granted workspace with no .alp (not_alp_project), only the owner reads the library there; other credentials keep the refusal (t-a95b.1 F1)', async t => {
  const { daemon, sdk, directory, ticket, tokens, wsUrl } = await world(t);
  const notProject = { code: 1001, message: 'not an ALP project; run alp init there', data: { reason: 'not_alp_project' } };
  // alpd as it answers a plain directory: every library read with a projectRoot is refused; without
  // one it answers the library and built-in layers. A request with projectRoot never answers rows.
  const refuseWithRoot = answer => params => { if (params.projectRoot !== undefined) throw notProject; return answer(params); };
  daemon.state.handlers['library.list'] = refuseWithRoot(() => ({ projectRoot: null, entries: [{ name: 'notify', source: 'library', description: 'd' }] }));
  daemon.state.handlers['library.get'] = refuseWithRoot(params => ({ kind: params.kind, name: params.name, source: 'library', content: { event: 'handoff' }, revision: 'r1', usedBy: [] }));
  daemon.state.handlers['team.list'] = refuseWithRoot(() => ({ projectRoot: null, teams: [{ id: 'default', name: 'Default' }] }));
  const root = path.join(directory, 'a');
  const READS = {
    'library.list': { kind: 'hooks', projectRoot: root },
    'library.get': { kind: 'hooks', name: 'notify', projectRoot: root },
    'team.list': { projectRoot: root },
  };
  const isNotProject = error => error.code === 1001 && error.data?.reason === 'not_alp_project';

  // Not the owner, with project.read and library.write, or project.read only: alpd's refusal, asked once.
  for (const name of ['other', 'plain']) {
    const { client } = await sdk(name);
    for (const [method, params] of Object.entries(READS)) {
      const mark = daemon.calls(method).length;
      await assert.rejects(client.request(method, params), isNotProject, `${name} ${method}`);
      assert.deepEqual(daemon.calls(method).slice(mark).map(call => call.params.projectRoot), [root], `${name} ${method}: never asked without projectRoot`);
    }
  }

  // The owner's credential on a connection marked as an ALP agent's is not the owner: refused once.
  const { body } = await ticket(tokens.owner);
  const transport = await connectWebSocket(wsUrl, { protocols: body.subprotocols, createSocket: (url, protocols) => new WebSocket(url, protocols, { origin: ORIGIN }) });
  const agent = new AlpRpcClient(transport);
  teardown(t)(() => agent.close());
  await agent.request('daemon.hello', { protocolVersion: 1, client: { name: 'agent', version: '0' }, capabilities: [AGENT_CAPABILITY] });
  for (const [method, params] of Object.entries(READS)) {
    const mark = daemon.calls(method).length;
    await assert.rejects(agent.request(method, params), isNotProject, `agent ${method}`);
    assert.deepEqual(daemon.calls(method).slice(mark).map(call => call.params.projectRoot), [root], `agent ${method}: never asked without projectRoot`);
  }

  // The owner: asked again without projectRoot, and gets the library rows.
  const { client } = await sdk('owner');
  const mark = { list: daemon.calls('library.list').length, get: daemon.calls('library.get').length, team: daemon.calls('team.list').length };
  assert.deepEqual((await client.request('library.list', READS['library.list'])).entries.map(entry => entry.name), ['notify']);
  assert.equal((await client.request('library.get', READS['library.get'])).source, 'library');
  assert.deepEqual((await client.request('team.list', READS['team.list'])).teams.map(team => team.id), ['default']);
  assert.deepEqual(daemon.calls('library.list').slice(mark.list).map(call => call.params.projectRoot), [root, undefined]);
  assert.deepEqual(daemon.calls('library.get').slice(mark.get).map(call => call.params.projectRoot), [root, undefined]);
  assert.deepEqual(daemon.calls('team.list').slice(mark.team).map(call => call.params.projectRoot), [root, undefined]);
  // Scope project is never asked again, even for the owner.
  const before = daemon.calls('library.get').length;
  await assert.rejects(client.request('library.get', { ...READS['library.get'], scope: 'project' }), isNotProject);
  assert.equal(daemon.calls('library.get').length - before, 1);
  // Any other refusal is not asked again either.
  daemon.state.handlers['library.list'] = () => { throw { code: 1001, message: 'gone', data: { reason: 'not_found' } }; };
  const other = daemon.calls('library.list').length;
  await assert.rejects(client.request('library.list', READS['library.list']), error => error.code === 1001 && error.data?.reason === 'not_found');
  assert.equal(daemon.calls('library.list').length - other, 1);
});
