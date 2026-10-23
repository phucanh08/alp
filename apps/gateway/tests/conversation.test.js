// Conversation fork and rewind through the gateway (docs/protocol/alp-json-rpc-v1.md §12.7,
// docs/alp/remote-gateway.md §5.15, issue #121 branch C): session.write (session.read as well for
// a fork, which reads the source), the source a root in the grant looked up afresh, a destination
// workspace the grant names exactly, the gateway's own principal context and per-credential
// requestIds, created forks checked before they are answered, forkedFrom never naming a source
// outside the grant (results and events), branches and conversation projected, alpd's errors as
// fixed text, history.reset to attached connections unchanged. alpd's own behaviour (journal,
// native fork, attachment re-authorization) is tested in packages/daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_PERMISSIONS, EXPOSURE, FORWARDED_CAPABILITIES, PERMISSIONS, projectBranch, projectForkedFrom } from '../src/policy.js';
import { credentialsFile } from '../src/credentials.js';
import { fakeDaemon, summary } from './support/fake-daemon.js';
import { startGateway, until } from './support/harness.js';

const CAPABILITIES = ['attach.after', 'prompt.receipts', 'workspace.registry', 'session.history', 'session.fork', 'session.rewind'];
const GEN = '0123456789abcdef0123456789abcdef';
const NEXT = 'fedcba9876543210fedcba9876543210';
const BRANCH = { branchId: 'br_0123456789abcdef', beforeTurnId: 'turn-2', turns: 2, at: '2026-10-23T00:00:00.000Z' };
const AT = '2026-10-23T00:00:00.000Z';
const CONVERSATION = { fork: true, rewind: true };

async function world(t, { capabilities = CAPABILITIES } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-conv-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [a, a2, b] = ['a', 'a2', 'b'].map(name => path.join(directory, name));
  for (const dir of [a, a2, b]) await mkdir(dir, { recursive: true });
  const [ca, ca2, cb] = await Promise.all([a, a2, b].map(dir => realpath(dir)));
  const daemon = fakeDaemon({
    capabilities,
    sessions: [
      summary('sa', ca, { conversation: CONVERSATION }), summary('sa-c', ca, { parentId: 'sa' }), summary('sb', cb), summary('sb2', cb), summary('sa3', ca),
      // Forks a local client made: one from a source outside a's grant, one from a source inside it.
      summary('fx', ca, { status: 'closed', forkedFrom: { sessionId: 'sb', turnId: 'turn-1', boundary: 'through', at: AT } }),
      summary('fy', ca, { status: 'closed', forkedFrom: { sessionId: 'sa', boundary: 'whole', branchId: BRANCH.branchId, at: AT, path: '/home/u/.alp/x' }, branches: [{ ...BRANCH, file: '/home/u/x' }, { branchId: '../x', beforeTurnId: 't', turns: 1, at: AT }] }),
    ],
  });
  const workspaces = { wks_a: ca, wks_a2: ca2, wks_b: cb };
  daemon.state.handlers['workspace.get'] = ({ workspaceId }) => {
    if (!Object.hasOwn(workspaces, workspaceId)) throw { code: 1001, message: `No workspace ${workspaceId}` };
    return { workspace: { id: workspaceId, projectId: 'prj', directory: workspaces[workspaceId], canonical: workspaces[workspaceId], createdAt: 'old', labels: [] }, revision: 1 };
  };
  let forks = 0;
  daemon.state.handlers['session.fork'] = params => {
    const source = daemon.state.sessions.get(params.sessionId);
    const forkedFrom = { sessionId: params.sessionId, ...(params.boundary?.throughTurnId ? { turnId: params.boundary.throughTurnId, boundary: 'through' } : params.boundary?.beforeTurnId ? { turnId: params.boundary.beforeTurnId, boundary: 'before' } : { boundary: 'whole' }), ...(params.branchId ? { branchId: params.branchId } : {}), at: AT };
    const id = params.newSessionId ?? `ses_fork${++forks}`;
    const created = summary(id, params.workspaceId ? workspaces[params.workspaceId] : source.projectRoot, { status: 'closed', conversation: CONVERSATION, forkedFrom, ...(params.title ? { title: params.title } : {}) });
    daemon.state.sessions.set(id, created);
    return { session: created, forkedFrom };
  };
  daemon.state.handlers['session.rewind'] = params => {
    const session = daemon.state.sessions.get(params.sessionId);
    session.branches = [BRANCH];
    daemon.emit(params.sessionId, { type: 'history.reset', generation: NEXT, reason: 'rewind', branchId: BRANCH.branchId }, { keep: false });
    return { session, generation: NEXT, branch: BRANCH };
  };
  const gw = await startGateway(t, { daemon, credentials: {
    writer: { workspaces: [a, a2], permissions: ['session.read', 'session.write'] },
    reader: { workspaces: [a], permissions: ['session.read'] },
    noread: { workspaces: [a], permissions: ['session.write'] },
    both: { workspaces: [a, b], permissions: ['session.read', 'session.write'] },
    limited: { workspaces: [a], permissions: ['session.read', 'session.write'], modes: ['read-only'] },
    fitting: { workspaces: [a], permissions: ['session.read', 'session.write'], modes: ['workspace-write'] },
  } });
  return { daemon, a, a2, b, ca, ca2, cb, ...gw };
}

