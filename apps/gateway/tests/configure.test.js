// session.configure with model, thinking or team, and session.configure.preview, through the gateway
// (docs/protocol/alp-json-rpc-v1.md §12.9, docs/alp/remote-gateway.md §5.17, issue #121 branch D):
// model and effort need session.write and the grant's modes (as session.prompt), team also the opt-in
// session.team.write, the preview session.read; a change never takes a session beyond the grant's
// modes; answers are projected and alpd's refusals leave as fixed text. alpd's journal, idle barrier
// and native restart are tested in packages/daemon and packages/runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_PERMISSIONS, EXPOSURE, FORWARDED_CAPABILITIES, PERMISSIONS, projectConfigurePreview, projectConfigured, projectConversation, projectEffective } from '../src/policy.js';
import { fakeDaemon, summary } from './support/fake-daemon.js';
import { startGateway } from './support/harness.js';

const CAPABILITIES = ['attach.after', 'prompt.receipts', 'session.history', 'session.reload', 'session.configure.live'];
const GEN = '0123456789abcdef0123456789abcdef';
const CONVERSATION = { fork: false, rewind: false, reload: true, configure: true, reason: 'runtime_unsupported' };
const effective = (extra = {}) => ({
  team: 'pho', teamLabel: 'Phở', agent: 'main', runtime: 'codex', model: 'gpt', thinking: 'medium', mode: 'workspace-write', supervisor: true, maxPeers: 2,
  delegates: ['peer'], tools: ['alp_delegate'], mcpServers: [{ name: 'docs', kind: 'stdio', command: '/usr/bin/secret-server' }], hooks: 1, instructionsSha: 'abcdef012345', ...extra,
});

async function world(t, { capabilities = CAPABILITIES } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-configure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [a, b] = ['a', 'b'].map(name => path.join(directory, name));
  for (const dir of [a, b]) await mkdir(dir, { recursive: true });
  const [ca, cb] = await Promise.all([a, b].map(dir => realpath(dir)));
  const daemon = fakeDaemon({
    capabilities,
    sessions: [summary('sa', ca, { conversation: CONVERSATION }), summary('sa-c', ca, { parentId: 'sa' }), summary('sb', cb, { conversation: CONVERSATION })],
  });
  daemon.state.handlers['session.configure.preview'] = params => {
    if (daemon.state.previewError) throw daemon.state.previewError;
    return daemon.state.previewAnswer ?? { preview: { current: effective(), proposed: effective({ model: params.model ?? 'gpt', thinking: params.thinking ?? 'medium', team: params.team ?? 'pho', mode: daemon.state.proposedMode ?? params.mode ?? 'workspace-write' }), changes: ['model'], restart: true, allowed: true, teams: [{ id: 'pho', label: 'Phở' }, { id: 'cafe', label: 'Cafe', path: '/host/teams/cafe' }] } };
  };
  daemon.state.handlers['session.configure'] = params => {
    if (params.model === undefined && params.thinking === undefined && params.team === undefined) return { session: { ...daemon.state.sessions.get(params.sessionId), mode: params.mode ?? 'workspace-write' } };
    if (daemon.state.configureError) throw daemon.state.configureError;
    const session = daemon.state.configureAnswer ?? { ...daemon.state.sessions.get(params.sessionId), model: params.model ?? 'gpt' };
    return { session, configured: { status: 'applied', requested: { model: params.model, team: params.team }, effective: effective({ model: params.model ?? 'gpt', team: params.team ?? 'pho' }), restarted: true, native: { model: 'x' } } };
  };
  const gw = await startGateway(t, { daemon, credentials: {
    writer: { workspaces: [a], permissions: ['session.read', 'session.write'] },
    teams: { workspaces: [a], permissions: ['session.read', 'session.write', 'session.team.write'] },
    teamOnly: { workspaces: [a], permissions: ['session.read', 'session.team.write'] },
    reader: { workspaces: [a], permissions: ['session.read'] },
    limited: { workspaces: [a], permissions: ['session.read', 'session.write'], modes: ['read-only'] },
    fitting: { workspaces: [a], permissions: ['session.read', 'session.write'], modes: ['workspace-write'] },
  } });
  return { daemon, a, b, ca, cb, ...gw };
}

const live = (extra = {}) => ({ sessionId: 'sa', model: 'codex:gpt-6.1-sol', requestId: 'c1', ifGeneration: GEN, ...extra });
const calls = (daemon, mark, method) => daemon.calls().slice(mark).filter(call => call.method === method);

