// session.reload and session.resumeCommand through the gateway (docs/protocol/alp-json-rpc-v1.md §12.8,
// docs/alp/remote-gateway.md §5.15, issue #121 branch G2): reload needs session.write, a root in the grant
// looked up afresh and the grant's modes (as session.prompt); resumeCommand needs session.read and is
// rebuilt by the gateway from the session id, so no path, env or native command passes. alpd's own
// behaviour (journal, idle barrier, native restart) is tested in packages/daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resumeCommandOf } from '@anhlp/alp-protocol';
import { EXPOSURE, FORWARDED_CAPABILITIES, projectConversation } from '../src/policy.js';
import { fakeDaemon, summary } from './support/fake-daemon.js';
import { startGateway } from './support/harness.js';

const CAPABILITIES = ['attach.after', 'prompt.receipts', 'session.history', 'session.fork', 'session.rewind', 'session.reload', 'session.resumeCommand'];
const GEN = '0123456789abcdef0123456789abcdef';
const CONVERSATION = { fork: true, rewind: true, reload: true };

async function world(t, { capabilities = CAPABILITIES } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-reload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [a, b] = ['a', 'b'].map(name => path.join(directory, name));
  for (const dir of [a, b]) await mkdir(dir, { recursive: true });
  const [ca, cb] = await Promise.all([a, b].map(dir => realpath(dir)));
  const daemon = fakeDaemon({
    capabilities,
    sessions: [summary('sa', ca, { conversation: CONVERSATION }), summary('sa-c', ca, { parentId: 'sa' }), summary('sb', cb, { conversation: CONVERSATION })],
  });
  daemon.state.handlers['session.reload'] = params => {
    if (daemon.state.reloadError) throw daemon.state.reloadError;
    return { session: daemon.state.reloadAnswer ?? daemon.state.sessions.get(params.sessionId) };
  };
  daemon.state.handlers['session.resumeCommand'] = params => daemon.state.resumeAnswer ?? resumeCommandOf(params.sessionId, 'posix');
  const gw = await startGateway(t, { daemon, credentials: {
    writer: { workspaces: [a], permissions: ['session.read', 'session.write'] },
    reader: { workspaces: [a], permissions: ['session.read'] },
    limited: { workspaces: [a], permissions: ['session.read', 'session.write'], modes: ['read-only'] },
    fitting: { workspaces: [a], permissions: ['session.read', 'session.write'], modes: ['workspace-write'] },
  } });
  return { daemon, a, b, ca, cb, ...gw };
}

const reload = (extra = {}) => ({ sessionId: 'sa', requestId: 'rl1', ifGeneration: GEN, ...extra });
const calls = (daemon, mark, method) => daemon.calls().slice(mark).filter(call => call.method === method);

test('the matrix: reload is session.write with modes, resumeCommand session.read; both forwarded; no client field reaches alpd', () => {
  assert.equal(EXPOSURE['session.reload'].status, 'exposed');
  assert.equal(EXPOSURE['session.reload'].permission, 'session.write');
  assert.equal(EXPOSURE['session.reload'].alsoRequires, undefined);
  assert.deepEqual(EXPOSURE['session.reload'].params, ['sessionId', 'requestId', 'ifGeneration']);
  assert.ok(EXPOSURE['session.reload'].tests.includes('mode'));
  assert.equal(EXPOSURE['session.resumeCommand'].permission, 'session.read');
  assert.deepEqual(EXPOSURE['session.resumeCommand'].params, ['sessionId']);
  assert.ok(FORWARDED_CAPABILITIES.includes('session.reload') && FORWARDED_CAPABILITIES.includes('session.resumeCommand'));
  assert.deepEqual(projectConversation({ fork: false, rewind: false, reload: true, reason: 'runtime_unsupported', path: '/x' }), { fork: false, rewind: false, reload: true, reason: 'runtime_unsupported' });
  assert.deepEqual(projectConversation({ fork: true, rewind: true, reload: 'yes' }), { fork: true, rewind: true });
});

test('hello forwards session.reload and session.resumeCommand only when alpd lists them; summaries keep conversation.reload', async t => {
  const listed = await world(t);
  const { client, hello } = await listed.sdk('writer');
  assert.ok(hello.capabilities.includes('session.reload') && hello.capabilities.includes('session.resumeCommand'));
  assert.deepEqual((await client.request('session.get', { sessionId: 'sa' })).session.conversation, CONVERSATION);
  const older = await world(t, { capabilities: ['attach.after', 'prompt.receipts'] });
  const plain = (await older.sdk('writer')).hello;
  assert.ok(!plain.capabilities.includes('session.reload') && !plain.capabilities.includes('session.resumeCommand'));
});

