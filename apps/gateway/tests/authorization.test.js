// Authorization (docs/alp/remote-gateway.md §5): the exposure matrix is complete and default-deny,
// every exposed method is checked for permission and for workspace/session scope before anything
// reaches alpd, results and events stay inside the grant, and spec fields, prompt content and modes
// are allow-listed. Every refusal is checked to have caused no request of that method at alpd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { RPC_METHODS } from '@anhlp/alp-protocol';
import { METHODS_V1 } from '@anhlp/alp-protocol/contract';
import { EXPOSURE, unclassified } from '../src/index.js';
import { hostLabel, projectLibraryContent, promptImageLimits } from '../src/policy.js';
import { fakeDaemon, summary } from './support/fake-daemon.js';
import { startGateway, until } from './support/harness.js';

async function world(t, { modes, maxFrame } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-authz-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = path.join(directory, 'a');
  const b = path.join(directory, 'b');
  await mkdir(a);
  await mkdir(b);
  const canonicalA = await realpath(a);
  const daemon = fakeDaemon({
    sessions: [
      summary('sa', canonicalA), summary('sa-c', canonicalA, { parentId: 'sa' }),
      summary('sb', b), summary('sb-c', b, { parentId: 'sb' }),
      // A session claiming workspace a inside a tree of workspace b: still out of scope.
      summary('mix', canonicalA, { parentId: 'sb' }),
      summary('ro', canonicalA, { mode: 'read-only' }),
    ],
    questions: [
      { id: 'q-a-111', sessionId: 'sa-c', rootId: 'sa', agent: 'main', body: 'a?', askedAt: '2026-10-15T00:00:00.000Z' },
      { id: 'q-b-222', sessionId: 'sb', rootId: 'sb', agent: 'main', body: 'b?', askedAt: '2026-10-15T00:00:00.000Z' },
    ],
  });
  // Every exposed method in a row from one connection: the rate limit (tested in gateway.test.js) is lifted here.
  const gw = await startGateway(t, { daemon, config: { limits: { rate: 100_000, burst: 100_000, ...(maxFrame ? { maxFrame } : {}) } }, credentials: {
    alice: { workspaces: [a], permissions: ['session.read', 'session.write', 'project.read', 'project.write', 'files.read', 'library.write'], ...(modes ? { modes } : {}) },
    reader: { workspaces: [a], permissions: ['session.read'] },
    sessions: { workspaces: [a], permissions: ['session.read', 'session.write'] },
    both: { workspaces: [a, b] },
  } });
  return { daemon, a, b, canonicalA, ...gw };
}

/** Requests of `method` that reached alpd after `mark`. */
const reached = (daemon, mark, method) => daemon.calls().slice(mark).filter(call => call.method === method);

// One out-of-scope call per exposed method, with what the client must get back. Lookups the
// gateway itself makes (session.get, question.list, session.list) are allowed to reach alpd;
// the method under test must not.
const text = [{ type: 'text', text: 'hi' }];
const OUT_OF_SCOPE = {
  'workspace.worktree.options': null, 'workspace.worktree.create': null, 'workspace.worktree.remove': null, // worktrees.test.js checks exact derived grants and mutation scope

  'project.list': null, 'workspace.list': null, 'workspace.get': null, 'project.register': null, 'project.remove': null, 'workspace.update': null, // registry.test.js checks scoped rows and every mutation
  'workspace.git.status': null, 'workspace.git.diff': null, // git.test.js checks registry scope, both permissions, paths and projection
  'attachment.begin': null, 'attachment.chunk': null, 'attachment.commit': null, 'attachment.abort': null, 'attachment.get': null, 'attachment.delete': null, // attachments.test.js checks the session scope, both permissions and the principal context; alpd's binding is tested against its store

  'terminal.capture': null, 'terminal.watch': null, 'terminal.unwatch': null,
  'terminal.create': null, 'terminal.list': null, 'terminal.attach': null, 'terminal.input': null, 'terminal.resize': null, 'terminal.close': null, // terminal.test.js checks terminal.exec, the registry scope, the principal context and event filtering; alpd's binding is tested against real PTYs
  'catalog.get': null, // global: the catalogue of models and modes; provider errors are dropped (catalog projection test)
  'session.list': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'session.get': () => [{ sessionId: 'sb' }, 1001],
  'session.status': () => [{ sessionId: 'mix' }, 1001],
  'session.log': () => [{ sessionId: 'sb-c' }, 1001],
  'session.history': () => [{ sessionId: 'sb', before: 'malicious' }, 1001],
  'session.attach': () => [{ sessionId: 'sb', after: 0 }, 1001],
  'session.release': () => [{ sessionId: 'sb' }, 1001],
  'session.attention.clear': () => [{ sessionId: 'sb' }, 1001],
  'session.preview': ({ b }) => [{ spec: { cwd: b } }, 1003, 'outside_workspace'],
  'question.list': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'question.watch': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'board.list': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'workspace.files.search': ({ b }) => [{ projectRoot: b, query: 'x' }, 1003, 'outside_workspace'],
  'workspace.files.list': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'workspace.files.read': ({ b }) => [{ projectRoot: b, path: 'README.md' }, 1003, 'outside_workspace'],
  'session.create': ({ b }) => [{ spec: { cwd: b } }, 1003, 'outside_workspace'],
  'session.prompt': () => [{ sessionId: 'mix', clientMessageId: 'm', content: text }, 1001],
  'session.interrupt': () => [{ sessionId: 'sb' }, 1001],
  'session.configure': () => [{ sessionId: 'sb', mode: 'read-only' }, 1001],
  'session.close': () => [{ sessionId: 'sb-c' }, 1001],
  'session.rename': () => [{ sessionId: 'sb', title: 'mine now' }, 1001],
  'session.archive': () => [{ sessionId: 'sb' }, 1001],
  'session.message': () => [{ sessionId: 'sb', text: 'hello' }, 1001],
  // conversation.test.js covers children (not_root), destinations, new ids and the principal context.
  'session.fork': () => [{ sessionId: 'sb', requestId: 'r', ifGeneration: '0'.repeat(32), boundary: { throughTurnId: 't' } }, 1001],
  'session.rewind': () => [{ sessionId: 'sb-c', requestId: 'r', ifGeneration: '0'.repeat(32), beforeTurnId: 't' }, 1001],
  // reload.test.js covers children (not_root), modes and the projected answer.
  'session.reload': () => [{ sessionId: 'sb', requestId: 'r', ifGeneration: '0'.repeat(32) }, 1001],
  'session.configure.preview': () => [{ sessionId: 'sb', model: 'gpt' }, 1001],
  'session.resumeCommand': () => [{ sessionId: 'sb-c' }, 1001],
  'question.answer': () => [{ questionId: 'q-b-222', text: 'yes' }, 1001],
  'team.list': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'task.list': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'task.create': ({ b }) => [{ projectRoot: b, title: 'theirs' }, 1003, 'outside_workspace'],
  'task.update': ({ b }) => [{ projectRoot: b, id: 't-a000', action: 'close' }, 1003, 'outside_workspace'],
  'task.gate.resolve': ({ b }) => [{ projectRoot: b, id: 't-a000', gate: 'review' }, 1003, 'outside_workspace'],
  'library.list': ({ b }) => [{ kind: 'mcp', projectRoot: b }, 1003, 'outside_workspace'],
  'library.get': ({ b }) => [{ kind: 'mcp', name: 'x', projectRoot: b }, 1003, 'outside_workspace'],
  'library.save': ({ b }) => [{ kind: 'skills', scope: 'project', projectRoot: b, name: 'writer', content: { body: 'text' } }, 1003, 'outside_workspace'],
  'library.delete': ({ b }) => [{ kind: 'skills', scope: 'project', projectRoot: b, name: 'writer' }, 1003, 'outside_workspace'],
  'library.duplicate': ({ b }) => [{ kind: 'skills', scope: 'project', projectRoot: b, from: 'writer', to: 'copy' }, 1003, 'outside_workspace'],
  'library.rename': ({ b }) => [{ kind: 'skills', scope: 'project', projectRoot: b, from: 'writer', to: 'copy' }, 1003, 'outside_workspace'],
  'library.models': null, // model ids and labels, as catalog.get
  'settings.language.get': null, // the language the user reads
};

/** Schema-valid params in scope for every exposed method, for permission checks. */
const IN_SCOPE = ({ a }) => ({
  'workspace.worktree.options': {workspaceId:'wks_a'}, 'workspace.worktree.create': {workspaceId:'wks_a',mappingId:'approved',requestId:'r',ifRevision:0}, 'workspace.worktree.remove': {workspaceId:'wks_a',requestId:'r',ifRevision:0},
  'project.list': {}, 'workspace.list': {}, 'workspace.get': { workspaceId: 'wks_a' },
  'project.register': { directory: a, ifRevision: 0, requestId: 'r' },
  'project.remove': { projectId: 'prj_a', ifRevision: 0, requestId: 'r' },
  'workspace.update': { workspaceId: 'wks_a', pinned: true, ifRevision: 0, requestId: 'r' },
  'workspace.git.status': { workspaceId: 'wks_a' }, 'workspace.git.diff': { workspaceId: 'wks_a', compare: { mode: 'uncommitted' } },
  'attachment.begin': { sessionId: 'sa', name: 'a.txt', size: 1, mimeType: 'text/plain', requestId: 'r' }, 'attachment.chunk': { uploadId: `upl_${'1'.repeat(32)}`, offset: 0, data: 'AAAA' },
  'attachment.commit': { uploadId: `upl_${'1'.repeat(32)}`, sha256: '0'.repeat(64) }, 'attachment.abort': { uploadId: `upl_${'1'.repeat(32)}` },
  'attachment.get': { attachmentId: `att_${'1'.repeat(32)}` }, 'attachment.delete': { attachmentId: `att_${'1'.repeat(32)}` },
  'terminal.capture': { terminalId: `term_${'1'.repeat(32)}` }, 'terminal.watch': {}, 'terminal.unwatch': {},
  'terminal.create': { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'r' }, 'terminal.list': {}, 'terminal.attach': { terminalId: `term_${'1'.repeat(32)}` },
  'terminal.input': { terminalId: `term_${'1'.repeat(32)}`, data: 'x' }, 'terminal.resize': { terminalId: `term_${'1'.repeat(32)}`, cols: 80, rows: 24 }, 'terminal.close': { terminalId: `term_${'1'.repeat(32)}` },
  'catalog.get': {}, 'library.models': {}, 'settings.language.get': {},
  'session.list': {}, 'session.get': { sessionId: 'sa' }, 'session.status': { sessionId: 'sa' }, 'session.log': { sessionId: 'sa' },
  'session.history': { sessionId: 'sa' }, 'session.attach': { sessionId: 'sa' }, 'session.release': { sessionId: 'sa' }, 'session.attention.clear': { sessionId: 'sa' }, 'session.preview': { spec: { cwd: a } },
  'question.list': {}, 'question.watch': {}, 'board.list': { projectRoot: a }, 'workspace.files.search': { projectRoot: a },
  'workspace.files.list': { projectRoot: a }, 'workspace.files.read': { projectRoot: a, path: 'README.md' },
  'session.create': { spec: { cwd: a } }, 'session.prompt': { sessionId: 'sa', clientMessageId: 'm', content: text },
  'session.interrupt': { sessionId: 'sa' }, 'session.configure': { sessionId: 'sa' }, 'session.close': { sessionId: 'sa' },
  'session.rename': { sessionId: 'sa', title: 't' }, 'session.archive': { sessionId: 'sa' }, 'session.message': { sessionId: 'sa', text: 'x' },
  'session.fork': { sessionId: 'sa', requestId: 'r', ifGeneration: '0'.repeat(32) }, 'session.rewind': { sessionId: 'sa', requestId: 'r', ifGeneration: '0'.repeat(32), beforeTurnId: 't' },
  'session.reload': { sessionId: 'sa', requestId: 'r', ifGeneration: '0'.repeat(32) }, 'session.resumeCommand': { sessionId: 'sa' },
  'session.configure.preview': { sessionId: 'sa' },
  'question.answer': { questionId: 'q-a-111', text: 'x' },
  'team.list': { projectRoot: a }, 'task.list': { projectRoot: a }, 'task.create': { projectRoot: a, title: 't' },
  'task.update': { projectRoot: a, id: 't-a000', action: 'close' }, 'task.gate.resolve': { projectRoot: a, id: 't-a000', gate: 'review' },
  'library.save': { kind: 'skills', scope: 'project', projectRoot: a, name: 'writer', content: { body: 'text' } },
  'library.delete': { kind: 'skills', scope: 'project', projectRoot: a, name: 'writer' },
  'library.duplicate': { kind: 'skills', scope: 'project', projectRoot: a, from: 'writer', to: 'copy' },
  'library.rename': { kind: 'skills', scope: 'project', projectRoot: a, from: 'writer', to: 'copy' },
  'library.list': { kind: 'agents', projectRoot: a }, 'library.get': { kind: 'mcp', name: 'x', projectRoot: a },
});

