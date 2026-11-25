// The sidebar's Schedules (t-ff83): schedule.list and schedule.get are `owner` entries forwarded to
// alpd with only their listed params, for the host owner's own dashboard. Every other connection
// (another credential, a standalone gateway, a forwarded owner socket) gets exactly a denied
// method's refusal and nothing reaches alpd. schedule.create and schedule.cancel stay prohibited:
// refused even for the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXPOSURE } from '../dist/index.js';
import { fakeDaemon } from './support/fake-daemon.js';
import { startGateway } from './support/harness.js';
import { teardown } from '../../../test/support/teardown.js';

const JOB = { id: 'sch_0123456789abcdef', projectRoot: '/work/project', sessionId: 'ses_0123456789abcdef', prompt: 'Check the provider quota and continue.', dueAt: '2026-10-20T10:00:00.000Z', status: 'pending', attempts: 0, createdAt: '2026-10-20T09:59:00.000Z', updatedAt: '2026-10-20T09:59:00.000Z' };
const READS = {
  'schedule.list': { projectRoot: '/work/project', status: 'pending' },
  'schedule.get': { id: JOB.id, projectRoot: '/work/project' },
};
const WRITES = {
  'schedule.create': { projectRoot: '/work/project', sessionId: JOB.sessionId, dueAt: JOB.dueAt, prompt: 'x' },
  'schedule.cancel': { id: JOB.id, projectRoot: '/work/project' },
};

const notExposed = method => error => error.code === -32601 && error.message === `${method} is not available through the gateway` && error.data?.reason === 'not_exposed';

async function world(t, { owner = true } = {}) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-owner-schedule-'));
  defer(() => rm(directory, { recursive: true, force: true }));
  const daemon = fakeDaemon();
  daemon.state.handlers['schedule.list'] = () => ({ jobs: [JOB] });
  daemon.state.handlers['schedule.get'] = () => ({ job: JOB });
  daemon.state.handlers['schedule.create'] = () => ({ job: JOB });
  daemon.state.handlers['schedule.cancel'] = () => ({ job: { ...JOB, status: 'cancelled' } });
  const current = { id: /** @type {string | undefined} */ (undefined) };
  const gw = await startGateway(t, {
    daemon,
    config: { limits: { rate: 100_000, burst: 100_000 } },
    credentials: { owner: { workspaces: [path.join(directory, 'a')] }, other: { workspaces: [path.join(directory, 'a')] } },
    ...(owner ? { owner: ids => { current.id = ids.owner; return { credentialId: () => current.id, methods: {} }; } } : {}),
  });
  return { daemon, ...gw };
}

test('owner schedule: list and get are owner reads forwarded to alpd; create and cancel stay prohibited', () => {
  for (const method of Object.keys(READS)) {
    const entry = EXPOSURE[method];
    assert.equal(entry.status, 'owner', method);
    assert.equal(entry.handler, undefined, method);
    assert.equal(entry.permission, undefined, method);
    assert.ok(entry.tests.includes('owner') && entry.tests.includes('owner-schedule'), method);
    assert.deepEqual([...entry.params].sort(), Object.keys(READS[method]).sort(), method);
  }
  for (const method of Object.keys(WRITES)) assert.equal(EXPOSURE[method].status, 'prohibited', method);
});

test('owner schedule: the owner gets the jobs from alpd, with only the listed params', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('owner');
  const mark = daemon.calls().length;
  assert.deepEqual(await client.request('schedule.list', { ...READS['schedule.list'], extra: 'dropped' }), { jobs: [JOB] });
  assert.deepEqual(await client.request('schedule.get', { ...READS['schedule.get'], extra: 'dropped' }), { job: JOB });
  assert.deepEqual(daemon.calls().slice(mark).map(call => [call.method, call.params]), [['schedule.list', READS['schedule.list']], ['schedule.get', READS['schedule.get']]]);
  // Params are checked against the v1 schema first.
  await assert.rejects(client.request('schedule.list', { projectRoot: '/work/project', status: 'nope' }), error => error.code === -32602);
  await assert.rejects(client.request('schedule.get', { projectRoot: '/work/project' }), error => error.code === -32602);
  assert.equal(daemon.calls().length, mark + 2);
});

test('owner schedule: create and cancel are refused even for the owner; nothing reaches alpd', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('owner');
  const mark = daemon.calls().length;
  for (const [method, params] of Object.entries(WRITES)) await assert.rejects(client.request(method, params), notExposed(method), method);
  assert.deepEqual(daemon.calls().slice(mark), []);
});

test('owner schedule: another credential, a standalone gateway and a forwarded owner socket get not_exposed for every schedule method; nothing reaches alpd', async t => {
  for (const [owner, name, headers] of [[true, 'other', {}], [false, 'owner', {}], [true, 'owner', { 'x-forwarded-for': '203.0.113.9' }]]) {
    const { daemon, sdk } = await world(t, { owner });
    const { client } = await sdk(name, { headers });
    const mark = daemon.calls().length;
    for (const [method, params] of Object.entries({ ...READS, ...WRITES })) await assert.rejects(client.request(method, params), notExposed(method), `${method} (${name}, owner gateway ${owner})`);
    assert.deepEqual(daemon.calls().slice(mark), []);
  }
});
