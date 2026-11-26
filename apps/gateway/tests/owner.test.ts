// The host owner (t-a95b; owner.ts, docs/alp/remote-gateway.md §5.19): the methods the exposure
// matrix marks `owner` answer only the credential an owner gateway names, on a direct loopback
// socket, checked again on every request. Every other connection, and every connection of a gateway
// without the owner option (standalone alp-gateway), gets exactly a denied method's refusal, and
// nothing reaches alpd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAPABILITY } from '@anhlp/alp-protocol';
import { EXPOSURE, FORWARDING_HEADERS, OWNER_LOOPBACK, createGateway, createGatewayLogger, CredentialStore, credentialsFile, directLoopback, isForwardingHeader, ownerOptionError, resolveConfig, revokeCredential } from '../dist/index.js';
import { fakeDaemon } from './support/fake-daemon.ts';
import WebSocket from 'ws';
import { AGENT_CAPABILITY, AlpRpcClient } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';
import { ORIGIN, startGateway } from './support/harness.ts';
import { teardown } from '../../../test/support/teardown.ts';
import type { TestContext } from 'node:test';

// `any`: daemon answers, events and fixtures are JSON of every shape; the tests read their fields.
type Json = any;

const OWNER_METHODS = Object.entries(EXPOSURE).filter(([, entry]) => entry.status === 'owner').map(([method]) => method);
const USAGE = { providers: [{ provider: 'claude', windows: [] }] };

/** What a denied method answers today: the refusal every non-owner gets for an owner method. */
const notExposed = (method: Json) => (error: Json) => error.code === -32601 && error.message === `${method} is not available through the gateway` && error.data?.reason === 'not_exposed';

/**
 * A gateway in front of a fake alpd that answers daemon.usage. With `owner`, the gateway is created
 * with the owner option naming credential `owner` (as alp dashboard names grant.id); `current` lets
 * a test change which credential that is, as `alp dashboard rotate` does.
 */
async function world(t: TestContext, { owner = true, handlers }: Json = {}) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-owner-'));
  defer(() => rm(directory, { recursive: true, force: true }));
  const daemon = fakeDaemon();
  daemon.state.handlers['daemon.usage'] = () => USAGE;
  const current = { id: undefined as string | undefined };
  const gw = await startGateway(t, {
    daemon,
    config: { limits: { rate: 100_000, burst: 100_000 } },
    credentials: { owner: { workspaces: [path.join(directory, 'a')] }, other: { workspaces: [path.join(directory, 'a')] } },
    ...(owner ? { owner: (ids: Json) => { current.id = ids.owner; return { credentialId: () => current.id, ...(handlers ? { methods: handlers } : {}) }; } } : {}),
  });
  return { daemon, current, ...gw };
}

test('owner: every owner method names its tests and needs no credential permission', () => {
  assert.ok(OWNER_METHODS.includes('daemon.usage'), 'daemon.usage is the example owner method');
  for (const method of OWNER_METHODS) {
    assert.ok(EXPOSURE[method].tests?.includes('owner'), method);
    assert.equal(EXPOSURE[method].permission, undefined, method);
  }
});

test('owner (a): without the owner option (standalone alp-gateway) every owner method answers as a denied one and never reaches alpd', async t => {
  const { daemon, sdk } = await world(t, { owner: false });
  const { client, hello } = await sdk('owner');
  assert.ok(!hello.capabilities.includes(CAPABILITY.hostOwner), 'no host.owner in hello');
  const mark = daemon.calls().length;
  // The baseline: a method that was and stays denied.
  await assert.rejects(client.request('daemon.status', {}), notExposed('daemon.status'));
  for (const method of OWNER_METHODS) await assert.rejects(client.request(method, {}), notExposed(method), method);
  assert.deepEqual(daemon.calls().slice(mark), [], 'nothing reached alpd');
});

test('owner (b, f): the owner credential on a direct loopback socket gets host.owner in hello and daemon.usage from alpd, with only its params', async t => {
  const { daemon, sdk } = await world(t);
  const { client, hello } = await sdk('owner');
  assert.ok(hello.capabilities.includes(CAPABILITY.hostOwner), 'hello reports the owner');
  const mark = daemon.calls().length;
  assert.deepEqual(await client.request('daemon.usage', { refresh: true, extra: 'dropped' }), USAGE);
  assert.deepEqual(daemon.calls().slice(mark).map(call => [call.method, call.params]), [['daemon.usage', { refresh: true }]]);
  // The account email is opt-in at alpd (t-9116): the gateway never forwards `account`, so no
  // gateway caller can ask alpd for it; only alp dashboard's own owner handler adds it.
  const before = daemon.calls().length;
  await client.request('daemon.usage', { account: true });
  assert.deepEqual(daemon.calls().slice(before).map(call => call.params), [{}]);
  // Still a denied method for the owner: only `owner` entries open.
  await assert.rejects(client.request('daemon.status', {}), notExposed('daemon.status'));
  // Params are checked as for any v1 method.
  await assert.rejects(client.request('daemon.usage', { refresh: 'yes' }), (error: Json) => error.code === -32602);
});