const conversationCalls = (daemon, mark) => daemon.calls().slice(mark).filter(call => call.method === 'session.fork' || call.method === 'session.rewind');
const fork = (extra = {}) => ({ sessionId: 'sa', requestId: 'f1', ifGeneration: GEN, boundary: { throughTurnId: 'turn-1' }, ...extra });
const rewind = (extra = {}) => ({ sessionId: 'sa', requestId: 'r1', ifGeneration: GEN, beforeTurnId: 'turn-2', ...extra });

test('the matrix: session.write (fork also session.read), no new permission, forwarded capabilities, no client principal context', () => {
  assert.equal(EXPOSURE['session.fork'].status, 'exposed');
  assert.equal(EXPOSURE['session.fork'].permission, 'session.write');
  assert.deepEqual(EXPOSURE['session.fork'].alsoRequires, ['session.read']);
  assert.equal(EXPOSURE['session.rewind'].status, 'exposed');
  assert.equal(EXPOSURE['session.rewind'].permission, 'session.write');
  assert.equal(EXPOSURE['session.rewind'].alsoRequires, undefined);
  assert.deepEqual(EXPOSURE['session.rewind'].params, ['sessionId', 'requestId', 'ifGeneration', 'beforeTurnId']);
  for (const method of ['session.fork', 'session.rewind']) {
    for (const field of ['principalId', 'principalEpoch', 'authorizedRoots', 'cwd', 'spec', 'mode']) assert.ok(!EXPOSURE[method].params.includes(field), `${method} ${field}`);
  }
  assert.ok(FORWARDED_CAPABILITIES.includes('session.fork') && FORWARDED_CAPABILITIES.includes('session.rewind'));
  assert.deepEqual(PERMISSIONS, ['session.read', 'session.write', 'project.read', 'project.write', 'files.read', 'library.write', 'workspace.write', 'workspace.manage', 'attachments.write', 'session.team.write', 'terminal.exec']);
  assert.deepEqual(DEFAULT_PERMISSIONS, ['session.read', 'session.write', 'project.read', 'project.write']);
});

test('projections keep the schema\'s fields; forkedFrom only for a visible source', () => {
  assert.deepEqual(projectBranch({ ...BRANCH, path: '/x' }), BRANCH);
  for (const bad of [{ branchId: '../x' }, { turns: -1 }, { beforeTurnId: '' }, { at: 'x'.repeat(65) }, { beforeTurnId: '‮x' }]) assert.equal(projectBranch({ ...BRANCH, ...bad }), undefined, JSON.stringify(bad));
  const provenance = { sessionId: 'sa', turnId: 'turn-1', boundary: 'through', at: AT };
  assert.deepEqual(projectForkedFrom({ ...provenance, cwd: '/home/u' }, () => true), provenance);
  assert.equal(projectForkedFrom(provenance, () => false), undefined);
  for (const bad of [{ sessionId: 'a b' }, { boundary: 'after' }, { branchId: 'x' }, { at: '' }]) assert.equal(projectForkedFrom({ ...provenance, ...bad }, () => true), undefined, JSON.stringify(bad));
});