const LOOKUPS = new Set(['session.get', 'question.list', 'session.list']);
const exposed = Object.entries(EXPOSURE).filter(([, entry]) => entry.status === 'exposed').map(([method]) => method);

test('every v1 method is classified, and every exposed one has a permission, params and scope tests', () => {
  assert.deepEqual(unclassified(), [], 'classify new methods in src/policy.js before they can be exposed');
  for (const method of exposed) {
    const entry = EXPOSURE[method];
    assert.ok(entry.permission && Array.isArray(entry.params) && entry.tests?.length, method);
    assert.ok(Object.hasOwn(OUT_OF_SCOPE, method), `${method} needs an out-of-scope case here`);
  }
  assert.deepEqual(Object.keys(OUT_OF_SCOPE).sort(), [...exposed].sort());
  assert.deepEqual(Object.keys(IN_SCOPE({ a: '/x' })).sort(), [...exposed].sort());
});

// The daemon's own annotations (x-alp, added by Task 09B-1) must agree with what the gateway
// exposes: nothing host-level that writes, nothing administrative, no connection-level mutation.
// Skipped where the schema has no annotations yet.
test('the exposure matrix agrees with the daemon\'s x-alp annotations', t => {
  const annotated = Object.entries(METHODS_V1.methods).filter(([, entry]) => entry['x-alp']);
  if (!annotated.length) return t.skip('this schema has no x-alp annotations');
  // Deliberate differences: session.release detaches this client and may close an idle root nobody
  // watches, which a reader's disconnect does as well.
  // session.attention.clear acknowledges a turn end for every viewer, as a reader's look at it does.
  const readerMutations = new Set(['session.release', 'session.attention.clear']);
  // session.create's exec risk (spec.env, stdio spec.mcpServers) is removed by the spec allow-list,
  // which 'session.create: spec fields are allow-listed' below proves.
  // Host-level reads the gateway exposes on purpose: static catalogues and the user's language.
  const hostReads = new Set(['catalog.get', 'library.models', 'settings.language.get']);
  for (const [method, entry] of annotated) {
    const { effect, scope, risks = [] } = entry['x-alp'];
    const exposure = EXPOSURE[method];
    assert.ok(exposure, `${method} is annotated but not classified in src/policy.js`);
    if (exposure.status !== 'exposed') continue;
    assert.ok(scope?.kind !== 'host' || (effect === 'query' && hostReads.has(method)), `${method}: host-level ${effect} exposed`);
    assert.ok(scope?.kind !== 'library-or-project' || exposure.permission === 'library.write', `${method}: can write the host library`);
    assert.ok(!(scope?.kind === 'connection' && effect === 'mutation'), `${method}: a connection-level mutation is exposed`);
    // A risk the gateway removes itself is allowed, with the test that proves it.
    // Terminals execute on purpose (the user's decision of 2026-10-20, issue #121 H): only with the
    // opt-in terminal.exec, which nothing implies, and the host owner's own switch.
    const mitigated = method.startsWith('library.') && exposure.permission === 'library.write' ? /^exec-config/ : method.startsWith('terminal.') && exposure.permission === 'terminal.exec' ? /execution|runs any command/ : { 'session.create': /^exec: spec\.env and stdio spec\.mcpServers/ }[method];
    assert.ok(!risks.some(risk => /admin|exec/.test(risk) && !mitigated?.test(risk)), `${method}: an administrative or code-executing method is exposed`);
    if (effect === 'mutation' && !readerMutations.has(method)) assert.match(exposure.permission ?? '', /(?:\.write$|^workspace\.manage$|^terminal\.exec$)/, `${method} writes and needs a write permission`);
    // The resource the daemon names is the one the gateway checks.
    if (scope?.param === 'projectRoot') assert.ok(exposure.params?.includes('projectRoot'), `${method} forwards projectRoot`);
    if (scope?.param === 'sessionId') assert.ok(exposure.params?.includes('sessionId'), `${method} forwards sessionId`);
  }
});

test('methods not exposed answer -32601 and never reach alpd: host, administration, library writes and unknown methods', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('alice');
  const refused = [...Object.entries(EXPOSURE).filter(([, entry]) => entry.status === 'denied' || entry.status === 'prohibited').map(([method]) => method), 'subscribe', 'provider.list'];
  const mark = daemon.calls().length;
  for (const method of refused) {
    const params = method === 'extension.register' ? { method: 'x.y' } : method === 'assignment.recall' ? { question: 'q' } : {};
    await assert.rejects(client.request(method, params), error => error.code === -32601, method);
  }
  assert.deepEqual(daemon.calls().slice(mark), [], 'nothing reached alpd');
});

test('a credential gets 1003 grant for every method its permissions do not cover, with no effect', async t => {
  const env = await world(t);
  const { daemon, sdk } = env;
  const valid = IN_SCOPE(env);
  for (const [label, held] of [['reader', ['session.read']], ['sessions', ['session.read', 'session.write']]]) {
    let { client } = await sdk(label);
    let sent = 0;
    for (const method of exposed.filter(name => !held.includes(EXPOSURE[name].permission))) {
      // One connection per batch: the rate limit is per connection.
      if (++sent % 30 === 0) ({ client } = await sdk(label));
      const mark = daemon.calls().length;
      await assert.rejects(client.request(method, valid[method]), error => error.code === 1003 && error.data?.reason === 'grant' && error.data.permission === EXPOSURE[method].permission, `${label} ${method}`);
      assert.deepEqual(daemon.calls().slice(mark), [], `${label} ${method} reached alpd`);
    }
    // What the grant covers still works.
    assert.equal((await client.request('session.get', { sessionId: 'sa' })).session.id, 'sa');
  }
});

test('every exposed method refuses resources outside the grant before alpd sees the method', async t => {
  const env = await world(t);
  const { daemon, sdk } = env;
  const { client } = await sdk('alice');
  for (const method of exposed) {
    const make = OUT_OF_SCOPE[method];
    if (!make) continue;
    const [params, code, reason] = make(env);
    const mark = daemon.calls().length;
    await assert.rejects(client.request(method, params), error => error.code === code && (reason === undefined || error.data?.reason === reason), `${method} ${JSON.stringify(params)}`);
    // The gateway's own lookups use session.get, question.list and session.list; the method under test must not run.
    if (!LOOKUPS.has(method)) assert.deepEqual(reached(daemon, mark, method), [], `${method} reached alpd`);
  }
});

test('in-scope calls work, with paths named either way, and unknown params never reach alpd', async t => {
  const { daemon, sdk, a, canonicalA } = await world(t);
  const { client } = await sdk('alice');
  assert.equal((await client.request('session.get', { sessionId: 'sa-c' })).session.id, 'sa-c');
  assert.deepEqual((await client.request('board.list', { projectRoot: a })).pins, []);
  assert.deepEqual((await client.request('board.list', { projectRoot: canonicalA })).pins, []);
  await client.request('session.close', { sessionId: 'sa', force: true, sessionIds: ['sb'] });
  assert.deepEqual(daemon.calls('session.close').at(-1).params, { sessionId: 'sa' });
  // A path the grant does not list exactly, even one inside the workspace or naming it another way, is refused.
  for (const cwd of [path.join(a, 'sub'), `${a}/`, `${a}/../${path.basename(a)}`]) {
    await assert.rejects(client.request('session.preview', { spec: { cwd } }), error => error.code === 1003, cwd);
  }
});

test('lists keep only what the grant covers', async t => {
  const { sdk, a } = await world(t);
  const { client } = await sdk('alice');
  const { sessions } = await client.request('session.list', { includeClosed: true });
  assert.deepEqual(sessions.map(session => session.id).sort(), ['ro', 'sa', 'sa-c']);
  const named = await client.request('session.list', { projectRoot: a, includeClosed: true });
  assert.deepEqual(named.sessions.map(session => session.id).sort(), ['ro', 'sa', 'sa-c']);
  const { questions } = await client.request('question.list');
  assert.deepEqual(questions.map(question => question.id), ['q-a-111']);
});

test('session.list pages: alpd lists the granted workspaces only, reads on past rows the grant drops, and cursors are sealed', async t => {
  const { daemon, sdk, a, canonicalA } = await world(t);
  const { client } = await sdk('alice');
  const mark = daemon.calls().length;
  const first = await client.request('session.list', { limit: 2 });
  assert.deepEqual(first.sessions.map(row => row.id), ['sa', 'sa-c']);
  // The cursor is the gateway's own: alpd's ('@2' here) never reaches the client.
  assert.match(first.nextCursor, /^g1\./);
  assert.ok(!first.nextCursor.includes('@2'));
  // alpd's next page is mix (in a, but in b's tree: dropped) and ro: the gateway reads on.
  const second = await client.request('session.list', { limit: 1, cursor: first.nextCursor });
  assert.deepEqual([second.sessions.map(row => row.id), second.nextCursor], [['ro'], undefined]);
  const sent = reached(daemon, mark, 'session.list').map(call => call.params);
  assert.deepEqual(sent.map(params => [params.limit, params.cursor]), [[2, undefined], [1, '@2'], [1, '@3']]);
  for (const params of sent) assert.deepEqual([...params.projectRoots].sort(), [...new Set([a, canonicalA])].sort(), 'only the grant\'s workspaces');
  // A cursor whose last alpd row was dropped names nothing the client can read.
  const dropped = await client.request('session.list', { limit: 1, cursor: (await client.request('session.list', { limit: 2 })).nextCursor });
  assert.equal(dropped.sessions[0].id, 'ro');
  // A cursor the gateway did not give, or gave another credential, is refused before alpd.
  const before = daemon.calls('session.list').length;
  await assert.rejects(client.request('session.list', { limit: 1, cursor: '@4' }), error => error.code === -32602);
  await assert.rejects(client.request('session.list', { limit: 1, cursor: `${first.nextCursor.slice(0, -2)}AA` }), error => error.code === -32602);
  const other = (await sdk('both')).client;
  await assert.rejects(other.request('session.list', { limit: 1, cursor: first.nextCursor }), error => error.code === -32602);
  assert.equal(daemon.calls('session.list').length, before);
  // A query is passed on; the client's projectRoot narrows projectRoots and is not sent itself.
  const named = await client.request('session.list', { projectRoot: canonicalA, limit: 1, query: 'sa' });
  assert.deepEqual(named.sessions.map(row => row.id), ['sa']);
  const last = daemon.calls('session.list').at(-1).params;
  assert.deepEqual([last.limit, last.query, last.projectRoot], [1, 'sa', undefined]);
  // A query naming a session outside the grant finds nothing of it, even paged.
  for (const query of ['sb', 'sb-c', 'mix']) {
    const found = await client.request('session.list', { query, limit: 1 });
    assert.deepEqual([found.sessions, found.nextCursor], [[], undefined], query);
  }
  // The grant of two workspaces lists both.
  assert.deepEqual((await other.request('session.list', {})).sessions.map(row => row.id).sort(), ['mix', 'ro', 'sa', 'sa-c', 'sb', 'sb-c'], 'mix too: its tree is in b');
});