test('the matrix: configure is session.write with modes, its preview session.read; session.team.write is opt-in and implies nothing; the capability is forwarded', () => {
  assert.equal(EXPOSURE['session.configure'].permission, 'session.write');
  assert.deepEqual(EXPOSURE['session.configure'].params, ['sessionId', 'mode', 'model', 'thinking', 'team', 'requestId', 'ifGeneration']);
  assert.ok(EXPOSURE['session.configure'].tests.includes('mode'));
  assert.equal(EXPOSURE['session.configure.preview'].permission, 'session.read');
  assert.deepEqual(EXPOSURE['session.configure.preview'].params, ['sessionId', 'mode', 'model', 'thinking', 'team']);
  assert.ok(PERMISSIONS.includes('session.team.write'));
  assert.ok(!DEFAULT_PERMISSIONS.includes('session.team.write'));
  assert.ok(FORWARDED_CAPABILITIES.includes('session.configure.live'));
  assert.deepEqual(projectConversation({ fork: false, rewind: false, configure: true, reason: 'not_root' }), { fork: false, rewind: false, configure: true, reason: 'not_root' });
  // Projections keep names and counts; never a command, path or unknown field.
  const shown = projectEffective(effective({ secret: '/Users/u' }));
  assert.deepEqual(shown.mcpServers, [{ name: 'docs', kind: 'stdio' }]);
  assert.equal(shown.secret, undefined);
  assert.equal(projectEffective(effective({ model: '/etc/passwd' })), undefined);
  const preview = projectConfigurePreview({ current: effective(), proposed: effective(), changes: ['team', 'path'], restart: true, allowed: false, reason: 'permission_escalation', message: 'hook /Users/u/.alp/hooks/x.json', teams: [{ id: 'cafe', label: 'Cafe', path: '/x' }] });
  assert.deepEqual(preview.changes, ['team']);
  assert.match(preview.message, /more permissions or new commands/);
  assert.deepEqual(preview.teams, [{ id: 'cafe', label: 'Cafe' }]);
  assert.equal(projectConfigured({ status: 'maybe', requested: {}, effective: effective(), restarted: true }), undefined);
});

test('hello forwards session.configure.live only when alpd lists it; a live change without it is refused before alpd', async t => {
  const listed = await world(t);
  assert.ok((await listed.sdk('writer')).hello.capabilities.includes('session.configure.live'));
  assert.deepEqual((await (await listed.sdk('writer')).client.request('session.get', { sessionId: 'sa' })).session.conversation, CONVERSATION);
  const older = await world(t, { capabilities: ['attach.after', 'prompt.receipts'] });
  const { client, hello } = await older.sdk('writer');
  assert.ok(!hello.capabilities.includes('session.configure.live'));
  const mark = older.daemon.calls().length;
  await assert.rejects(client.request('session.configure', live()), error => error.code === 1005 && error.data?.reason === 'capability');
  assert.deepEqual(calls(older.daemon, mark, 'session.configure'), []);
});

test('configure: permission, team grant, scope, a child and the grant\'s modes are refused before alpd changes anything', async t => {
  const { daemon, sdk } = await world(t);
  const { client: reader } = await sdk('reader');
  const { client: writer } = await sdk('writer');
  const { client: teamOnly } = await sdk('teamOnly');
  const { client: limited } = await sdk('limited');
  const mark = daemon.calls().length;
  await assert.rejects(reader.request('session.configure', live()), error => error.code === 1003 && error.data?.permission === 'session.write');
  await assert.rejects(teamOnly.request('session.configure', live({ model: undefined, team: 'cafe' })), error => error.code === 1003 && error.data?.permission === 'session.write');
  await assert.rejects(writer.request('session.configure', live({ model: undefined, team: 'cafe' })), error => error.code === 1003 && error.data?.reason === 'grant' && error.data.permission === 'session.team.write');
  await assert.rejects(writer.request('session.configure', live({ sessionId: 'sb' })), error => error.code === 1001);
  await assert.rejects(writer.request('session.configure', live({ sessionId: 'sa-c' })), error => error.code === 1003 && error.data?.reason === 'not_root');
  await assert.rejects(writer.request('session.configure', live({ requestId: undefined })), error => error.code === -32602);
  // A read-only grant may not drive a workspace-write root, nor ask for a mode it lacks.
  await assert.rejects(limited.request('session.configure', live()), error => error.code === 1003 && error.data?.reason === 'mode');
  assert.deepEqual(calls(daemon, mark, 'session.configure'), [], 'alpd changed nothing for a refused request');
  const { client: fitting } = await sdk('fitting');
  // The mode alpd would run the root with after the change must be one of the grant's too.
  daemon.state.proposedMode = 'full-access';
  const before = daemon.calls().length;
  await assert.rejects(fitting.request('session.configure', live({ requestId: 'up' })), error => error.code === 1003 && error.data?.reason === 'mode');
  assert.deepEqual(calls(daemon, before, 'session.configure'), []);
  assert.equal(calls(daemon, before, 'session.configure.preview').length, 1, 'asked first');
  daemon.state.proposedMode = undefined;
  const fit = await fitting.request('session.configure', { ...live({ requestId: 'fit' }), teamPath: '/host/teams', env: { X: '1' } });
  assert.deepEqual(Object.keys(calls(daemon, 0, 'session.configure').at(-1).params).sort(), ['ifGeneration', 'model', 'requestId', 'sessionId'], 'no other field reaches alpd');
  assert.equal(fit.session.id, 'sa');
  assert.equal(fit.configured.effective.mode, 'workspace-write');
});