test('hello forwards session.fork and session.rewind only when alpd lists them', async t => {
  const listed = await world(t);
  const { hello } = await listed.sdk('writer');
  assert.ok(hello.capabilities.includes('session.fork') && hello.capabilities.includes('session.rewind'));
  const older = await world(t, { capabilities: ['attach.after', 'prompt.receipts'] });
  const plain = (await older.sdk('writer')).hello;
  assert.ok(!plain.capabilities.includes('session.fork') && !plain.capabilities.includes('session.rewind'));
});

test('permissions: 1003 grant naming what is missing, before alpd hears of the method', async t => {
  const { daemon, sdk, store, ids, home } = await world(t);
  const { client: reader } = await sdk('reader');
  for (const [method, params] of [['session.fork', fork()], ['session.rewind', rewind()]]) {
    const mark = daemon.calls().length;
    await assert.rejects(reader.request(method, params), error => error.code === 1003 && error.data?.reason === 'grant' && error.data.permission === 'session.write', method);
    assert.deepEqual(daemon.calls().slice(mark), [], `${method} reached alpd`);
  }
  // A stored grant of session.write alone (the CLI always adds session.read, a hand-edited file may not):
  // a fork reads the source's conversation, so it is refused; a rewind is not.
  const file = credentialsFile(home);
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.credentials.find(entry => entry.id === ids.noread).permissions = ['session.write'];
  await writeFile(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
  await chmod(`${file}.tmp`, 0o600);
  await rename(`${file}.tmp`, file);
  await until(() => store.grant(ids.noread) && !store.grant(ids.noread).permissions.has('session.read'), 'the edited grant to load');
  const { client: noread } = await sdk('noread');
  const mark = daemon.calls().length;
  await assert.rejects(noread.request('session.fork', fork()), error => error.code === 1003 && error.data?.reason === 'grant' && error.data.permission === 'session.read');
  assert.deepEqual(daemon.calls().slice(mark), []);
  assert.equal((await noread.request('session.rewind', rewind())).generation, NEXT);
});

test('scope: a source outside the grant, a child, a destination or new id outside it are refused before alpd', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('writer');
  const cases = [
    ['session.fork', fork({ sessionId: 'sb' }), 1001],
    ['session.fork', fork({ sessionId: 'ses_missing' }), 1001],
    ['session.fork', fork({ sessionId: 'sa-c' }), 1003, 'not_root'],
    ['session.fork', fork({ workspaceId: 'wks_b' }), 1003, 'outside_workspace'],
    ['session.fork', fork({ workspaceId: 'wks_unknown' }), 1003, 'outside_workspace'],
    ['session.fork', fork({ newSessionId: 'sb' }), 1003, 'outside_workspace'],
    ['session.rewind', rewind({ sessionId: 'sb' }), 1001],
    ['session.rewind', rewind({ sessionId: 'sa-c' }), 1003, 'not_root'],
    // Not in the schema: refused before any lookup.
    ['session.fork', { ...fork(), cwd: '/etc' }, -32602],
    ['session.fork', { ...fork(), boundary: { throughTurnId: 'turn-1', beforeTurnId: 'turn-2' } }, -32602],
    ['session.rewind', { ...rewind(), mode: 'both' }, -32602],
    ['session.rewind', { ...rewind(), restoreFiles: true }, -32602],
  ];
  const mark = daemon.calls().length;
  for (const [method, params, code, reason] of cases) {
    await assert.rejects(client.request(method, params), error => error.code === code && (reason === undefined || error.data?.reason === reason), `${method} ${JSON.stringify(params)}`);
  }
  assert.deepEqual(conversationCalls(daemon, mark), [], 'alpd never heard of a fork or rewind outside the grant');
  // The source is looked up afresh on each request, not taken from what this connection saw.
  const looked = daemon.calls('session.get').filter(call => call.params.sessionId === 'sa').length;
  await client.request('session.rewind', rewind({ requestId: 'r-fresh' }));
  await client.request('session.rewind', rewind({ requestId: 'r-fresh-2' }));
  assert.equal(daemon.calls('session.get').filter(call => call.params.sessionId === 'sa').length, looked + 2);
});