test('session.list for a grant too large to name to alpd: the whole list, searched by the gateway, never alpd\'s query', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-many-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspaces = [];
  for (let i = 0; i < 1030; i++) { const workspace = path.join(directory, `w${i}`); await mkdir(workspace); workspaces.push(workspace); }
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  const first = await realpath(workspaces[0]);
  const daemon = fakeDaemon({ sessions: [summary('in-1', first, { title: 'Fix login' }), summary('in-2', first, { title: 'Docs' }), summary('out-1', outside, { title: 'Fix secret' })] });
  const { sdk } = await startGateway(t, { daemon, credentials: { many: { workspaces } } });
  const { client } = await sdk('many');
  const found = await client.request('session.list', { limit: 1, query: 'fix' });
  assert.deepEqual([found.sessions.map(row => row.id), found.nextCursor], [['in-1'], undefined]);
  const sent = daemon.calls('session.list').at(-1).params;
  assert.deepEqual([sent.query, sent.limit, sent.cursor, sent.projectRoots], [undefined, undefined, undefined, undefined], 'nothing alpd would match or page across the host');
  assert.deepEqual((await client.request('session.list', { limit: 1 })).sessions.map(row => row.id).sort(), ['in-1', 'in-2']);
});

test('question.watch: the list and the events stay in the grant, and in the workspace it names', async t => {
  const { daemon, sdk, a } = await world(t);
  const question = (id, sessionId, rootId) => ({ type: 'question', question: { id, sessionId, rootId, agent: 'main', body: `${id}?`, askedAt: '2026-10-15T00:00:00.000Z' } });
  const { client } = await sdk('alice');
  assert.ok((await client.request('daemon.hello', { protocolVersion: 1 })).capabilities.includes('question.watch'));
  const seen = [];
  client.onEvent(envelope => seen.push([envelope.sessionId, envelope.event.type, envelope.cursor]));
  const listed = await client.request('question.watch', { projectRoot: a });
  assert.deepEqual(listed.questions.map(q => q.id), ['q-a-111']);
  assert.deepEqual(daemon.calls('question.watch').at(-1).params, {}, 'alpd is asked for every tree');
  daemon.emit('sb', question('q-b-1', 'sb', 'sb'));
  daemon.emit('mix', question('q-mix', 'mix', 'sb'));
  daemon.emit('sa-c', question('q-a-1', 'sa-c', 'sa'));
  daemon.emit('sa-c', { type: 'question.resolved', questionId: 'q-a-1', outcome: 'answered' });
  await until(() => seen.some(([, type]) => type === 'question.resolved'), 'the resolution');
  assert.deepEqual(seen, [['sa-c', 'question', undefined], ['sa-c', 'question.resolved', undefined]]);
  // A session found outside the grant is not looked up again for its next question.
  const lookups = () => daemon.calls('session.get').filter(call => call.params.sessionId === 'sb').length;
  const looked = lookups();
  daemon.emit('sb', question('q-b-1b', 'sb', 'sb'));
  daemon.emit('sa-c', question('q-a-3', 'sa-c', 'sa'));
  await until(() => seen.length === 3, 'the next question of a');
  assert.equal(lookups(), looked);

  // A grant of two workspaces watching one: the other's questions only once it attaches there.
  const both = (await sdk('both')).client;
  const heard = [];
  both.onEvent(envelope => heard.push([envelope.sessionId, envelope.event.type, envelope.cursor !== undefined]));
  assert.deepEqual((await both.request('question.watch', { projectRoot: a })).questions.map(q => q.id), ['q-a-111']);
  daemon.emit('sb', question('q-b-2', 'sb', 'sb'));
  daemon.emit('sa', question('q-a-2', 'sa', 'sa'));
  await until(() => heard.length === 1, 'the question of a');
  await both.request('session.attach', { sessionId: 'sb', replay: false });
  daemon.emit('sb', question('q-b-3', 'sb', 'sb'));
  await until(() => heard.length === 2, 'the question of the attached tree');
  // Watching every workspace of the grant.
  await both.request('question.watch', {});
  daemon.emit('sb-c', { type: 'question.resolved', questionId: 'q-b-3', outcome: 'answered' });
  await both.request('session.release', { sessionId: 'sb' });
  daemon.emit('sb', question('q-b-4', 'sb', 'sb'));
  await until(() => heard.length === 4, 'every workspace');
  assert.deepEqual(heard, [['sa', 'question', false], ['sb', 'question', true], ['sb-c', 'question.resolved', true], ['sb', 'question', false]]);
});

test('question.watch with turns: roots\' turn ends of the grant, of the workspace named, and only when asked', async t => {
  const { daemon, sdk, a, b } = await world(t);
  const ended = state => ({ type: 'turn.ended', turnId: 't1', state });
  const both = (await sdk('both')).client;
  assert.ok((await both.request('daemon.hello', { protocolVersion: 1 })).capabilities.includes('question.watch.turns'));
  const heard = [];
  both.onEvent(envelope => heard.push([envelope.sessionId, envelope.event.type, envelope.event.state, envelope.cursor !== undefined]));
  // Without turns: no turn ends.
  await both.request('question.watch', { projectRoot: a });
  assert.deepEqual(daemon.calls('question.watch').at(-1).params, {});
  daemon.emit('sa', ended('completed'));
  // With turns, of workspace a: alpd is asked for every tree, the gateway keeps a's.
  await both.request('question.watch', { projectRoot: a, turns: true });
  assert.deepEqual(daemon.calls('question.watch').at(-1).params, { turns: true }, 'turns and nothing else reach alpd');
  daemon.emit('sb', ended('completed'));
  daemon.emit('sa', ended('failed'));
  await until(() => heard.length === 1, 'the turn end of a');
  // Every workspace of the grant.
  await both.request('question.watch', { projectRoot: undefined, turns: true });
  daemon.emit('sb', ended('completed'));
  await until(() => heard.length === 2, 'the turn end of b');
  assert.deepEqual(heard, [['sa', 'turn.ended', 'failed', false], ['sb', 'turn.ended', 'completed', false]]);
  // A grant of a only never hears b's, nor of a tree mixing workspaces.
  const alice = (await sdk('alice')).client;
  const got = [];
  alice.onEvent(envelope => got.push([envelope.sessionId, envelope.event.state]));
  await alice.request('question.watch', { turns: true });
  daemon.emit('sb', ended('completed'));
  daemon.emit('mix', ended('completed'));
  daemon.emit('sa', ended('canceled'));
  await until(() => got.length === 1, 'the turn end of a');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(got, [['sa', 'canceled']]);
  void b;
});

test('session.attention: question.watch answers and tells the grant\'s attention only, cleared by a reader', async t => {
  const { daemon, sdk, a } = await world(t);
  const at = '2026-10-20T00:00:00.000Z';
  daemon.state.sessions.get('sa').attention = { reason: 'error', at, turnId: 't1', message: `failed in ${a}/src` };
  daemon.state.sessions.get('sb').attention = { reason: 'finished', at };
  daemon.state.sessions.get('mix').attention = { reason: 'finished', at };
  const { client } = await sdk('reader');
  assert.ok((await client.request('daemon.hello', { protocolVersion: 1 })).capabilities.includes('session.attention'));
  const heard = [];
  client.onEvent(envelope => heard.push([envelope.sessionId, envelope.event.type, envelope.event.attention?.reason ?? null, envelope.cursor !== undefined]));
  // Without attention: alpd is not asked for it, and nothing is answered.
  assert.equal((await client.request('question.watch', { projectRoot: a })).attention, undefined);
  assert.deepEqual(daemon.calls('question.watch').at(-1).params, {});
  const watched = await client.request('question.watch', { projectRoot: a, attention: true });
  assert.deepEqual(daemon.calls('question.watch').at(-1).params, { attention: true }, 'attention and nothing else reach alpd');
  assert.deepEqual(watched.attention.map(entry => [entry.sessionId, entry.attention.reason]), [['sa', 'error']], 'only the grant\'s, of the workspace named');
  assert.ok(!watched.attention[0].attention.message.includes(a), 'a host path in the message is hidden as in turn.ended');
  daemon.emit('sb', { type: 'attention', attention: { reason: 'finished', at } });
  daemon.emit('mix', { type: 'attention', attention: { reason: 'finished', at } });
  daemon.emit('sa', { type: 'attention', attention: { reason: 'finished', at } });
  await until(() => heard.length === 1, 'the attention of a');
  // A reader acknowledges it: its look clears it for every client.
  assert.deepEqual(await client.request('session.attention.clear', { sessionId: 'sa', at }), { cleared: true });
  await until(() => heard.length === 2, 'the clearing');
  await assert.rejects(client.request('session.attention.clear', { sessionId: 'sb' }), error => error.code === 1001);
  assert.equal(daemon.state.sessions.get('sb').attention.reason, 'finished', 'outside the grant: untouched');
  assert.deepEqual(heard, [['sa', 'attention', 'finished', false], ['sa', 'attention', null, false]]);
  // The allow-list stays exact: unknown params never reach alpd, an unknown method nowhere.
  await client.request('question.watch', { projectRoot: a, attention: true, turns: false, everything: true, sessionId: 'sb' });
  assert.deepEqual(daemon.calls('question.watch').at(-1).params, { attention: true });
  await client.request('session.attention.clear', { sessionId: 'sa', at, force: true, sessionIds: ['sb'] });
  assert.deepEqual(daemon.calls('session.attention.clear').at(-1).params, { sessionId: 'sa', at });
  const mark = daemon.calls().length;
  for (const method of ['session.attention.set', 'session.attention', 'attention.clear']) await assert.rejects(client.request(method, { sessionId: 'sa' }), error => error.code === -32601, method);
  assert.deepEqual(daemon.calls().slice(mark), [], 'nothing reached alpd');
});

test('session.attention through a gateway to an alpd without it: not offered, and the watch works as before', async t => {
  const daemon = fakeDaemon({ capabilities: ['question.watch', 'question.watch.turns'], sessions: [summary('sa', process.cwd(), { attention: { reason: 'finished', at: '2026-10-20T00:00:00.000Z' } })] });
  // As an alpd before session.attention: it ignores the param it does not know and has no such method.
  daemon.state.handlers['question.watch'] = () => ({ questions: [] });
  daemon.state.handlers['session.attention.clear'] = () => { throw { code: -32601, message: 'Unknown method session.attention.clear' }; };
  const { sdk } = await startGateway(t, { daemon, credentials: { reader: { workspaces: [process.cwd()], permissions: ['session.read'] } } });
  const { client } = await sdk('reader');
  assert.ok(!(await client.request('daemon.hello', { protocolVersion: 1 })).capabilities.includes('session.attention'));
  assert.deepEqual(await client.request('question.watch', { attention: true }), { questions: [] });
  await assert.rejects(client.request('session.attention.clear', { sessionId: 'sa' }), error => error.code === -32601);
});

test('workspace.files.search: a granted workspace only, sent as its canonical path, needing project.read, answered paths kept relative', async t => {
  const { daemon, sdk, a, b, canonicalA } = await world(t);
  daemon.state.files.set(canonicalA, ['src/server.ts', '/etc/passwd', '../b/secret.txt', 'src/../../x', 'C:/Windows/win.ini', '', 'a//b', './README.md', 'docs/sửa lỗi.md', 'nul\u0000.txt']);
  daemon.state.files.set(b, ['b-only.txt']);
  const { client } = await sdk('alice');
  assert.ok((await client.request('daemon.hello', { protocolVersion: 1 })).capabilities.includes('workspace.files'));
  const found = await client.request('workspace.files.search', { projectRoot: a, query: 'server', limit: 50, extra: 'dropped' });
  assert.deepEqual(found, { files: [{ path: 'src/server.ts' }, { path: 'docs/sửa lỗi.md' }] }, 'only plainly relative paths');
  assert.deepEqual(daemon.calls('workspace.files.search').at(-1).params, { projectRoot: canonicalA, query: 'server', limit: 50 }, 'the canonical path, no unknown params');
  const mark = daemon.calls().length;
  for (const projectRoot of [b, path.join(a, 'src'), `${a}/`, `${a}/../a`, '/', 'relative']) {
    await assert.rejects(client.request('workspace.files.search', { projectRoot }), error => error.code === 1003 && error.data?.reason === 'outside_workspace', projectRoot);
  }
  const { client: reader } = await sdk('reader');
  await assert.rejects(reader.request('workspace.files.search', { projectRoot: a }), error => error.code === 1003 && error.data?.reason === 'grant');
  assert.deepEqual(reached(daemon, mark, 'workspace.files.search'), [], 'no refused search reached alpd');
});