test('configure: a team with session.team.write; the requestId is per credential; the answer is projected; alpd\'s refusals leave as fixed text', async t => {
  const { daemon, sdk, ca } = await world(t);
  const { client } = await sdk('teams');
  const answer = await client.request('session.configure', live({ model: undefined, team: 'cafe' }));
  const sent = calls(daemon, 0, 'session.configure').at(-1).params;
  assert.deepEqual(Object.keys(sent).sort(), ['ifGeneration', 'requestId', 'sessionId', 'team']);
  assert.match(sent.requestId, /^gw:[0-9a-f]{64}$/);
  assert.equal(answer.configured.effective.team, 'cafe');
  assert.deepEqual(answer.configured.effective.mcpServers, [{ name: 'docs', kind: 'stdio' }], 'no command passes');
  assert.equal(answer.configured.native, undefined);
  assert.deepEqual(answer.session.conversation, CONVERSATION);
  daemon.state.configureAnswer = summary('sb', ca);
  await assert.rejects(client.request('session.configure', live({ requestId: 'other' })), error => error.code === 1000 && error.data?.reason === 'outcome_unknown');
  daemon.state.configureAnswer = undefined;
  daemon.state.configureError = { code: 1005, message: 'A session keeps its runtime (Codex) at /Users/u/.codex', data: { reason: 'runtime_mismatch', action: 'session.create', path: '/Users/u' } };
  const migration = await client.request('session.configure', live({ requestId: 'mig' })).catch(failure => failure);
  assert.equal(migration.code, 1005);
  assert.deepEqual(migration.data, { reason: 'runtime_mismatch', action: 'session.create' });
  assert.ok(!migration.message.includes('/Users'), migration.message);
  assert.match(migration.message, /start a new session/);
  for (const [code, reason, words] of [[1004, 'session_busy', /idle/], [1003, 'permission_escalation', /more permissions/], [1001, 'team_not_found', /no such team/], [1005, 'native_refused', /keeps its own/], [1004, 'stale_generation', /history again/], [1004, 'outcome_unknown', /read the session/]]) {
    daemon.state.configureError = { code, message: `secret ${reason} /Users/u`, data: { reason } };
    const refused = await client.request('session.configure', live({ requestId: `r-${reason}` })).catch(failure => failure);
    assert.equal(refused.code, code);
    assert.equal(refused.data?.reason, reason);
    assert.match(refused.message, words);
    assert.ok(!refused.message.includes('secret'), refused.message);
  }
});

test('preview: session.read in scope, a root only, projected with fixed messages; mode-only configure keeps its old shape', async t => {
  const { daemon, sdk } = await world(t);
  const { client: reader } = await sdk('reader');
  const { preview } = await reader.request('session.configure.preview', { sessionId: 'sa', team: 'cafe' });
  assert.equal(preview.proposed.team, 'cafe');
  assert.deepEqual(preview.teams, [{ id: 'pho', label: 'Phở' }, { id: 'cafe', label: 'Cafe' }]);
  assert.equal(preview.current.mcpServers[0].command, undefined);
  const mark = daemon.calls().length;
  await assert.rejects(reader.request('session.configure.preview', { sessionId: 'sb' }), error => error.code === 1001);
  await assert.rejects(reader.request('session.configure.preview', { sessionId: 'sa-c' }), error => error.code === 1003 && error.data?.reason === 'not_root');
  await assert.rejects(reader.request('session.configure.preview', { sessionId: 'sa', requestId: 'x' }), error => error.code === -32602);
  assert.deepEqual(calls(daemon, mark, 'session.configure.preview'), []);
  daemon.state.previewAnswer = { preview: { current: effective(), proposed: effective({ runtime: 'claude', model: 'opus' }), changes: ['model'], restart: true, allowed: false, reason: 'runtime_mismatch', message: 'Claude CLI at /Users/u/.local/bin/claude', teams: [] } };
  const refused = (await reader.request('session.configure.preview', { sessionId: 'sa', model: 'claude:opus' })).preview;
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, 'runtime_mismatch');
  assert.ok(!refused.message.includes('/Users'));
  daemon.state.previewAnswer = undefined;
  daemon.state.previewError = { code: 1005, message: 'session /Users/u closed', data: { reason: 'session_closed' } };
  const closed = await reader.request('session.configure.preview', { sessionId: 'sa' }).catch(failure => failure);
  assert.equal(closed.data?.reason, 'session_closed');
  assert.ok(!closed.message.includes('/Users'));
  // Mode alone: the old method, its old answer.
  const { client: writer } = await sdk('writer');
  const mode = await writer.request('session.configure', { sessionId: 'sa', mode: 'read-only' });
  assert.equal(mode.session.mode, 'read-only');
  assert.equal(mode.configured, undefined);
});