test('owner (c, f): another credential of the same owner gateway is refused, and its hello has no host.owner', async t => {
  const { daemon, sdk } = await world(t);
  const { client, hello } = await sdk('other');
  assert.ok(!hello.capabilities.includes(CAPABILITY.hostOwner));
  const mark = daemon.calls().length;
  for (const method of OWNER_METHODS) await assert.rejects(client.request(method, {}), notExposed(method), method);
  assert.deepEqual(daemon.calls().slice(mark), []);
});

test('owner (d): once owner.credentialId() names another credential (rotate), the old one is refused on its open connection', async t => {
  const { daemon, sdk, current, ids } = await world(t);
  const { client } = await sdk('owner');
  assert.deepEqual(await client.request('daemon.usage', {}), USAGE);
  // `alp dashboard rotate` makes a new credential the owner; the gateway reads credentialId() per request.
  current.id = ids.other;
  const mark = daemon.calls().length;
  await assert.rejects(client.request('daemon.usage', {}), notExposed('daemon.usage'));
  assert.deepEqual(daemon.calls().slice(mark), []);
  // And the new owner is the owner from its first request.
  const { client: rotated, hello } = await sdk('other');
  assert.ok(hello.capabilities.includes(CAPABILITY.hostOwner));
  assert.deepEqual(await rotated.request('daemon.usage', {}), USAGE);
  // With no owner credential at all (credentialId() undefined), nobody is the owner.
  current.id = undefined;
  await assert.rejects(rotated.request('daemon.usage', {}), notExposed('daemon.usage'));
});

test('owner (d): a revoked owner credential loses its connection and cannot get a ticket', async t => {
  const { sdk, ticket, tokens, ids, home } = await world(t);
  const { client } = await sdk('owner');
  const closed = new Promise(resolve => client.onClose(resolve));
  await revokeCredential(home, ids.owner);
  await closed;
  await assert.rejects(client.request('daemon.usage', {}));
  for (let attempt = 0; attempt < 100 && (await ticket(tokens.owner)).status !== 401; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await ticket(tokens.owner)).status, 401);
});

test('owner (e): the owner credential through a forwarding hop (a proxy or tunnel on this machine) is not the owner', async t => {
  // The test client reaches the gateway from 127.0.0.1, as a reverse proxy, tunnel or relay agent on
  // this machine would; the forwarding header it adds is what makes it not the owner. Each header of
  // FORWARDING_HEADERS is tried on its own.
  const { daemon, sdk } = await world(t);
  for (const header of FORWARDING_HEADERS) {
    const { client, hello } = await sdk('owner', { headers: { [header]: '203.0.113.9' } });
    assert.ok(!hello.capabilities.includes(CAPABILITY.hostOwner), header);
    const mark = daemon.calls().length;
    await assert.rejects(client.request('daemon.usage', {}), notExposed('daemon.usage'), header);
    assert.deepEqual(daemon.calls().slice(mark), [], header);
    client.close();
  }
});

test('owner (e): only a direct loopback peer counts; a non-loopback, proxied or forwarded one never does', () => {
  // directLoopback reads the socket's own peer address, which a client cannot set: these requests
  // stand in for sockets from the network (remoteAddress) and for server.ts peerOf's verdict.
  const request = (remoteAddress: Json, headers = {}) => ({ socket: { remoteAddress }, headers });
  for (const address of OWNER_LOOPBACK) assert.equal(directLoopback(request(address), { proxied: false }), true, address);
  for (const address of ['192.168.1.5', '10.0.0.2', '203.0.113.9', '::ffff:192.168.1.5', 'fe80::1', '127.0.0.2', '127.1.2.3', '', undefined]) {
    assert.equal(directLoopback(request(address), { proxied: false }), false, String(address));
  }
  assert.equal(directLoopback(request('127.0.0.1'), { proxied: true }), false, 'through a trusted proxy');
  for (const header of FORWARDING_HEADERS) assert.equal(directLoopback(request('127.0.0.1', { [header]: 'x' }), { proxied: false }), false, header);
  // A proxy's own variants of the forwarding headers count too (prefix/suffix families, isForwardingHeader).
  for (const header of ['x-forwarded-server', 'x-original-forwarded-for', 'x-cluster-client-ip', 'fastly-client-ip', 'forwarded-for', 'x-real-port', 'x-original-host']) {
    assert.equal(isForwardingHeader(header), true, header);
    assert.equal(directLoopback(request('127.0.0.1', { [header]: 'x' }), { proxied: false }), false, header);
  }
  for (const header of ['host', 'origin', 'sec-websocket-protocol', 'user-agent', 'cookie']) assert.equal(isForwardingHeader(header), false, header);
  assert.equal(directLoopback(request('127.0.0.1', { host: '127.0.0.1:7433', origin: 'http://127.0.0.1:7433' }), { proxied: false }), true, 'ordinary browser headers');
});