test('reload: permission, scope, a child and the grant\'s modes are refused before alpd hears of it', async t => {
  const { daemon, sdk } = await world(t);
  const { client: reader } = await sdk('reader');
  const { client: writer } = await sdk('writer');
  const { client: limited } = await sdk('limited');
  const mark = daemon.calls().length;
  await assert.rejects(reader.request('session.reload', reload()), error => error.code === 1003 && error.data?.reason === 'grant' && error.data.permission === 'session.write');
  await assert.rejects(writer.request('session.reload', reload({ sessionId: 'sb' })), error => error.code === 1001);
  await assert.rejects(writer.request('session.reload', reload({ sessionId: 'sa-c' })), error => error.code === 1003 && error.data?.reason === 'not_root');
  await assert.rejects(writer.request('session.reload', { ...reload(), threadId: 'other' }), error => error.code === -32602);
  await assert.rejects(writer.request('session.reload', { ...reload(), mode: 'full-access' }), error => error.code === -32602);
  // A grant limited to read-only may not drive a workspace-write root, as for session.prompt.
  await assert.rejects(limited.request('session.reload', reload()), error => error.code === 1003 && error.data?.reason === 'mode');
  assert.deepEqual(calls(daemon, mark, 'session.reload'), [], 'alpd never heard of a refused reload');
  const { client: fitting } = await sdk('fitting');
  assert.equal((await fitting.request('session.reload', reload({ requestId: 'fit' }))).session.id, 'sa');
});

test('reload: a per-credential requestId reaches alpd; the answer is projected; alpd\'s errors leave as fixed text', async t => {
  const { daemon, sdk, ca } = await world(t);
  const { client } = await sdk('writer');
  const answer = await client.request('session.reload', reload());
  const sent = calls(daemon, 0, 'session.reload').at(-1).params;
  assert.deepEqual(Object.keys(sent).sort(), ['ifGeneration', 'requestId', 'sessionId']);
  assert.match(sent.requestId, /^gw:[0-9a-f]{64}$/);
  assert.equal(answer.session.id, 'sa');
  assert.deepEqual(answer.session.conversation, CONVERSATION);
  // Another session in the answer is never passed on.
  daemon.state.reloadAnswer = summary('sb', ca);
  await assert.rejects(client.request('session.reload', reload({ requestId: 'rl2' })), error => error.code === 1000 && error.data?.reason === 'outcome_unknown');
  daemon.state.reloadAnswer = undefined;
  // A runtime's stderr (paths, thread ids) never reaches the client: fixed words per reason.
  daemon.state.reloadError = { code: 1005, message: 'Claude session 1234 not found in /Users/u/.claude/projects/x', data: { reason: 'native_refused', path: '/Users/u' } };
  const error = await client.request('session.reload', reload({ requestId: 'rl3' })).catch(failure => failure);
  assert.equal(error.code, 1005);
  assert.deepEqual(error.data, { reason: 'native_refused' });
  assert.ok(!error.message.includes('/Users') && !error.message.includes('1234'), error.message);
  assert.match(error.message, /opens again with the next message/);
  for (const [reason, words] of [['session_busy', /idle/], ['no_history', /send it a message first/], ['session_closed', /not open/]]) {
    daemon.state.reloadError = { code: reason === 'session_busy' ? 1004 : 1005, message: `secret ${reason}`, data: { reason } };
    const refused = await client.request('session.reload', reload({ requestId: `rl-${reason}` })).catch(failure => failure);
    assert.equal(refused.data?.reason, reason);
    assert.match(refused.message, words);
    assert.ok(!refused.message.includes('secret'));
  }
});

test('resumeCommand: session.read in scope; the gateway passes only the command it rebuilds from the id', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('reader');
  assert.deepEqual(await client.request('session.resumeCommand', { sessionId: 'sa' }), resumeCommandOf('sa', 'posix'));
  assert.deepEqual(await client.request('session.resumeCommand', { sessionId: 'sa-c' }), resumeCommandOf('sa-c', 'posix'));
  const mark = daemon.calls().length;
  await assert.rejects(client.request('session.resumeCommand', { sessionId: 'sb' }), error => error.code === 1001);
  await assert.rejects(client.request('session.resumeCommand', { sessionId: 'sa', runtime: 'claude' }), error => error.code === -32602);
  assert.deepEqual(calls(daemon, mark, 'session.resumeCommand'), []);
  // Whatever else alpd might answer (a native command, an env, a path) is refused, never passed on.
  for (const bad of [
    { ...resumeCommandOf('sa', 'posix'), argv: ['claude', '--resume', 't-sa'], posix: 'claude --resume t-sa', windows: 'claude --resume t-sa', display: 'claude --resume t-sa' },
    { ...resumeCommandOf('sa', 'posix'), env: { ALP_HOME: '/Users/u/.alp' } },
    { ...resumeCommandOf('sa', 'posix'), display: 'ALP_HOME=/Users/u/.alp alp attach sa' },
    { ...resumeCommandOf('sa', 'posix'), platform: 'plan9' },
  ]) {
    daemon.state.resumeAnswer = bad;
    await assert.rejects(client.request('session.resumeCommand', { sessionId: 'sa' }), error => error.code === 1000 && !error.message.includes('/Users'), JSON.stringify(bad));
  }
  daemon.state.resumeAnswer = resumeCommandOf('sa', 'windows');
  assert.equal((await client.request('session.resumeCommand', { sessionId: 'sa' })).platform, 'windows');
});