test('workspace.files.list and read: files.read only, never a default; canonical workspace; blocked or non-relative paths refused before alpd; answers kept to the request', async t => {
  const { daemon, sdk, a, canonicalA } = await world(t);
  let { client } = await sdk('alice');
  assert.ok((await client.request('daemon.hello', { protocolVersion: 1 })).capabilities.includes('workspace.files.read'));
  daemon.state.handlers['workspace.files.list'] = ({ path: directory }) => ({
    entries: [
      { name: 'server.ts', path: directory ? `${directory}/server.ts` : 'server.ts', kind: 'file', size: 3, modifiedAt: '2026-10-17T00:00:00.000Z', inode: 42, host: '/etc' },
      { name: 'deep', path: directory ? `${directory}/deep` : 'deep', kind: 'directory' },
      // Planted by a faulty alpd: other directories, blocked names, links, absolute paths, bad kinds.
      { name: 'x.ts', path: 'elsewhere/x.ts', kind: 'file' },
      { name: '.env', path: directory ? `${directory}/.env` : '.env', kind: 'file' },
      { name: 'id_rsa', path: directory ? `${directory}/id_rsa` : 'id_rsa', kind: 'file' },
      { name: 'link', path: directory ? `${directory}/link` : 'link', kind: 'link' },
      { name: '../up', path: '../up', kind: 'file' },
      { name: '/etc', path: '/etc', kind: 'directory' },
      { name: 'a/b', path: directory ? `${directory}/a/b` : 'a/b', kind: 'file' },
    ],
    truncated: true,
  });
  const listed = await client.request('workspace.files.list', { projectRoot: a, path: 'src', includeIgnored: true, extra: 'dropped' });
  assert.deepEqual(listed, { entries: [{ name: 'server.ts', path: 'src/server.ts', kind: 'file', size: 3, modifiedAt: '2026-10-17T00:00:00.000Z' }, { name: 'deep', path: 'src/deep', kind: 'directory' }], truncated: true });
  assert.deepEqual(daemon.calls('workspace.files.list').at(-1).params, { projectRoot: canonicalA, path: 'src', includeIgnored: true }, 'the canonical path, no unknown params');
  assert.deepEqual((await client.request('workspace.files.list', { projectRoot: a })).entries.map(entry => entry.path), ['server.ts', 'deep']);
  daemon.state.handlers['workspace.files.read'] = ({ path: file }) => ({ path: file, content: 'export {};\n', size: 11, modifiedAt: '2026-10-17T00:00:00.000Z', revision: '1:2:3' });
  assert.deepEqual(await client.request('workspace.files.read', { projectRoot: a, path: 'src/server.ts' }), { path: 'src/server.ts', content: 'export {};\n', size: 11, modifiedAt: '2026-10-17T00:00:00.000Z' });
  assert.deepEqual(daemon.calls('workspace.files.read').at(-1).params, { projectRoot: canonicalA, path: 'src/server.ts' });

  // Refused by the gateway itself, before alpd sees the method (one connection per batch: the rate limit is per connection).
  const mark = daemon.calls().length;
  ({ client } = await sdk('alice'));
  for (const file of ['.env', 'config/.env.local', '.git/config', 'sub/.GIT/HEAD', '.alp/mcp/docs.json', 'id_ed25519', 'certs/tls.key', 'server.PEM', 'credentials.json', '.npmrc', '.aws/credentials']) {
    await assert.rejects(client.request('workspace.files.read', { projectRoot: a, path: file }), error => error.code === 1003 && error.data?.reason === 'blocked_path' && !error.message.includes(a), file);
    await assert.rejects(client.request('workspace.files.list', { projectRoot: a, path: file }), error => error.code === 1003 && error.data?.reason === 'blocked_path', file);
  }
  ({ client } = await sdk('alice'));
  for (const file of ['/etc/passwd', '../b/x', 'src/../../x', './x', 'a//b', 'C:/x', 'a\\b', 'src/']) {
    await assert.rejects(client.request('workspace.files.read', { projectRoot: a, path: file }), error => error.code === -32602 && error.data?.reason === 'invalid_path', file);
  }
  await assert.rejects(client.request('workspace.files.read', { projectRoot: a, path: '' }), error => error.code === -32602, 'an empty path fails the schema');
  await assert.rejects(client.request('workspace.files.read', { projectRoot: `${a}/`, path: 'x' }), error => error.code === 1003 && error.data?.reason === 'outside_workspace');
  // Without files.read: the default credentials (session and project permissions) are refused.
  for (const label of ['both', 'reader', 'sessions']) {
    const { client: other } = await sdk(label);
    for (const [method, params] of [['workspace.files.list', { projectRoot: a }], ['workspace.files.read', { projectRoot: a, path: 'README.md' }]]) {
      await assert.rejects(other.request(method, params), error => error.code === 1003 && error.data?.reason === 'grant' && error.data.permission === 'files.read', `${label} ${method}`);
    }
  }
  assert.deepEqual(daemon.calls().slice(mark).filter(call => call.method.startsWith('workspace.files.')), [], 'no refused call reached alpd');

  // An answer for another file, or over the limit, is refused.
  ({ client } = await sdk('alice'));
  daemon.state.handlers['workspace.files.read'] = () => ({ path: 'other.txt', content: 'SENTINEL', size: 8 });
  await assert.rejects(client.request('workspace.files.read', { projectRoot: a, path: 'x.txt' }), error => error.code === 1000 && !error.message.includes('SENTINEL'));
  daemon.state.handlers['workspace.files.read'] = ({ path: file }) => ({ path: file, content: 'é'.repeat(512 * 1024 + 1), size: 1 });
  await assert.rejects(client.request('workspace.files.read', { projectRoot: a, path: 'x.txt' }), error => error.code === 1000);
  // alpd's refusals: code and reason pass, the message is the gateway's fixed text (no host path, no quote).
  ({ client } = await sdk('alice'));
  for (const reason of ['ignored', 'linked', 'not_found', 'binary', 'too_large', 'not_directory', 'unreadable', 'something_new']) {
    daemon.state.handlers['workspace.files.read'] = () => { throw { code: reason === 'binary' || reason === 'too_large' ? 1000 : 1003, message: `${canonicalA}/secret.txt: SENTINEL quote`, data: { reason, file: `${canonicalA}/secret.txt` } }; };
    const caught = await client.request('workspace.files.read', { projectRoot: a, path: 'x.txt' }).then(() => assert.fail(reason), failure => failure);
    assert.equal(caught.data?.reason, reason);
    assert.ok(!caught.message.includes(canonicalA) && !caught.message.includes('SENTINEL') && !JSON.stringify(caught.data).includes(canonicalA), `${reason}: ${caught.message}`);
    daemon.state.handlers['workspace.files.list'] = daemon.state.handlers['workspace.files.read'];
    const listed = await client.request('workspace.files.list', { projectRoot: a }).then(() => assert.fail(reason), failure => failure);
    assert.ok(!listed.message.includes(canonicalA) && !listed.message.includes('SENTINEL'), `${reason}: ${listed.message}`);
  }
  // A raw failure (no code): the gateway's own generic text.
  ({ client } = await sdk('alice'));
  daemon.state.handlers['workspace.files.read'] = () => { throw new Error(`EACCES: ${canonicalA}/x.txt`); };
  await assert.rejects(client.request('workspace.files.read', { projectRoot: a, path: 'x.txt' }), failure => !failure.message.includes(canonicalA));
});

test('question.answer needs an exact id in scope: a prefix that alpd would expand is refused', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('alice');
  await assert.rejects(client.request('question.answer', { questionId: 'q-', text: 'x' }), error => error.code === 1001);
  await assert.rejects(client.request('question.answer', { questionId: 'q-a', text: 'x' }), error => error.code === 1001);
  assert.deepEqual(daemon.calls('question.answer'), []);
  assert.equal((await client.request('question.answer', { questionId: 'q-a-111', text: 'yes' })).questionId, 'q-a-111');
});

test('session.create: spec fields are allow-listed, cwd is sent as the canonical workspace, and the gateway names new roots', async t => {
  const { daemon, sdk, a, canonicalA } = await world(t);
  const { client } = await sdk('alice');
  const events = [];
  client.onEvent(envelope => events.push(envelope));
  for (const field of ['env', 'mcpServers', 'workdir', 'writeRoot', 'copy', 'copyOf', 'restore', 'systemPrompt', 'keepThread']) {
    await assert.rejects(client.request('session.create', { spec: { cwd: a, [field]: field === 'env' || field === 'restore' ? { X: '1' } : 'x' } }), error => error.code === 1003 && error.data?.reason === 'spec_field' && error.data.field === field, field);
    await assert.rejects(client.request('session.preview', { spec: { cwd: a, [field]: field === 'restore' ? {} : 'x' } }), error => error.code === 1003 && error.data?.reason === 'spec_field', field);
  }
  for (const agent of ['../x', 'a/b', '..', '']) {
    await assert.rejects(client.request('session.create', { spec: { cwd: a, agent } }), error => error.code === 1003 && error.data?.field === 'agent', agent);
    // A team is named the same way: a plain name the daemon host resolves.
    await assert.rejects(client.request('session.create', { spec: { cwd: a, workflow: agent } }), error => error.code === 1003 && error.data?.field === 'workflow', `workflow ${agent}`);
  }
  assert.deepEqual(daemon.calls('session.create'), []);
  const { session } = await client.request('session.create', { spec: { cwd: a, model: 'codex:gpt', workflow: 'cafe' } });
  const sent = daemon.calls('session.create')[0].params;
  assert.equal(sent.spec.workflow, 'cafe', 'the team Paseo picked reaches alpd');
  assert.match(sent.sessionId, /^ses_[a-f0-9]{16}$/);
  assert.equal(sent.spec.cwd, canonicalA);
  assert.equal(session.id, sent.sessionId);
  await until(() => events.some(envelope => envelope.sessionId === session.id && envelope.event.type === 'session.ready'), 'events of the new root');
  // Resuming an existing root in scope works; one in another workspace is refused before alpd.
  assert.equal((await client.request('session.create', { sessionId: 'sa', spec: { cwd: a } })).attached, true);
  await assert.rejects(client.request('session.create', { sessionId: 'sb', spec: { cwd: a } }), error => error.code === 1003 && error.data?.reason === 'outside_workspace');
  assert.equal(daemon.calls('session.create').length, 2);
});

test('a created root that turns out to be outside the grant is released and refused', async t => {
  const { daemon, sdk, a, b } = await world(t);
  daemon.state.handlers['session.create'] = ({ sessionId }) => ({ session: summary(sessionId, b), attached: true });
  const { client } = await sdk('alice');
  await assert.rejects(client.request('session.create', { sessionId: 'raced', spec: { cwd: a } }), error => error.code === 1003);
  assert.equal(daemon.calls('session.release').at(-1).params.sessionId, 'raced');
});

test('prompts carry text and inline images only, within the gateway image limits (t-7679.11)', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('alice');
  const prompt = content => client.request('session.prompt', { sessionId: 'sa', clientMessageId: 'm', content });
  for (const part of [{ type: 'file', path: '/etc/passwd' }, { type: 'resource', uri: 'file:///etc/passwd' }, { type: 'localImage', path: '/etc/passwd' }]) {
    await assert.rejects(prompt([part]), error => error.code === 1003 && error.data?.reason === 'content_type');
  }
  // An image is inline base64 of an allowed type and nothing else: no path, URL or other field.
  const png = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  for (const part of [{ type: 'image', data: 'xx' }, { ...png, path: '/etc/passwd' }, { ...png, url: 'file:///etc/passwd' }, { ...png, mimeType: 'image/svg+xml' }, { ...png, data: '../../etc/passwd' }]) {
    await assert.rejects(prompt([part]), error => error.code === -32602);
  }
  const size = bytes => ({ ...png, data: 'A'.repeat(Math.ceil(bytes / 3) * 4) });
  for (const content of [Array.from({ length: 5 }, () => png), [size(2 * 1024 * 1024 + 3)], [size(1.3 * 1024 * 1024), size(1.3 * 1024 * 1024)]]) {
    await assert.rejects(prompt(content), error => error.code === 1003 && error.data?.reason === 'image_limit' && error.data.maxCount === 4);
  }
  assert.deepEqual(daemon.calls('session.prompt'), []);
  assert.equal((await prompt(text)).outcome, 'accepted');
  const images = [{ type: 'text', text: 'see' }, ...Array.from({ length: 4 }, () => png)];
  assert.equal((await client.request('session.prompt', { sessionId: 'sa', clientMessageId: 'm2', content: images })).outcome, 'accepted');
  assert.deepEqual(daemon.calls('session.prompt').at(-1).params.content, images);
});