test('fork: the gateway\'s principal context and a per-credential requestId reach alpd, whatever the client sends', async t => {
  const { daemon, sdk, ids, store, ca, ca2 } = await world(t);
  const { client } = await sdk('writer');
  const answer = await client.request('session.fork', { ...fork({ title: 'Try again', newSessionId: 'ses_mine', workspaceId: 'wks_a2' }), principalId: 'owner', principalEpoch: 'owner', authorizedRoots: ['/'] });
  const sent = daemon.calls('session.fork').at(-1).params;
  const grant = store.grant(ids.writer);
  assert.deepEqual(Object.keys(sent).sort(), ['authorizedRoots', 'boundary', 'ifGeneration', 'newSessionId', 'principalEpoch', 'principalId', 'requestId', 'sessionId', 'title', 'workspaceId']);
  assert.deepEqual([sent.principalId, sent.principalEpoch, [...sent.authorizedRoots].sort()], [ids.writer, grant.scopeId, [ca, ca2].sort()]);
  assert.match(sent.requestId, /^gw:[0-9a-f]{64}$/);
  assert.deepEqual(sent.boundary, { throughTurnId: 'turn-1' });
  assert.equal(answer.session.id, 'ses_mine');
  assert.equal(answer.session.projectRoot, ca2);
  assert.deepEqual(answer.forkedFrom, { sessionId: 'sa', turnId: 'turn-1', boundary: 'through', at: AT });
  assert.deepEqual(answer.session.forkedFrom, answer.forkedFrom, 'the source is in the grant: shown');
  assert.deepEqual(answer.session.conversation, CONVERSATION);
  // The same requestId again maps to the same key; another credential's to another.
  await client.request('session.fork', fork({ requestId: 'f1' }));
  const again = daemon.calls('session.fork').at(-1).params.requestId;
  await client.request('session.fork', fork({ requestId: 'f1' }));
  assert.equal(daemon.calls('session.fork').at(-1).params.requestId, again);
  const { client: both } = await sdk('both');
  await both.request('session.fork', fork({ requestId: 'f1' }));
  assert.notEqual(daemon.calls('session.fork').at(-1).params.requestId, again);
  // Without workspaceId the fork stays in the source's workspace; a branch fork passes branchId.
  const whole = await client.request('session.fork', { sessionId: 'sa', requestId: 'f2', ifGeneration: GEN, branchId: BRANCH.branchId });
  assert.equal(whole.session.projectRoot, ca);
  assert.deepEqual(whole.forkedFrom, { sessionId: 'sa', boundary: 'whole', branchId: BRANCH.branchId, at: AT });
  // A rewind's schema has no principal context: one from the client is refused before alpd.
  const before = daemon.calls().length;
  await assert.rejects(client.request('session.rewind', { ...rewind(), principalId: 'owner' }), error => error.code === -32602);
  assert.deepEqual(conversationCalls(daemon, before), []);
  // A rewind sends exactly its four params.
  await client.request('session.rewind', rewind());
  const rewound = daemon.calls('session.rewind').at(-1).params;
  assert.deepEqual(Object.keys(rewound).sort(), ['beforeTurnId', 'ifGeneration', 'requestId', 'sessionId']);
  assert.match(rewound.requestId, /^gw:[0-9a-f]{64}$/);
});