test('owner: an owner gateway is a plain loopback listener; any other config is refused at creation', async t => {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-owner-config-'));
  defer(() => rm(directory, { recursive: true, force: true }));
  const owner = { credentialId: () => 'c' };
  assert.equal(ownerOptionError(owner, resolveConfig({ port: 0 })), undefined);
  assert.match(ownerOptionError(owner, resolveConfig({ port: 0, trustProxy: ['127.0.0.1'] })) ?? '', /trusts no proxy/);
  assert.match(ownerOptionError(owner, resolveConfig({ host: '0.0.0.0', port: 0, allowInsecure: true })) ?? '', /loopback only/);
  assert.match(ownerOptionError(owner, resolveConfig({ port: 0, allowInsecure: true })) ?? '', /insecure/);
  assert.match(ownerOptionError(({ credentialId: 'c' } as Json), resolveConfig({ port: 0 })) ?? '', /function/);
  assert.match(ownerOptionError(({ credentialId: () => 'c', methods: { x: 1 } } as Json), resolveConfig({ port: 0 })) ?? '', /not a function/);
  const store = new CredentialStore({ home: path.join(directory, 'gateway'), logger: createGatewayLogger({ write: () => {} }) });
  defer(() => store.close());
  assert.throws(() => createGateway({ config: resolveConfig({ port: 0, trustProxy: ['127.0.0.1'] }), store, logger: createGatewayLogger({ write: () => {} }), version: 'test', openTransport: fakeDaemon().open, owner }), /trusts no proxy/);
});

test('owner: an owner handler answers its method for the owner only, with its params and the owner\'s alpd connection', async t => {
  const seen: Json[] = [];
  const handlers = {
    // A handler for a method the matrix does not mark owner is never reachable.
    'daemon.status': () => 'never',
    'daemon.usage': async ({ method, params, principal, daemon }: Json) => {
      seen.push({ method, params, principal });
      const answer = await daemon.request('daemon.usage', { refresh: false }) as Json;
      return { providers: [...answer.providers, { provider: 'handled' }] };
    },
  };
  const { daemon, sdk, ids } = await world(t, { handlers });
  const { client } = await sdk('owner');
  assert.deepEqual(await client.request('daemon.usage', { refresh: true, extra: 1 }), { providers: [...USAGE.providers, { provider: 'handled' }] });
  assert.deepEqual(seen, [{ method: 'daemon.usage', params: { refresh: true }, principal: ids.owner }]);
  assert.deepEqual(daemon.calls('daemon.usage').map(call => call.params), [{ refresh: false }]);
  await assert.rejects(client.request('daemon.status', {}), notExposed('daemon.status'));
  const { client: other } = await sdk('other');
  await assert.rejects(other.request('daemon.usage', {}), notExposed('daemon.usage'));
  assert.equal(seen.length, 1, 'the handler never ran for another credential');
});

test('owner: a connection marked as an ALP agent\'s is never the owner, even with the owner credential', async t => {
  const { ticket, tokens, wsUrl } = await world(t);
  const { body } = await ticket(tokens.owner);
  const transport = await connectWebSocket(wsUrl, { protocols: body.subprotocols, createSocket: (url, protocols) => new WebSocket(url, protocols, { origin: ORIGIN }) });
  const client = new AlpRpcClient(transport);
  teardown(t)(() => client.close());
  const hello = (await client.request('daemon.hello', { protocolVersion: 1, client: { name: 'agent', version: '0' }, capabilities: [AGENT_CAPABILITY] }) as Json);
  assert.ok(!hello.capabilities.includes(CAPABILITY.hostOwner));
  await assert.rejects(client.request('daemon.usage', {}), notExposed('daemon.usage'));
});

test('owner: no credential permission makes a credential the owner, even one added by hand to credentials.json', async t => {
  const { daemon, sdk, store, home, ids } = await world(t);
  // Hand-edit the other credential (as a user or tool might), with every name an owner could be
  // mistaken for: the store drops what is not a permission when it reads the file.
  const file = credentialsFile(home);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const entry = stored.credentials.find((credential: Json) => credential.id === ids.other);
  assert.ok(entry, 'the other credential is in the file');
  entry.permissions = [...entry.permissions, 'host.owner', 'owner', 'host.admin', 'daemon.usage'];
  await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
  await store.reload();
  assert.deepEqual([...store.grant(ids.other)!.permissions].filter(name => /owner|admin|usage/.test(name)), []);
  const { client, hello } = await sdk('other');
  assert.ok(!hello.capabilities.includes(CAPABILITY.hostOwner));
  const mark = daemon.calls().length;
  await assert.rejects(client.request('daemon.usage', {}), notExposed('daemon.usage'));
  assert.deepEqual(daemon.calls().slice(mark), []);
});