test('the image limits shrink with a smaller limits.maxFrame, so images that fit are never cut by the frame', () => {
  const MiB = 1024 * 1024;
  assert.deepEqual(promptImageLimits(), { maxCount: 4, maxBytes: 2 * MiB, maxTotalBytes: 2.5 * MiB });
  assert.deepEqual(promptImageLimits(4 * MiB), promptImageLimits());
  assert.deepEqual(promptImageLimits(MiB), { maxCount: 4, maxBytes: 737280, maxTotalBytes: 737280 });
  assert.ok(Math.ceil(737280 / 3) * 4 + 64 * 1024 <= MiB);
  assert.deepEqual(promptImageLimits(1024), { maxCount: 4, maxBytes: 0, maxTotalBytes: 0 });
});

test('a grant limited to some modes cannot create, configure or prompt beyond them', async t => {
  const { daemon, sdk, a } = await world(t, { modes: ['read-only'] });
  const { client } = await sdk('alice');
  await assert.rejects(client.request('session.create', { spec: { cwd: a } }), error => error.data?.reason === 'mode', 'the default mode may be full access');
  await assert.rejects(client.request('session.create', { spec: { cwd: a, mode: 'full-access' } }), error => error.data?.reason === 'mode');
  await assert.rejects(client.request('session.configure', { sessionId: 'ro', mode: 'full-access' }), error => error.data?.reason === 'mode');
  await assert.rejects(client.request('session.prompt', { sessionId: 'sa', clientMessageId: 'm', content: text }), error => error.data?.reason === 'mode', 'sa runs in workspace-write');
  assert.deepEqual([...daemon.calls('session.create'), ...daemon.calls('session.configure'), ...daemon.calls('session.prompt')], []);
  assert.equal((await client.request('session.prompt', { sessionId: 'ro', clientMessageId: 'm', content: text })).outcome, 'accepted');
  assert.equal((await client.request('session.create', { spec: { cwd: a, mode: 'read-only' } })).session.mode, 'read-only');
});

test('events of trees outside the grant never reach the client, and order is kept around scope lookups', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('alice');
  const seen = [];
  client.onEvent(envelope => seen.push(`${envelope.sessionId}:${envelope.event.type}`));
  await client.request('session.attach', { sessionId: 'sa', replay: false });
  // As if alpd delivered another tree on this connection by mistake.
  for (const link of daemon.state.links) link.attached.add('sb');
  daemon.emit('sb', { type: 'session.updated', session: {} });
  daemon.emit('sb-c', { type: 'session.updated', session: {} });
  daemon.emit('sa', { type: 'turn.started', turnId: 't1', origin: 'user' });
  // A child the gateway has not seen yet: looked up, and the events behind it wait.
  daemon.state.sessions.set('sa-new', summary('sa-new', daemon.state.sessions.get('sa').projectRoot, { parentId: 'sa-c' }));
  daemon.emit('sa-new', { type: 'session.updated', session: {} });
  daemon.emit('mix', { type: 'session.updated', session: {} });
  daemon.emit('sa', { type: 'turn.ended', turnId: 't1', state: 'completed' });
  await until(() => seen.includes('sa:turn.ended'), 'the last event');
  assert.deepEqual(seen, ['sa:turn.started', 'sa-new:session.updated', 'sa:turn.ended']);
});

test('replay before the attach answer stays before it', async t => {
  const { daemon, rawSession } = await world(t);
  for (let i = 0; i < 5; i++) daemon.emit('sa', { type: 'item', item: { id: `i${i}`, kind: 'agent_message', text: 'x' } });
  const { call, frames } = await rawSession('alice');
  await call('daemon.hello', { protocolVersion: 1 });
  const answer = await call('session.attach', { sessionId: 'sa', after: 2 });
  assert.equal(answer.result.cursor, 5);
  const index = frames.findIndex(frame => frame.id === answer.id);
  assert.deepEqual(frames.slice(0, index).filter(frame => frame.method === 'event').map(frame => frame.params.cursor), [3, 4, 5]);
});

test('project resources: tasks and teams of a granted workspace, identity params dropped, host scope refused', async t => {
  const { daemon, sdk, a, canonicalA } = await world(t);
  const { client } = await sdk('alice');
  const { id } = await client.request('task.create', { projectRoot: a, title: 'ship it', by: 'mallory', requestId: 'r1' });
  assert.deepEqual(daemon.calls('task.create').at(-1).params, { projectRoot: a, title: 'ship it', requestId: 'r1' }, 'no identity reaches alpd');
  assert.deepEqual((await client.request('task.list', { projectRoot: a })).tasks.map(task => task.id), [id]);
  // Only where the temp directory sits behind a symlink (macOS /tmp → /private/tmp) are they two names.
  if (canonicalA !== a) assert.deepEqual((await client.request('task.list', { projectRoot: canonicalA })).tasks, [], 'the canonical name is another project string to alpd');
  assert.equal((await client.request('task.update', { projectRoot: a, id, action: 'close' })).status, 'closed');
  assert.ok((await client.request('team.list', { projectRoot: a })).teams.length);
  assert.ok((await client.request('library.list', { kind: 'agents', projectRoot: a })).entries.length);
  assert.equal((await client.request('settings.language.get')).applies, 'English');
  assert.ok((await client.request('library.models')).models.length);
  // Host-level data and paths the grant does not list exactly are refused before alpd.
  const mark = daemon.calls().length;
  for (const [method, params] of [
    ['team.list', {}], ['library.list', { kind: 'mcp' }], ['library.get', { kind: 'mcp', name: 'x' }], ['library.get', { kind: 'providers', name: 'x', scope: 'library' }],
  ]) {
    await assert.rejects(client.request(method, params), error => error.code === 1003 && error.data?.reason === 'host_scope', `${method} ${JSON.stringify(params)}`);
  }
  for (const projectRoot of [path.join(a, 'sub'), `${a}/`, path.dirname(a)]) {
    await assert.rejects(client.request('task.create', { projectRoot, title: 'x' }), error => error.code === 1003 && error.data?.reason === 'outside_workspace', projectRoot);
  }
  assert.deepEqual(daemon.calls().slice(mark), []);
});

// Library entries configure commands alpd runs on the daemon host: MCP servers (URLs that may hold
// a token, args, env, headers), hooks (shell commands), providers (args, env, params). library.get
// is read only through the gateway, under project.read like library.list, and its content leaves
// through projectLibraryContent (docs/alp/remote-gateway.md §5.4, §10): listed fields only, every
// field that can hold a secret answered as a marker. library.save and the other writes stay -32601.
const S = tag => `SENTINEL-${tag}`;
const MARK = { $secret: 'keep' };
const STORED = {
  agents: { instructions: '# Writer\nWrite notes.', config: { $schema: S('schema'), description: 'notes', provider: 'claude', model: 'claude-sonnet-5-5', thinking: 'medium', mode: 'workspace-write', context: 400000, autocompact: 'auto', skills: ['style'], mcp: ['docs'], hooks: ['tests'], token: S('agent-unknown') } },
  skills: { body: '# Style\nShort sentences.', path: S('skill-path') },
  mcp: { server: { command: 'npx', args: ['-y', `--api-key=${S('mcp-arg')}`], env: { GITHUB_TOKEN: S('mcp-env') }, headers: { Authorization: `Bearer ${S('mcp-header')}` }, url: `https://u:${S('mcp-userinfo')}@mcp.example/s/${S('mcp-path')}?key=${S('mcp-query')}`, cwd: `/home/me/${S('mcp-cwd')}`, extra: S('mcp-unknown') } },
  hooks: { hook: { description: 'tests', event: 'handoff', command: `curl -H "Authorization: Bearer ${S('hook-command')}" https://ci.example`, blocking: true, timeoutSec: 600, match: { agent: 'peer', label: 'web', path: S('hook-match') }, env: S('hook-unknown') } },
  teams: { team: { $schema: S('team-schema'), label: 'Mine', description: 'team', main: 'main', maxPeers: 2, members: { main: { role: 'main', model: 'claude:claude-opus-5-5', thinking: 'high', token: S('member-unknown') }, peer: { role: 'peer' } }, delegation: { main: ['peer'] }, supervisor: { agent: 'supervisor', model: 'claude:claude-opus-5-5', secret: S('supervisor-unknown') }, oracleModels: ['claude:claude-opus-5-5'], oracleThinking: { claude: 'high' }, modelSetup: { mode: 'default', preset: 'claude' }, hidden: S('team-unknown') }, houseRules: 'Be brief.' },
  providers: { provider: { kind: 'acp', label: 'Gemini', description: 'g', command: `env TOKEN=${S('provider-command')} gemini`, args: ['--experimental-acp', `--key=${S('provider-arg')}`], env: { GEMINI_API_KEY: S('provider-env') }, params: { apiKey: S('provider-params') }, models: [{ id: 'gemini-2.5-pro', label: 'Pro', secret: S('model-unknown') }], additionalModels: [], enabled: true } },
};
const SHOWN = {
  agents: { content: { instructions: '# Writer\nWrite notes.', config: { description: 'notes', provider: 'claude', model: 'claude-sonnet-5-5', thinking: 'medium', mode: 'workspace-write', context: 400000, autocompact: 'auto', skills: ['style'], mcp: ['docs'], hooks: ['tests'] } }, secrets: [] },
  skills: { content: { body: '# Style\nShort sentences.' }, secrets: [] },
  mcp: { content: { server: { command: 'npx', args: [MARK, MARK], env: { GITHUB_TOKEN: MARK }, headers: { Authorization: MARK }, url: MARK, cwd: MARK } }, secrets: ['/server/args/0', '/server/args/1', '/server/env/GITHUB_TOKEN', '/server/headers/Authorization', '/server/url', '/server/cwd'] },
  hooks: { content: { hook: { description: 'tests', event: 'handoff', command: MARK, blocking: true, timeoutSec: 600, match: { agent: 'peer', label: 'web' } } }, secrets: ['/hook/command'] },
  teams: { content: { team: { label: 'Mine', description: 'team', main: 'main', maxPeers: 2, oracleModels: ['claude:claude-opus-5-5'], members: { main: { role: 'main', model: 'claude:claude-opus-5-5', thinking: 'high' }, peer: { role: 'peer' } }, delegation: { main: ['peer'] }, oracleThinking: { claude: 'high' }, modelSetup: { mode: 'default', preset: 'claude' }, supervisor: { agent: 'supervisor', model: 'claude:claude-opus-5-5' } }, houseRules: 'Be brief.' }, secrets: [] },
  providers: { content: { provider: { kind: 'acp', label: 'Gemini', description: 'g', enabled: true, command: MARK, args: [MARK, MARK], env: { GEMINI_API_KEY: MARK }, params: MARK, models: [{ id: 'gemini-2.5-pro', label: 'Pro' }], additionalModels: [] } }, secrets: ['/provider/command', '/provider/args/0', '/provider/args/1', '/provider/env/GEMINI_API_KEY', '/provider/params'] },
};