test('fork answers: a created root outside the grant or the destination, a child, or another source is never returned', async t => {
  const { daemon, sdk, ca, cb } = await world(t);
  const { client } = await sdk('writer');
  const provenance = { sessionId: 'sa', boundary: 'whole', at: AT };
  const answers = [
    [{ session: summary('ses_out', cb, { status: 'closed' }), forkedFrom: provenance }, 1003, 'outside_workspace'],
    [{ session: summary('ses_kid', ca, { parentId: 'sa' }), forkedFrom: provenance }, 1003, 'outside_workspace'],
    [{ session: summary('sa', ca), forkedFrom: provenance }, 1003, 'outside_workspace'],
    [{ session: summary('ses_ok', ca), forkedFrom: { ...provenance, sessionId: 'sb' } }, 1000, 'outcome_unknown'],
    [{ session: summary('ses_ok', ca), forkedFrom: { ...provenance, boundary: 'after' } }, 1000, 'outcome_unknown'],
  ];
  for (const [answer, code, reason] of answers) {
    daemon.state.handlers['session.fork'] = () => answer;
    const error = await client.request('session.fork', fork()).catch(caught => caught);
    assert.deepEqual([error.code, error.data?.reason], [code, reason], JSON.stringify(answer.session.id));
    assert.ok(!JSON.stringify(error).includes(cb), 'no foreign path');
    assert.ok(!JSON.stringify(error).includes('ses_out'), 'no foreign id');
  }
  // A destination asked for is the one answered: a fork alpd put elsewhere in the grant is refused too.
  daemon.state.handlers['session.fork'] = () => ({ session: summary('ses_ok', ca), forkedFrom: provenance });
  await assert.rejects(client.request('session.fork', fork({ workspaceId: 'wks_a2' })), error => error.code === 1003 && error.data?.reason === 'outside_workspace');
  // A newSessionId asked for is the one answered.
  await assert.rejects(client.request('session.fork', fork({ newSessionId: 'ses_asked' })), error => error.code === 1003);
  // A repeated request passes duplicate on.
  daemon.state.handlers['session.fork'] = () => ({ session: summary('ses_ok', ca), forkedFrom: provenance, duplicate: true, host: '/home/u' });
  const repeated = await client.request('session.fork', fork());
  assert.deepEqual(Object.keys(repeated).sort(), ['duplicate', 'forkedFrom', 'session']);
  assert.equal(repeated.duplicate, true);
});

