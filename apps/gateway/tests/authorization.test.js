// Authorization (docs/alp/remote-gateway.md §5): the exposure matrix is complete and default-deny,
// every exposed method is checked for permission and for workspace/session scope before anything
// reaches alpd, results and events stay inside the grant, and spec fields, prompt content and modes
// are allow-listed. Every refusal is checked to have caused no request of that method at alpd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RPC_METHODS } from '@anhlp/alp-protocol';
import { METHODS_V1 } from '@anhlp/alp-protocol/contract';
import { EXPOSURE, unclassified } from '../src/index.js';
import { fakeDaemon, summary } from './support/fake-daemon.js';
import { startGateway, until } from './support/harness.js';

async function world(t, { modes } = {}) {
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
  const gw = await startGateway(t, { daemon, credentials: {
    alice: { workspaces: [a], ...(modes ? { modes } : {}) },
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
  'catalog.get': null, // global: the static catalogue of models and modes
  'session.list': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'session.get': () => [{ sessionId: 'sb' }, 1001],
  'session.status': () => [{ sessionId: 'mix' }, 1001],
  'session.log': () => [{ sessionId: 'sb-c' }, 1001],
  'session.attach': () => [{ sessionId: 'sb', after: 0 }, 1001],
  'session.release': () => [{ sessionId: 'sb' }, 1001],
  'session.preview': ({ b }) => [{ spec: { cwd: b } }, 1003, 'outside_workspace'],
  'question.list': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'question.watch': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'board.list': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'session.create': ({ b }) => [{ spec: { cwd: b } }, 1003, 'outside_workspace'],
  'session.prompt': () => [{ sessionId: 'mix', clientMessageId: 'm', content: text }, 1001],
  'session.interrupt': () => [{ sessionId: 'sb' }, 1001],
  'session.configure': () => [{ sessionId: 'sb', mode: 'read-only' }, 1001],
  'session.close': () => [{ sessionId: 'sb-c' }, 1001],
  'session.rename': () => [{ sessionId: 'sb', title: 'mine now' }, 1001],
  'session.archive': () => [{ sessionId: 'sb' }, 1001],
  'session.message': () => [{ sessionId: 'sb', text: 'hello' }, 1001],
  'question.answer': () => [{ questionId: 'q-b-222', text: 'yes' }, 1001],
  'team.list': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'task.list': ({ b }) => [{ projectRoot: b }, 1003, 'outside_workspace'],
  'task.create': ({ b }) => [{ projectRoot: b, title: 'theirs' }, 1003, 'outside_workspace'],
  'task.update': ({ b }) => [{ projectRoot: b, id: 't-a000', action: 'close' }, 1003, 'outside_workspace'],
  'task.gate.resolve': ({ b }) => [{ projectRoot: b, id: 't-a000', gate: 'review' }, 1003, 'outside_workspace'],
  'library.list': ({ b }) => [{ kind: 'mcp', projectRoot: b }, 1003, 'outside_workspace'],
  'library.models': null, // model ids and labels, as catalog.get
  'settings.language.get': null, // the language the user reads
};

/** Schema-valid params in scope for every exposed method, for permission checks. */
const IN_SCOPE = ({ a }) => ({
  'catalog.get': {}, 'library.models': {}, 'settings.language.get': {},
  'session.list': {}, 'session.get': { sessionId: 'sa' }, 'session.status': { sessionId: 'sa' }, 'session.log': { sessionId: 'sa' },
  'session.attach': { sessionId: 'sa' }, 'session.release': { sessionId: 'sa' }, 'session.preview': { spec: { cwd: a } },
  'question.list': {}, 'question.watch': {}, 'board.list': { projectRoot: a },
  'session.create': { spec: { cwd: a } }, 'session.prompt': { sessionId: 'sa', clientMessageId: 'm', content: text },
  'session.interrupt': { sessionId: 'sa' }, 'session.configure': { sessionId: 'sa' }, 'session.close': { sessionId: 'sa' },
  'session.rename': { sessionId: 'sa', title: 't' }, 'session.archive': { sessionId: 'sa' }, 'session.message': { sessionId: 'sa', text: 'x' },
  'question.answer': { questionId: 'q-a-111', text: 'x' },
  'team.list': { projectRoot: a }, 'task.list': { projectRoot: a }, 'task.create': { projectRoot: a, title: 't' },
  'task.update': { projectRoot: a, id: 't-a000', action: 'close' }, 'task.gate.resolve': { projectRoot: a, id: 't-a000', gate: 'review' },
  'library.list': { kind: 'agents', projectRoot: a },
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
  const readerMutations = new Set(['session.release']);
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
    assert.ok(scope?.kind !== 'library-or-project', `${method}: can write the host library`);
    assert.ok(!(scope?.kind === 'connection' && effect === 'mutation'), `${method}: a connection-level mutation is exposed`);
    // A risk the gateway removes itself is allowed, with the test that proves it.
    const mitigated = { 'session.create': /^exec: spec\.env and stdio spec\.mcpServers/ }[method];
    assert.ok(!risks.some(risk => /admin|exec/.test(risk) && !mitigated?.test(risk)), `${method}: an administrative or code-executing method is exposed`);
    if (effect === 'mutation' && !readerMutations.has(method)) assert.match(exposure.permission ?? '', /\.write$/, `${method} writes and needs a write permission`);
    // The resource the daemon names is the one the gateway checks.
    if (scope?.param === 'projectRoot') assert.ok(exposure.params?.includes('projectRoot'), `${method} forwards projectRoot`);
    if (scope?.param === 'sessionId') assert.ok(exposure.params?.includes('sessionId'), `${method} forwards sessionId`);
  }
});

test('methods not exposed answer -32601 and never reach alpd: host, administration, library writes and unknown methods', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('alice');
  const refused = [...Object.entries(EXPOSURE).filter(([, entry]) => entry.status === 'denied' || entry.status === 'prohibited').map(([method]) => method), 'workspace.list', 'subscribe', 'provider.list'];
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
    const { client } = await sdk(label);
    for (const method of exposed.filter(name => !held.includes(EXPOSURE[name].permission))) {
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

test('prompts carry text only', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('alice');
  for (const part of [{ type: 'image', data: 'xx' }, { type: 'file', path: '/etc/passwd' }, { type: 'resource', uri: 'file:///etc/passwd' }]) {
    await assert.rejects(client.request('session.prompt', { sessionId: 'sa', clientMessageId: 'm', content: [part] }), error => error.code === 1003 && error.data?.reason === 'content_type');
  }
  assert.deepEqual(daemon.calls('session.prompt'), []);
  assert.equal((await client.request('session.prompt', { sessionId: 'sa', clientMessageId: 'm', content: text })).outcome, 'accepted');
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
    ['team.list', {}], ['library.list', { kind: 'mcp' }],
  ]) {
    await assert.rejects(client.request(method, params), error => error.code === 1003 && error.data?.reason === 'host_scope', `${method} ${JSON.stringify(params)}`);
  }
  for (const projectRoot of [path.join(a, 'sub'), `${a}/`, path.dirname(a)]) {
    await assert.rejects(client.request('task.create', { projectRoot, title: 'x' }), error => error.code === 1003 && error.data?.reason === 'outside_workspace', projectRoot);
  }
  assert.deepEqual(daemon.calls().slice(mark), []);
});

// Library entries are configuration of commands alpd runs on the daemon host: MCP servers (with
// URLs that may hold a token, args, env), hooks (commands), providers. alpd redacts only env and
// header values on read, so the gateway does not pass entry content on at all until a redaction
// contract covers every field (docs/alp/remote-gateway.md §5.4, §10).
test('library.get is not exposed: no entry content reaches a remote client, from any layer', async t => {
  const { daemon, sdk, a } = await world(t);
  const { client } = await sdk('alice');
  for (const params of [
    { kind: 'mcp', name: 'x', projectRoot: a, scope: 'project' }, { kind: 'hooks', name: 'x', projectRoot: a, scope: 'project' },
    { kind: 'agents', name: 'main', projectRoot: a, scope: 'project' }, { kind: 'teams', name: 'pho', projectRoot: a },
  ]) {
    await assert.rejects(client.request('library.get', params), error => error.code === -32601 && error.data?.reason === 'not_exposed', JSON.stringify(params));
  }
  assert.deepEqual(daemon.calls('library.get'), []);
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