test('projectLibraryContent: listed fields only, every field that can hold a secret marked, for every kind', () => {
  for (const kind of Object.keys(STORED)) {
    const projected = projectLibraryContent(kind, STORED[kind]);
    assert.deepEqual(projected, SHOWN[kind], kind);
    assert.ok(!JSON.stringify(projected).includes('SENTINEL'), `${kind}: ${JSON.stringify(projected)}`);
  }
  // A program name is kept; values of the wrong type are dropped, not passed on.
  assert.deepEqual(projectLibraryContent('mcp', { server: { command: '/usr/local/bin/mcp-docs', url: 42, env: 'x', args: 'y' } }), { content: { server: { command: '/usr/local/bin/mcp-docs', url: MARK } }, secrets: ['/server/url'] });
  assert.deepEqual(projectLibraryContent('teams', { team: { supervisor: false, members: { main: 'x' } } }), { content: { team: { supervisor: false, members: {} } }, secrets: [] });
  assert.deepEqual(projectLibraryContent('agents', { instructions: 7, config: [S('array')] }), { content: {}, secrets: [] });
  // A key that needs escaping in a JSON Pointer.
  assert.deepEqual(projectLibraryContent('mcp', { server: { env: { 'a/b~c': S('escaped') } } }).secrets, ['/server/env/a~1b~0c']);
  // A kind the gateway does not know answers no content at all.
  assert.deepEqual(projectLibraryContent('plugins', { anything: S('unknown-kind') }), { content: {}, secrets: [] });
  assert.deepEqual(projectLibraryContent('mcp', null), { content: {}, secrets: [] });
});

test('library.get: read only under project.read, in a granted workspace, its content redacted for every kind', async t => {
  const { daemon, sdk, a } = await world(t);
  daemon.state.handlers['library.get'] = ({ kind, name }) => ({
    kind, name, source: 'library', overrides: 'builtin', content: structuredClone(STORED[kind]), revision: 'rabc', usedBy: ['agent main'],
    ...(kind === 'agents' ? { librarySkills: ['style'] } : {}), secrets: ['/server/env/GITHUB_TOKEN'],
    path: `/home/me/.alp/${kind}/${name}?${S('result-path')}`, raw: S('result-unknown'),
  });
  const { client } = await sdk('alice');
  for (const kind of Object.keys(STORED)) {
    const answer = await client.request('library.get', { kind, name: 'x', projectRoot: a, scope: 'library', sync: 'known-projects' });
    assert.ok(!JSON.stringify(answer).includes('SENTINEL'), `${kind}: ${JSON.stringify(answer)}`);
    assert.deepEqual(answer, {
      kind, name: 'x', source: 'library', overrides: 'builtin', revision: 'rabc', usedBy: ['agent main'],
      ...(kind === 'agents' ? { librarySkills: ['style'] } : {}), content: SHOWN[kind].content, ...(SHOWN[kind].secrets.length ? { secrets: SHOWN[kind].secrets } : {}),
    }, kind);
    assert.deepEqual(daemon.calls('library.get').at(-1).params, { kind, name: 'x', projectRoot: a, scope: 'library' }, 'listed params only');
  }
  // Executable writes stay closed; host skills.set remains unexposed.
  const mark = daemon.calls().length;
  for (const [method, params] of [
    ['library.save', { kind: 'mcp', name: 'x', scope: 'project', projectRoot: a, content: { server: { command: 'sh' } } }],
    ['library.delete', { kind: 'mcp', name: 'x', scope: 'project', projectRoot: a }],
    ['library.duplicate', { kind: 'mcp', from: 'x', to: 'y', scope: 'project', projectRoot: a }],
    ['library.rename', { kind: 'mcp', from: 'x', to: 'y', scope: 'project', projectRoot: a }],
    ['library.skills.set', { agent: 'main', skills: [] }],
  ]) {
    await assert.rejects(client.request(method, params), error => method === 'library.skills.set' ? error.code === -32601 && error.data?.reason === 'not_exposed' : error.code === 1003 && error.data?.reason === 'library_policy', method);
  }
  assert.deepEqual(daemon.calls().slice(mark), []);
});

// An entry file that does not parse makes alpd answer its host path and V8's quote of the file,
// which may hold a secret: the gateway passes on the code and the reason only.
test('library.get errors from alpd carry no host path or file content to the client', async t => {
  const { daemon, sdk, a } = await world(t);
  const failures = {
    broken: { code: -32602, message: `/home/me/.alp/mcp/broken.json: Unexpected token 'S', ..."env":{"T":${S('error-quote')}"... is not valid JSON`, data: { reason: 'invalid_entry', file: `/home/me/${S('error-data')}` } },
    linked: { code: 1003, message: `/work/a/.alp/mcp/linked.json is a symbolic link to /home/me/${S('error-link')}`, data: { reason: 'unsafe_path' } },
    missing: { code: 1001, message: `No mcp entry 'missing' in the project at /home/me/${S('error-missing')}`, data: { reason: 'not_found' } },
    odd: { code: 1000, message: S('error-odd'), data: { reason: `bad ${S('error-reason')}` } },
  };
  daemon.state.handlers['library.get'] = ({ name }) => { throw failures[name]; };
  const { client } = await sdk('alice');
  const seen = [];
  for (const name of Object.keys(failures)) {
    const error = await client.request('library.get', { kind: 'mcp', name, projectRoot: a, scope: 'project' }).then(() => assert.fail(`${name} answered`), failure => failure);
    seen.push({ code: error.code, message: error.message, data: error.data });
  }
  assert.ok(!JSON.stringify(seen).includes('SENTINEL') && !JSON.stringify(seen).includes('/home/me'), JSON.stringify(seen));
  assert.deepEqual(seen, [
    { code: -32602, message: "mcp 'broken' cannot be read on the daemon host", data: { reason: 'invalid_entry' } },
    { code: 1003, message: "mcp 'linked' cannot be read on the daemon host", data: { reason: 'unsafe_path' } },
    { code: 1001, message: "No mcp entry 'missing' in the project", data: { reason: 'not_found' } },
    { code: 1000, message: "mcp 'odd' cannot be read on the daemon host", data: undefined },
  ]);
});

// The same holds for every other forwarded method that reads the host's library, settings or
// task files (t-70c4): alpd quotes a file that does not parse and names its host path, in the
// message and sometimes in data. Readers pass on the code and the reason only; session methods,
// which resolve teams, agents and providers from the library, keep alpd's protocol refusals (a
// reason the contract names) and answer every other failure with a fixed message.
test('errors of library, team, model, settings and session readers carry no host path or file content', async t => {
  const { daemon, sdk, a } = await world(t);
  const quote = tag => `/home/me/.alp/${tag}.json: Unexpected token 'S', ..."T": ${S(tag)}"... is not valid JSON`;
  const raw = message => ({ code: 1000, message });
  const failure = (tag, code, reason) => ({ code, message: quote(tag), data: { ...(reason ? { reason } : {}), file: `/home/me/${S(`${tag}-data`)}` } });
  const cases = [
    ['library.list', { kind: 'mcp', projectRoot: a }, failure('library-list', 1000, 'unreadable'), { code: 1000, message: 'The mcp entries cannot be read on the daemon host', data: { reason: 'unreadable' } }],
    ['library.list', { kind: 'agents', projectRoot: a }, failure('library-list-raw', 1000), { code: 1000, message: 'The agents entries cannot be read on the daemon host', data: undefined }],
    ['team.list', { projectRoot: a }, failure('team-list', -32602, 'invalid_entry'), { code: -32602, message: 'The teams cannot be read on the daemon host', data: { reason: 'invalid_entry' } }],
    ['library.models', {}, failure('library-models', -32602, 'invalid_entry'), { code: -32602, message: 'The models cannot be read on the daemon host', data: { reason: 'invalid_entry' } }],
    ['settings.language.get', {}, failure('settings', 1000, 'unreadable'), { code: 1000, message: 'The language setting cannot be read on the daemon host', data: { reason: 'unreadable' } }],
    // Session methods: alpd's message picks a fixed template; the names are the client's own.
    ['session.preview', { spec: { cwd: a, workflow: 'broken' } }, raw(`/home/me/.alp/teams/broken/team.json: Unexpected token 'S', "{"k": ${S('team-quote')}"... is not valid JSON`), { code: 1000, message: "Team 'broken' has a configuration the daemon host cannot read", data: undefined }],
    ['session.preview', { spec: { cwd: a, workflow: 'gone' } }, raw(`Team 'gone' not found; teams: pho, cafe, ${S('team-list')}`), { code: 1000, message: "Team 'gone' is not available on the daemon host", data: undefined }],
    ['session.preview', { spec: { cwd: a } }, raw(`built-in teams/pho/team.json: ${S('builtin-team')}`), { code: 1000, message: 'The team has a configuration the daemon host cannot read', data: undefined }],
    ['session.create', { spec: { cwd: a, agent: 'broken' } }, raw(`/home/me/.alp/agents/broken/agent.json: Unexpected token 'S', "{"k": ${S('agent-quote')}"... is not valid JSON`), { code: 1000, message: "Agent 'broken' has a configuration the daemon host cannot read", data: undefined }],
    ['session.create', { spec: { cwd: a, agent: 'ghost' } }, raw(`Agent 'ghost' not found: it is not built in, nor under /home/me/${S('agents-dir')}/agents or ${a}/.alp/agents`), { code: 1000, message: "Agent 'ghost' is not available on the daemon host", data: undefined }],
    ['session.create', { spec: { cwd: a, model: 'acp:broken/m1' } }, raw(`/home/me/.alp/providers/broken.json: Unexpected token 'S', "{"k": ${S('provider-quote')}"... is not valid JSON`), { code: 1000, message: "Provider 'broken' has a configuration the daemon host cannot read", data: undefined }],
    ['session.create', { spec: { cwd: a, model: 'claude:claude-opus-5-5' } }, raw('Claude executable not found on PATH; set ALP_CLAUDE_BIN to an absolute native executable'), { code: 1000, message: 'The claude CLI is not installed on the daemon host', data: undefined }],
    ['session.create', { spec: { cwd: a } }, raw(`spawn /home/me/${S('bin')}/codex ENOENT`), { code: 1000, message: 'The agent CLI is not installed on the daemon host', data: undefined }],
    ['session.create', { spec: { cwd: a, model: 'acp:broken' } }, failure('session-create-entry', -32602, 'invalid_entry'), { code: -32602, message: 'session.create failed on the daemon host; the daemon log there may have details', data: { reason: 'invalid_entry' } }],
    // configure takes no model: the provider goes unnamed.
    ['session.configure', { sessionId: 'sa', mode: 'workspace-write' }, raw(`/home/me/.alp/providers/broken.json: ${S('configure-quote')}`), { code: 1000, message: 'The provider has a configuration the daemon host cannot read', data: undefined }],
    ['session.preview', { spec: { cwd: a } }, failure('session-preview', 1000), { code: 1000, message: 'session.preview failed on the daemon host; the daemon log there may have details', data: undefined }],
    ['session.create', { spec: { cwd: a } }, failure('session-persist', 1000, 'persistence_failed'), { code: 1000, message: 'session.create failed on the daemon host; the daemon log there may have details', data: { reason: 'persistence_failed' } }],
    // Any forwarded method: a refusal whose reason marks a host file or alpd's state loses its message.
    ['session.prompt', { sessionId: 'sa', clientMessageId: 'm-1', content: [{ type: 'text', text: 'x' }] }, failure('session-prompt', 1000, 'persistence_failed'), { code: 1000, message: 'session.prompt failed on the daemon host', data: { reason: 'persistence_failed' } }],
    ['session.rename', { sessionId: 'sa', title: 'x' }, failure('session-rename', 1000, 'persistence_failed'), { code: 1000, message: 'session.rename failed on the daemon host', data: { reason: 'persistence_failed' } }],
    ['session.archive', { sessionId: 'sa' }, failure('session-archive', 1000, 'persistence_failed'), { code: 1000, message: 'session.archive failed on the daemon host', data: { reason: 'persistence_failed' } }],
  ];
  const { client } = await sdk('alice');
  const seen = [];
  for (const [method, params, thrown, expected] of cases) {
    daemon.state.handlers[method] = () => { throw thrown; };
    const error = await client.request(method, params).then(() => assert.fail(`${method} answered`), caught => caught);
    seen.push({ code: error.code, message: error.message, data: error.data });
    assert.deepEqual(seen.at(-1), expected, `${method} ${JSON.stringify(params)}`);
  }
  assert.ok(!JSON.stringify(seen).includes('SENTINEL') && !JSON.stringify(seen).includes('/home/me'), JSON.stringify(seen));
  // A protocol refusal of a session method, with a reason the contract names, is passed on as alpd gave it.
  daemon.state.handlers['session.create'] = () => { throw { code: 1004, message: 'Message m-1 was already sent with different content', data: { reason: 'key_conflict' } }; };
  await assert.rejects(client.request('session.create', { spec: { cwd: a } }), error => error.code === 1004 && error.message === 'Message m-1 was already sent with different content' && error.data?.reason === 'key_conflict');
});