test('summaries: forkedFrom only when its source is in the grant, branches and conversation projected, in results and events', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('writer');
  const fx = (await client.request('session.get', { sessionId: 'fx' })).session;
  assert.equal(Object.hasOwn(fx, 'forkedFrom'), false, 'the source sb is outside the grant');
  assert.equal(JSON.stringify(fx).includes('sb'), false);
  const fy = (await client.request('session.get', { sessionId: 'fy' })).session;
  assert.deepEqual(fy.forkedFrom, { sessionId: 'sa', boundary: 'whole', branchId: BRANCH.branchId, at: AT });
  assert.deepEqual(fy.branches, [BRANCH], 'extra fields and a malformed branch dropped');
  assert.deepEqual((await client.request('session.get', { sessionId: 'sa' })).session.conversation, CONVERSATION);
  const { sessions } = await client.request('session.list', { includeClosed: true });
  const rows = Object.fromEntries(sessions.map(row => [row.id, row]));
  assert.equal(Object.hasOwn(rows.fx, 'forkedFrom'), false);
  assert.equal(rows.fy.forkedFrom.sessionId, 'sa');
  // A credential granted b as well sees fx's source.
  const { client: both } = await sdk('both');
  assert.equal((await both.request('session.get', { sessionId: 'fx' })).session.forkedFrom.sessionId, 'sb');
  // Events: a summary naming a source this connection has not looked up holds its place until it is.
  const { client: fresh } = await sdk('writer');
  const seen = [];
  fresh.onEvent(envelope => seen.push(envelope));
  await fresh.request('session.attach', { sessionId: 'sa', replay: false });
  const sa = daemon.state.sessions.get('sa');
  const lookups = id => daemon.calls('session.get').filter(call => call.params.sessionId === id).length;
  daemon.emit('sa', { type: 'session.updated', session: { ...sa, forkedFrom: { sessionId: 'sb2', boundary: 'whole', at: AT } } });
  daemon.emit('sa', { type: 'session.updated', session: { ...sa, forkedFrom: { sessionId: 'sa3', boundary: 'whole', at: AT }, branches: [{ ...BRANCH, extra: 1 }] } });
  daemon.emit('sa', { type: 'session.ready' });
  await until(() => seen.length === 3, 'three events');
  assert.deepEqual(seen.map(envelope => envelope.event.type), ['session.updated', 'session.updated', 'session.ready'], 'order kept while the sources are looked up');
  assert.equal(Object.hasOwn(seen[0].event.session, 'forkedFrom'), false, 'sb2 is outside the grant');
  assert.equal(seen[1].event.session.forkedFrom.sessionId, 'sa3');
  assert.deepEqual(seen[1].event.session.branches, [BRANCH]);
  assert.deepEqual([lookups('sb2'), lookups('sa3')], [1, 1]);
  // A source found outside is not looked up again.
  daemon.emit('sa', { type: 'session.updated', session: { ...sa, forkedFrom: { sessionId: 'sb2', boundary: 'whole', at: AT } } });
  await until(() => seen.length === 4, 'the fourth event');
  assert.equal(lookups('sb2'), 1);
  assert.equal(Object.hasOwn(seen[3].event.session, 'forkedFrom'), false);
  // History items are projected the same way.
  daemon.state.handlers['session.history'] = ({ sessionId }) => {
    const items = daemon.state.timelines.get(daemon.rootOf(sessionId)) ?? [];
    return { generation: GEN, items, hasOlder: false, tipCursor: items.at(-1)?.cursor ?? 0 };
  };
  const history = await fresh.request('session.history', { sessionId: 'sa' });
  const updates = history.items.filter(item => item.event?.type === 'session.updated');
  assert.deepEqual(updates.map(item => item.event.session.forkedFrom?.sessionId), [undefined, 'sa3', undefined]);
});

test('rewind: the same session, its branch and generation projected; history.reset reaches attached connections unchanged', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('writer');
  const seen = [];
  client.onEvent(envelope => seen.push(envelope));
  await client.request('session.attach', { sessionId: 'sa', replay: false });
  const { client: elsewhere } = await sdk('both');
  const other = [];
  elsewhere.onEvent(envelope => other.push(envelope));
  await elsewhere.request('session.attach', { sessionId: 'sb', replay: false });
  const answer = await client.request('session.rewind', rewind());
  assert.deepEqual(Object.keys(answer).sort(), ['branch', 'generation', 'session']);
  assert.equal(answer.session.id, 'sa');
  assert.equal(answer.generation, NEXT);
  assert.deepEqual(answer.branch, BRANCH);
  assert.deepEqual(answer.session.branches, [BRANCH]);
  await until(() => seen.some(envelope => envelope.event.type === 'history.reset'), 'history.reset');
  const reset = seen.find(envelope => envelope.event.type === 'history.reset');
  assert.deepEqual(reset.event, { type: 'history.reset', generation: NEXT, reason: 'rewind', branchId: BRANCH.branchId });
  assert.equal(reset.cursor, undefined, 'never kept');
  assert.equal(other.filter(envelope => envelope.event.type === 'history.reset').length, 0);
  // An answer for another session, or without its branch or generation, is refused.
  for (const bad of [{ session: summary('sa-c', daemon.state.sessions.get('sa').projectRoot), generation: NEXT, branch: BRANCH }, { session: daemon.state.sessions.get('sa'), generation: 'g1', branch: BRANCH }, { session: daemon.state.sessions.get('sa'), generation: NEXT }]) {
    daemon.state.handlers['session.rewind'] = () => bad;
    await assert.rejects(client.request('session.rewind', rewind()), error => error.code === 1000 && error.data?.reason === 'outcome_unknown');
  }
});

