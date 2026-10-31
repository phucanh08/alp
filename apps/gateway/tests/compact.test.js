// session.compact through the gateway (t-de1a): session.write, a root in the grant looked up afresh and
// driven within the grant's modes (as session.prompt: the checkpoint turn drives the session); only the
// status passes back, and alpd's errors leave as fixed text. alpd's own behaviour (checkpoint, native
// compaction, fallback) is tested in packages/runtime/tests/compact.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXPOSURE } from '../src/policy.js';
import { fakeDaemon, summary } from './support/fake-daemon.js';
import { startGateway } from './support/harness.js';

async function world(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-compact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [a, b] = ['a', 'b'].map(name => path.join(directory, name));
  for (const dir of [a, b]) await mkdir(dir, { recursive: true });
  const [ca, cb] = await Promise.all([a, b].map(dir => realpath(dir)));
  const daemon = fakeDaemon({ sessions: [summary('sa', ca), summary('sa-c', ca, { parentId: 'sa' }), summary('sb', cb)] });
  daemon.state.handlers['session.compact'] = () => {
    if (daemon.state.compactError) throw daemon.state.compactError;
    return daemon.state.compactAnswer ?? { status: 'started' };
  };
  const gw = await startGateway(t, { daemon, credentials: {
    writer: { workspaces: [a], permissions: ['session.read', 'session.write'] },
    reader: { workspaces: [a], permissions: ['session.read'] },
    limited: { workspaces: [a], permissions: ['session.read', 'session.write'], modes: ['read-only'] },
    fitting: { workspaces: [a], permissions: ['session.read', 'session.write'], modes: ['workspace-write'] },
    agent: { workspaces: [a], permissions: ['session.read', 'session.write'], agent: true },
  } });
  return { daemon, ...gw };
}

const calls = (daemon, mark) => daemon.calls().slice(mark).filter(call => call.method === 'session.compact');

test('the matrix: session.compact is exposed with session.write, mode-checked, sessionId only', () => {
  const entry = EXPOSURE['session.compact'];
  assert.equal(entry.status, 'exposed');
  assert.equal(entry.permission, 'session.write');
  assert.equal(entry.alsoRequires, undefined);
  assert.deepEqual(entry.params, ['sessionId']);
  for (const kind of ['permission', 'session-scope', 'mode', 'result-filter']) assert.ok(entry.tests.includes(kind), kind);
});

test('compact: permission, scope, a child, extra params and the grant\'s modes are refused before alpd hears of it', async t => {
  const { daemon, sdk } = await world(t);
  const { client: reader } = await sdk('reader');
  const { client: writer } = await sdk('writer');
  const { client: limited } = await sdk('limited');
  const mark = daemon.calls().length;
  await assert.rejects(reader.request('session.compact', { sessionId: 'sa' }), error => error.code === 1003 && error.data?.reason === 'grant' && error.data.permission === 'session.write');
  await assert.rejects(writer.request('session.compact', { sessionId: 'sb' }), error => error.code === 1001);
  await assert.rejects(writer.request('session.compact', { sessionId: 'sa-c' }), error => error.code === 1003 && error.data?.reason === 'not_root' && /root/.test(error.message));
  await assert.rejects(writer.request('session.compact', { sessionId: 'sa', threshold: 0.1 }), error => error.code === -32602);
  await assert.rejects(limited.request('session.compact', { sessionId: 'sa' }), error => error.code === 1003 && error.data?.reason === 'mode');
  assert.deepEqual(calls(daemon, mark), [], 'alpd never heard of a refused compaction');
  const { client: fitting } = await sdk('fitting');
  assert.deepEqual(await fitting.request('session.compact', { sessionId: 'sa' }), { status: 'started' });
});

test('compact: only sessionId reaches alpd; only the status passes back; alpd\'s errors leave as fixed text', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('writer');
  for (const status of ['started', 'deferred', 'running']) {
    daemon.state.compactAnswer = { status, path: '/Users/u/.alp' };
    assert.deepEqual(await client.request('session.compact', { sessionId: 'sa' }), { status });
  }
  assert.deepEqual(Object.keys(calls(daemon, 0).at(-1).params), ['sessionId']);
  daemon.state.compactAnswer = { status: 'done' };
  await assert.rejects(client.request('session.compact', { sessionId: 'sa' }), error => error.code === 1000);
  daemon.state.compactAnswer = undefined;
  daemon.state.compactError = { code: 1005, message: 'The session is not open at /Users/u/.alp', data: { reason: 'session_busy', path: '/Users/u' } };
  const error = await client.request('session.compact', { sessionId: 'sa' }).catch(failure => failure);
  assert.equal(error.code, 1005);
  assert.deepEqual(error.data, { reason: 'session_busy' });
  assert.ok(!error.message.includes('/Users'), error.message);
  assert.match(error.message, /not open/);
});

test('compact: an agent-marked credential is refused as user-only and never reaches alpd', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('agent');
  const error = await client.request('session.compact', { sessionId: 'sa' }).catch(failure => failure);
  assert.equal(error.data?.reason, 'user_only');
  assert.ok(!daemon.calls().some(call => call.method === 'session.compact'), 'alpd was not asked to compact');
});