// task.list answers task files that do not parse with V8's quote of the file: the client learns
// which file, not what it holds.
test('task.list names unreadable task files without their content', async t => {
  const { daemon, sdk, a } = await world(t);
  daemon.state.handlers['task.list'] = ({ projectRoot }) => ({ projectRoot, tasks: [], revision: 'r1', unreadable: [
    { file: '.alp/tasks/t-aaaa.json', error: `Unexpected token 'S', "{"x": ${S('task-quote')}"... is not valid JSON` },
    { file: `/home/me/${S('task-abs')}.json`, error: S('task-abs-error') },
    { error: S('task-nofile') },
  ] });
  const { client } = await sdk('alice');
  const answer = await client.request('task.list', { projectRoot: a });
  assert.ok(!JSON.stringify(answer).includes('SENTINEL') && !JSON.stringify(answer).includes('/home/me'), JSON.stringify(answer));
  assert.deepEqual(answer.unreadable, [
    { file: '.alp/tasks/t-aaaa.json', error: 'This task file cannot be read on the daemon host' },
    { error: 'This task file cannot be read on the daemon host' },
    { error: 'This task file cannot be read on the daemon host' },
  ]);
  assert.equal(answer.revision, 'r1');
});

// t-d27c: a session's lastError, a prompt's receipt, the failure events and alpd's raw errors carry
// the text of a runtime, a provider or alpd's store, which names host paths (EACCES on alpd's state
// directory, a CLI's location) and may run on with a stack or a CLI's stderr. The client keeps the
// code and the first line, host paths outside the grant replaced, its own workspace's made relative.
const HOSTED = tag => `EACCES: permission denied, open '/home/me/.alp/state/${S(tag)}.json'\n    at ${S(`${tag}-stack`)} (/home/me/${S(`${tag}-frame`)}.js:1:2)`;
const HOSTED_SHOWN = "EACCES: permission denied, open '<host path>'";
const clean = value => { const text = JSON.stringify(value); assert.ok(!text.includes('SENTINEL') && !text.includes('/home/me'), text); };

test('session summaries carry no host path in lastError or parked (t-d27c)', async t => {
  const { daemon, sdk, a } = await world(t);
  const { client } = await sdk('alice');
  const sa = daemon.state.sessions.get('sa');
  Object.assign(sa, { status: 'error', lastError: { code: 'turn_failed', message: HOSTED('last-error'), file: S('last-error-extra') }, parked: `Usage limit; see /home/me/${S('parked')}.log` });
  const answers = {
    get: (await client.request('session.get', { sessionId: 'sa' })).session,
    list: (await client.request('session.list', { projectRoot: a })).sessions.find(session => session.id === 'sa'),
    attach: (await client.request('session.attach', { sessionId: 'sa', replay: false })).session,
    configure: (await client.request('session.configure', { sessionId: 'sa' })).session,
    rename: (await client.request('session.rename', { sessionId: 'sa', title: 'named' })).session,
    archive: (await client.request('session.archive', { sessionId: 'sa', archived: false })).session,
  };
  // session.status rows are snapshots too: parked passes through the same rule (lastError is not a snapshot field).
  daemon.state.handlers['session.status'] = () => ({ status: { rootId: 'sa', sessions: [{ ...sa, state: 'idle', idleMs: 0, workdir: sa.projectRoot, unreadMail: 0 }], assignments: [], questions: [], worktrees: [] } });
  const row = (await client.request('session.status', { sessionId: 'sa' })).status.sessions[0];
  answers.status = { ...row, lastError: { code: 'turn_failed', message: HOSTED_SHOWN }, ...(row.lastError ? { lastError: row.lastError } : {}) };
  // Each surface on its own, so a failure names every method that leaks.
  const wrong = Object.entries(answers).filter(([, session]) => !isDeepStrictEqual({ lastError: session.lastError, parked: session.parked, status: session.status }, { lastError: { code: 'turn_failed', message: HOSTED_SHOWN }, parked: 'Usage limit; see <host path>', status: 'error' })).map(([method]) => method);
  assert.deepEqual(wrong, [], `leaking: ${wrong.join(', ')}`);
  clean(answers);
});

test('alpd errors of session.attach, interrupt, close and message name no host path (t-d27c)', async t => {
  const { daemon, sdk, canonicalA } = await world(t);
  const { client } = await sdk('alice');
  const cases = [
    ['session.attach', { sessionId: 'sa' }, HOSTED('attach'), HOSTED_SHOWN],
    ['session.interrupt', { sessionId: 'sa' }, `codex app-server at /home/me/${S('bin')}/codex did not answer turn/interrupt`, 'codex app-server at <host path> did not answer turn/interrupt'],
    ['session.close', { sessionId: 'sa' }, `could not remove /home/me/.alp/worktrees/${S('close')}: EBUSY`, 'could not remove <host path>: EBUSY'],
    // A path in the client's own workspace stays, relative to it.
    ['session.message', { sessionId: 'sa', text: 'x' }, `mail for ${canonicalA}/src/${S('relative')}.ts failed: C:\\Users\\me\\${S('windows')} and file:///home/me/${S('url')}\n${S('stderr')}`, `mail for src/${S('relative')}.ts failed: <host path> and <host path>`],
  ];
  const seen = [];
  const wrong = [];
  for (const [method, params, message, shown] of cases) {
    daemon.state.handlers[method] = () => { throw { code: 1000, message, data: { reason: 'busy' } }; };
    const error = await client.request(method, params).then(() => assert.fail(`${method} answered`), caught => caught);
    seen.push({ code: error.code, message: error.message.replace(S('relative'), 'r'), data: error.data });
    if (!isDeepStrictEqual({ code: error.code, message: error.message, data: error.data }, { code: 1000, message: shown, data: { reason: 'busy' } })) wrong.push(method);
  }
  assert.deepEqual(wrong, [], `leaking: ${wrong.join(', ')}`);
  clean(seen);
});

test('a failed prompt receipt reaches the client without host paths (t-d27c)', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('alice');
  daemon.state.handlers['session.prompt'] = () => ({ outcome: 'failed', error: { message: `Claude exited with code 1: /home/me/${S('claude-bin')}/claude\nstderr: ${S('claude-stderr')}`, code: 'outcome_unknown', detail: S('receipt-extra') } });
  const receipt = await client.request('session.prompt', { sessionId: 'sa', clientMessageId: 'm-1', content: [{ type: 'text', text: 'x' }] });
  clean(receipt);
  assert.deepEqual(receipt, { outcome: 'failed', error: { message: 'Claude exited with code 1: <host path>', code: 'outcome_unknown' } });
});

test('session.failed, prompt.failed, turn.ended, session.updated and notices reach the client without host paths (t-d27c)', async t => {
  const { daemon, sdk, canonicalA } = await world(t);
  const { client } = await sdk('alice');
  const seen = [];
  client.onEvent(envelope => seen.push(envelope.event));
  await client.request('session.attach', { sessionId: 'sa', replay: false });
  const limit = "You've hit your limit · resets 3pm (Europe/Berlin); see https://status.anthropic.com/v1/incidents";
  daemon.emit('sa', { type: 'prompt.failed', clientMessageId: 'm-2', error: { message: `/home/me/.alp/providers/p.json: Unexpected token 'S', "{"key": ${S('quote')}"... is not valid JSON` } });
  daemon.emit('sa', { type: 'prompt.failed', clientMessageId: 'm-3', error: { message: limit } });
  daemon.emit('sa-c', { type: 'turn.ended', turnId: 't-1', state: 'failed', error: { message: `edit of ${canonicalA}/lib/a.js failed; backup in /home/me/${S('backup')}`, code: 'x' } });
  daemon.emit('sa', { type: 'session.updated', session: { ...daemon.state.sessions.get('sa'), lastError: { message: HOSTED('updated') } } });
  daemon.emit('sa', { type: 'item', item: { kind: 'notice', id: 'n-1', level: 'warning', text: `ALP: Could not continue: peer a-1 (spawn /home/me/${S('notice')}/codex ENOENT)\nRun alp resume in ${canonicalA}.` } });
  daemon.emit('sa', { type: 'session.failed', error: { message: HOSTED('failed'), code: 'provider_failed' } });
  await until(() => seen.some(event => event.type === 'session.failed'), 'session.failed');
  const leaking = seen.filter(event => /SENTINEL|\/home\/me/.test(JSON.stringify(event))).map(event => event.type);
  assert.deepEqual(leaking, [], `leaking: ${leaking.join(', ')}`);
  assert.deepEqual(seen.filter(event => event.type !== 'session.updated' && event.type !== 'item'), [
    { type: 'prompt.failed', clientMessageId: 'm-2', error: { message: `<host path>: Unexpected token 'S', "<file content>"... is not valid JSON` } },
    { type: 'prompt.failed', clientMessageId: 'm-3', error: { message: limit } },
    { type: 'turn.ended', turnId: 't-1', state: 'failed', error: { message: 'edit of lib/a.js failed; backup in <host path>', code: 'x' } },
    { type: 'session.failed', error: { message: HOSTED_SHOWN, code: 'provider_failed' } },
  ]);
  assert.deepEqual(seen.find(event => event.type === 'session.updated').session.lastError, { message: HOSTED_SHOWN });
  assert.equal(seen.find(event => event.type === 'item').item.text, 'ALP: Could not continue: peer a-1 (spawn <host path> ENOENT)\nRun alp resume in <workspace>.');
});

test('safeErrorText keeps useful text and replaces host paths (t-d27c)', async () => {
  const { safeErrorText, safeAlpError } = await import('../src/policy.js');
  assert.equal(typeof safeErrorText, 'function', 'policy.js exports safeErrorText');
  const workspaces = [{ path: '/tmp/my ws', canonical: '/private/tmp/my ws' }];
  const cases = [
    ['429 Too Many Requests: rate limited, 50/min; retry after 20s', '429 Too Many Requests: rate limited, 50/min; retry after 20s'],
    ['POST https://api.openai.com/v1/responses failed (ECONNRESET)', 'POST https://api.openai.com/v1/responses failed (ECONNRESET)'],
    ['cannot read /private/tmp/my ws/a b/c.txt or /tmp/my ws.', 'cannot read a b/c.txt or <workspace>.'],
    ['escape /tmp/my ws/../../etc/passwd', 'escape <host path>'],
    ['sibling /tmp/my-wsx/y', 'sibling <host path>'],
    ['~/.codex/config.toml, \\\\host\\share\\k and D:/keys/k.pem', '<host path>, <host path> and <host path>'],
    ['"{"token": "abc"... is not valid JSON', '"<file content>"... is not valid JSON'],
    ['and/or a / b', 'and/or a / b'],
    // After `:` or `@`, and file: with any slashes (review round 1); `a:/` reads as a drive.
    ['spawn codex ENOENT (PATH=/usr/bin:/home/me/bin) cfg:/home/me/x at file:/home/me/y user@/home/me/z', 'spawn codex ENOENT (PATH=<host path>:<host path>) cfg:<host path> at <host path> user@<host path>'],
    ['bad /private/tmp/my ws/a:/etc/passwd; https://h.example:8443/v1/x and localhost:8080/v1', 'bad <host path>; https://h.example:8443/v1/x and localhost:8080/v1'],
    ['first\u0085/home/me/second', 'first'],
    // Review round 2: prose `file:`, JSON pointers and globs stay; Windows file: URLs go whole.
    ['Error reading file: permission denied at #/properties/foo for src/**/*.ts', 'Error reading file: permission denied at #/properties/foo for src/**/*.ts'],
    ['file:C:\\Users\\me\\secret and file:///C:\\Users\\me\\x and FILE:///C:/Users/me/y', '<host path> and <host path> and <host path>'],
    ['x'.repeat(5000), `${'x'.repeat(1000)}…`],
  ];
  for (const [text, shown] of cases) assert.equal(safeErrorText(text, workspaces), shown, text);
  assert.equal(safeErrorText('/Users/Jo Doe/.alp/x failed', [], { home: '/Users/Jo Doe' }), '<host path> failed');
  assert.deepEqual(safeAlpError({ message: '/etc/x', code: 'bad code!' }, workspaces), { message: '<host path>' });
  assert.deepEqual(safeAlpError('oops', workspaces), { message: 'Failed' });
  assert.equal(safeErrorText(Object.create(null), workspaces), '');
  assert.equal(safeErrorText({ toString: 1 }, workspaces), '');
});