test('alpd\'s refusals: fixed text, code, reason, a generation and plain numbers; nothing else', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('writer');
  daemon.state.handlers['session.rewind'] = () => { throw { code: 1004, message: 'stale at /home/u/.alp/state/sessions/sa/journal.ndjson', data: { reason: 'stale_generation', generation: NEXT, turns: 3, path: '/home/u/x', nested: { a: 1 }, size: -1 } }; };
  const stale = await client.request('session.rewind', rewind()).catch(error => error);
  assert.deepEqual([stale.code, stale.data], [1004, { reason: 'stale_generation', generation: NEXT, turns: 3 }]);
  assert.ok(!stale.message.includes('/home'), stale.message);
  daemon.state.handlers['session.fork'] = () => { throw { code: 1005, message: 'claude --resume failed: ENOENT /Users/u/.claude/projects/x.jsonl', data: { reason: 'native_refused' } }; };
  const refused = await client.request('session.fork', fork()).catch(error => error);
  assert.deepEqual([refused.code, refused.data], [1005, { reason: 'native_refused' }]);
  assert.ok(!refused.message.includes('/Users'), refused.message);
  daemon.state.handlers['session.fork'] = () => { throw { code: 1000, message: 'boom /etc/x', data: { reason: 'something_new' } }; };
  const unknown = await client.request('session.fork', fork()).catch(error => error);
  assert.deepEqual([unknown.code, unknown.data], [1000, { reason: 'something_new' }]);
  assert.ok(!unknown.message.includes('/etc'));
  daemon.state.handlers['session.fork'] = () => { throw { code: 1004, message: 'Session ses_x already exists', data: { reason: 'request_conflict' } }; };
  const taken = await client.request('session.fork', fork()).catch(error => error);
  assert.deepEqual([taken.code, taken.data, taken.message], [1004, { reason: 'request_conflict' }, 'A session with this newSessionId already exists']);
  daemon.state.handlers['session.fork'] = () => { throw { code: 1000, message: 'raw /etc/x' }; };
  const raw = await client.request('session.fork', fork()).catch(error => error);
  assert.deepEqual([raw.code, raw.data], [1000, undefined]);
  assert.ok(!raw.message.includes('/etc'));
});

test('a grant with modes forks and rewinds only sessions whose tree runs within them, looked up afresh, as session.prompt drives', async t => {
  const { daemon, sdk } = await world(t);
  assert.ok(EXPOSURE['session.fork'].tests.includes('mode'));
  assert.ok(EXPOSURE['session.rewind'].tests.includes('mode'));
  const limited = (await sdk('limited')).client;
  const mark = daemon.calls().length;
  // sa runs workspace-write: a read-only grant may neither fork nor rewind its conversation.
  for (const [method, params] of [['session.fork', fork()], ['session.rewind', rewind()]]) {
    const error = await limited.request(method, params).catch(failure => failure);
    assert.equal(error.code, 1003, method);
    assert.equal(error.data?.reason, 'mode', method);
  }
  assert.deepEqual(conversationCalls(daemon, mark), []);
  // A grant whose modes include the tree's goes on.
  const fitting = (await sdk('fitting')).client;
  assert.equal((await fitting.request('session.rewind', rewind({ requestId: 'r-fit' }))).branch.branchId, BRANCH.branchId);
  assert.equal((await fitting.request('session.fork', fork({ requestId: 'f-fit' }))).forkedFrom.sessionId, 'sa');
  // Looked up afresh: once the source runs full-access, the same grant is refused.
  daemon.state.sessions.set('sa', { ...daemon.state.sessions.get('sa'), mode: 'full-access' });
  const error = await fitting.request('session.rewind', rewind({ requestId: 'r-fit-2' })).catch(failure => failure);
  assert.equal(error.data?.reason, 'mode');
});