test('the hello names the host as alpd does, and nothing when alpd sends no usable name', async t => {
  assert.equal(hostLabel('  build-host.local  '), 'build-host.local');
  for (const value of [undefined, 42, '', '   ', 'a\nb', 'x\u0000', 'a\u202eb', 'a\u200bb', 'h'.repeat(254)]) assert.equal(hostLabel(value), undefined, JSON.stringify(value));
  const { daemon, sdk } = await world(t);
  assert.equal((await sdk('alice')).hello.hostname, 'fake-host');
  daemon.state.handlers['daemon.hello'] = () => ({ protocolVersion: 1, daemonVersion: 'fake', hostname: 'evil\u001b[2Jhost', capabilities: ['library'] });
  const { hello: greeting } = await sdk('alice');
  assert.equal(greeting.daemonVersion, 'fake');
  assert.ok(!Object.hasOwn(greeting, 'hostname'), JSON.stringify(greeting));
});

test('library and team rows carry only their listed fields, and a team error names no host path', async t => {
  const { daemon, sdk, a } = await world(t);
  const secret = 'SENTINEL-row-secret';
  daemon.state.handlers['library.list'] = ({ projectRoot }) => ({ projectRoot, entries: [
    { name: 'x', source: 'project', description: 'search', usedBy: ['agent main'], overrides: 'library', path: `/home/me/.alp/mcp/x.json?${secret}`, content: { url: `https://u:${secret}@example.test/mcp` } },
  ] });
  daemon.state.handlers['team.list'] = ({ projectRoot }) => ({ projectRoot, teams: [
    { id: 'pho', source: 'builtin', label: 'Phở', description: 'default' },
    { id: 'broken', source: 'library', error: `/home/me/.alp/teams/broken/team.json: unexpected token near "${secret}"`, path: '/home/me/.alp/teams/broken' },
  ] });
  daemon.state.handlers['library.models'] = () => ({ models: [{ id: 'acp:custom/vendor-model', label: 'Custom · vendor', efforts: [], command: secret }] });
  const { client } = await sdk('alice');
  const listed = await client.request('library.list', { kind: 'mcp', projectRoot: a });
  assert.deepEqual(listed.entries, [{ name: 'x', source: 'project', description: 'search', usedBy: ['agent main'], overrides: 'library' }]);
  const { teams } = await client.request('team.list', { projectRoot: a });
  assert.deepEqual(teams.map(team => Object.keys(team).sort()), [['description', 'id', 'label', 'source'], ['error', 'id', 'source']]);
  assert.ok(!teams[1].error.includes('/home/me') && !teams[1].error.includes(secret), teams[1].error);
  const { models } = await client.request('library.models');
  assert.deepEqual(models, [{ id: 'acp:custom/vendor-model', label: 'Custom · vendor', efforts: [] }]);
});

// Model ids follow alpd's grammar (runtime:model, acp:<provider>[/<model>], or a bare catalogue id),
// not the plain-name rule of agents: an ACP model has a slash, and its own id may hold more.
test('spec.model takes the ids library.models lists, ACP ones included, and refuses others', async t => {
  const { daemon, sdk, a } = await world(t);
  const { client } = await sdk('alice');
  for (const model of ['acp:custom/vendor-model', 'acp:custom', 'acp:open-router/meta/llama-3.1:8b', 'codex:gpt-5.6-sol', 'claude:claude-opus-5-5', 'claude:claude-opus-4-8[1m]', 'claude-sonnet-5[1m]', 'antigravity:gemini-3-pro', 'gpt-5.6-sol']) {
    assert.ok((await client.request('session.preview', { spec: { cwd: a, model } })).preview, model);
  }
  assert.equal((await client.request('session.create', { spec: { cwd: a, model: 'acp:custom/vendor-model' } })).session.projectRoot, daemon.calls('session.create')[0].params.spec.cwd);
  assert.equal(daemon.calls('session.create')[0].params.spec.model, 'acp:custom/vendor-model');
  const mark = daemon.calls().length;
  for (const model of ['', ' ', 'acp:', 'acp:/x', 'acp:../x', 'acp:a b/c', 'acp:x/ y', 'acp:x/', 'codex:', 'codex: x', '/etc/passwd', '../x', 'x\u0000y', 'x\ny', 'mcp:x', `acp:p/${'m'.repeat(300)}`]) {
    await assert.rejects(client.request('session.preview', { spec: { cwd: a, model } }), error => error.code === 1003 && error.data?.reason === 'spec_field' && error.data.field === 'model', JSON.stringify(model));
  }
  assert.deepEqual(daemon.calls().slice(mark), []);
});

// A tree has one workspace (docs/alp/remote-gateway.md §5.6): alpd opens every assignment and the
// supervisor with the requester's cwd. The gateway checks the session asked about and its
// ancestors, and for a whole-tree answer every session in it, so a tree that ever spans workspaces
// is refused rather than shown.
test('session.status answers only a tree wholly inside the grant', async t => {
  const { daemon, sdk, canonicalA, b } = await world(t);
  const tree = (...sessions) => () => ({ status: { rootId: 'sa', sessions: sessions.map(([id, projectRoot]) => ({ id, projectRoot })), assignments: [], questions: [], worktrees: [], leases: [], claims: [] } });
  const { client } = await sdk('alice');
  daemon.state.handlers['session.status'] = tree(['sa', canonicalA], ['sa-c', canonicalA]);
  assert.equal((await client.request('session.status', { sessionId: 'sa-c' })).status.sessions.length, 2);
  daemon.state.handlers['session.status'] = tree(['sa', canonicalA], ['elsewhere', b]);
  await assert.rejects(client.request('session.status', { sessionId: 'sa' }), error => error.code === 1001);
  daemon.state.handlers['session.status'] = () => ({ status: { rootId: 'sb', sessions: [], assignments: [], questions: [], worktrees: [], leases: [], claims: [] } });
  await assert.rejects(client.request('session.status', { sessionId: 'sa' }), error => error.code === 1001, 'another root than the one checked');
});


test('library.write is opt-in and forces the safe project policy without executable references', async t => {
  const { daemon, sdk, a, canonicalA } = await world(t);
  const { client } = await sdk('alice');
  for (const method of ['save', 'delete', 'duplicate', 'rename']) {
    const params = IN_SCOPE({ a })['library.' + method];
    daemon.state.handlers['library.' + method] = () => method === 'delete' ? { removed: true } : { revision: 'r1' };
    await client.request('library.' + method, { ...params, policy: 'project-data' });
    assert.deepEqual(daemon.calls('library.' + method).at(-1).params, { ...params, projectRoot: canonicalA, policy: 'project-data' });
    const mark = daemon.calls().length;
    for (const altered of [{ scope: 'library' }, { projectRoot: undefined }, { kind: 'hooks' }, { kind: 'mcp' }, { kind: 'teams' }, { kind: 'providers' }]) {
      await assert.rejects(client.request('library.' + method, { ...params, ...altered }), e => e.code === 1003);
      assert.deepEqual(reached(daemon, mark, 'library.' + method), []);
    }
  }
  for (const content of [{ instructions: 'text', config: { provider: 'host' } }, { instructions: 'text', config: { model: 'acp:host' } }, { instructions: 'text', config: { hooks: ['run'] } }, { instructions: 'text', config: { mcp: ['run'] } }, { instructions: 'text', config: { skills: ['run'] } }, { instructions: 'text', unknown: true }]) {
    const mark = daemon.calls().length;
    await assert.rejects(client.request('library.save', { kind: 'agents', name: 'safe', scope: 'project', projectRoot: a, content }), e => e.code === 1003 && e.data.reason === 'library_policy');
    assert.deepEqual(reached(daemon, mark, 'library.save'), []);
  }
  await assert.rejects(client.request('library.save', { ...IN_SCOPE({ a })['library.save'], sync: 'known-projects' }), e => e.code === 1003);
  const { client: defaultClient } = await sdk('both');
  await assert.rejects(defaultClient.request('library.save', IN_SCOPE({ a })['library.save']), e => e.code === 1003 && e.data.permission === 'library.write');
  await assert.rejects(client.request('library.skills.set', { agent: 'main', skills: [] }), e => e.code === -32601);
});

test('older daemon cannot receive project-data writes; image hello advertises effective frame limits only with capability', async t => {
  for (const capability of [false, true]) {
    const daemon = fakeDaemon({ capabilities: capability ? ['library', 'prompt.images'] : ['library'] });
    const { sdk } = await startGateway(t, { daemon, config: { limits: { maxFrame: 1024 * 1024 } }, credentials: { writer: { workspaces: [process.cwd()], permissions: ['library.write'] } } });
    const { client, hello } = await sdk('writer');
    assert.deepEqual(hello.promptImageLimits, capability ? promptImageLimits(1024 * 1024) : undefined);
    const mark = daemon.calls().length;
    await assert.rejects(client.request('library.save', { kind: 'skills', name: 'writer', scope: 'project', projectRoot: process.cwd(), content: { body: 'text' } }), e => e.code === 1005 && e.data.capability === 'library.project.write');
    assert.deepEqual(reached(daemon, mark, 'library.save'), []);
  }
});

// Session mode is separate from the permission to read project configuration.
test('library viewer requires project.read and a granted workspace; no write grant is implied', async t => {
  const daemon = fakeDaemon({ capabilities: ['library'] });
  daemon.state.handlers['library.get'] = ({ kind, name }) => ({ kind, name, source: 'builtin', content: { body: 'Viewable instructions' }, revision: null, usedBy: [] });
  const { sdk } = await startGateway(t, { daemon, credentials: {
    viewer: { workspaces: [process.cwd()], permissions: ['project.read'], modes: ['read-only'] },
    noProject: { workspaces: [process.cwd()], permissions: ['session.read'] },
  } });
  const params = { kind: 'skills', name: 'example', projectRoot: process.cwd() };
  const { client } = await sdk('viewer');
  assert.equal((await client.request('library.get', params)).content.body, 'Viewable instructions');
  const deniedMark = daemon.calls().length;
  const { client: denied } = await sdk('noProject');
  await assert.rejects(denied.request('library.get', params), e => e.code === 1003 && e.data.reason === 'grant');
  await assert.rejects(client.request('library.get', { ...params, projectRoot: path.dirname(process.cwd()) }), e => e.code === 1003 && e.data.reason === 'outside_workspace');
  await assert.rejects(client.request('library.save', { ...params, scope: 'project', content: { body: 'Attempted write' } }), e => e.code === 1003 && e.data.permission === 'library.write');
  assert.deepEqual(reached(daemon, deniedMark, 'library.get'), []);
  assert.deepEqual(reached(daemon, deniedMark, 'library.save'), []);
});

test('history authorizes before cursor forwarding and replaces untrusted byte budgets', async t => {
  const { daemon, sdk } = await world(t, { maxFrame: 8192 });
  daemon.state.handlers['session.history'] = params => ({ generation: 'g', items: [], hasOlder: false, tipCursor: 0 });
  const { client: reader } = await sdk('reader');
  await reader.request('session.history', { sessionId: 'sa', maxBytes: 524288, before: 'opaque' });
  const call = daemon.calls().find(call => call.method === 'session.history');
  assert.equal(call.params.before, 'opaque');
  assert.equal(call.params.maxBytes, 4096);
  const mark = daemon.calls().length;
  await assert.rejects(reader.request('session.history', { sessionId: 'sb', before: 'broken' }), error => error.code === 1001);
  assert.equal(reached(daemon, mark, 'session.history').length, 0);
  const events = [];
  reader.onEvent(event => events.push(event));
  await reader.request('session.attach', { sessionId: 'sa', replay: false });
  daemon.emit('sa', { type: 'item', item: { kind: 'notice', id: 'huge', level: 'info', text: 'x'.repeat(70000) } });
  await until(() => events.length > 0);
  assert.match(events[0].event.item.text, /too large/);
  assert.equal(events[0].cursor, 1);
  assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: events[0] })) < 8192);
});
