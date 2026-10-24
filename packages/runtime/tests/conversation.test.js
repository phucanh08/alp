// Fork and rewind in the runtime (docs/protocol/alp-json-rpc-v1.md §12.7): branch() makes the native
// conversation, rebind() moves an idle root onto it. Codex and Claude are fakes; no model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { ConversationError, createAlpRuntime } from '@anhlp/alp-runtime';

/** Fake transports: `behave(runtime, method, params)` may answer a request, or undefined for the default. */
function fakeTransport(runtimes, behave = () => undefined) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      index, kind, cwd, calls: [], closed: false, threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        const answer = await behave(this, method, params);
        if (answer !== undefined) return answer;
        if (method === 'thread/resume') return { thread: { id: params.threadId } };
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      finish(status = 'completed', error) {
        this.notification('item/completed', { threadId: this.lastThread(), item: { type: 'agentMessage', id: `output-${index}-${turns}`, text: 'done' } });
        this.notification('turn/completed', { threadId: this.lastThread(), turn: { id: this.turnId, status, ...(error ? { error } : {}) } });
      },
      lastThread() { return this.calls.findLast(call => call.method === 'thread/resume')?.params.threadId ?? this.threadId; },
      call(tool, args) {
        return this.serverRequest('item/tool/call', { threadId: this.lastThread(), turnId: this.turnId, callId: `${tool}-${index}-${turns}`, namespace: null, tool, arguments: args });
      },
      of(method) { return this.calls.filter(call => call.method === method).map(call => call.params); },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

async function setup(t, behave, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-conversation-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'], lead: ['peer'] } }));
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes, behave), supervisor: false, libraryDir: path.join(directory, 'home'), ...options });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const envelopes = [];
  runtime.onEvent(envelope => envelopes.push(envelope));
  const of = (sessionId, type) => envelopes.filter(e => e.sessionId === sessionId && e.event.type === type).map(e => e.event);
  const prompt = (sessionId, id, text = 'go') => runtime.prompt(sessionId, { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text }] });
  return { directory, root, runtime, runtimes, of, prompt };
}

/** Rejects with a ConversationError of `reason`, and `outcomeUnknown` when given. */
async function refused(promise, reason, outcomeUnknown) {
  const error = await promise.then(() => assert.fail(`expected a refusal (${reason})`), error => error);
  assert.ok(error instanceof ConversationError, `not a ConversationError: ${error?.stack ?? error}`);
  assert.equal(error.data.reason, reason, error.message);
  if (outcomeUnknown !== undefined) assert.equal(error.outcomeUnknown, outcomeUnknown, error.message);
  return error;
}

const unanswered = message => Object.assign(new Error(message), { outcomeUnknown: true });
const codexRequest = (cutoff, extra = {}) => ({ runtime: 'codex', source: { threadId: 'source' }, cwd: '/work/source', model: 'codex:gpt-test', thinking: 'high', mode: 'workspace-write', turns: ['t1', 't2', 't3'], ...(cutoff ? { cutoff } : {}), ...extra });

/** A Codex fork that keeps the source's turn ids: thread/turns/list answers the fork's last turn. */
const codexFork = (lastTurn, fork = {}) => (runtime, method) => {
  if (method === 'thread/fork') return { thread: { id: 'fork-1', forkedFromId: 'source', ...fork } };
  if (method === 'thread/turns/list') return { data: lastTurn ? [{ id: lastTurn, status: 'completed' }] : [], nextCursor: null };
  return undefined;
};

test('a Codex branch through a turn forks with lastTurnId, the request settings and the target cwd, verified', async t => {
  const { runtime, runtimes } = await setup(t, codexFork('t2'));
  const binding = await runtime.branch(codexRequest({ throughTurnId: 't2' }, { targetCwd: '/work/worktree' }));
  assert.deepEqual(binding, { threadId: 'fork-1' });
  const [codex] = runtimes;
  assert.equal(codex.kind, 'codex');
  assert.equal(codex.cwd, '/work/worktree');
  assert.deepEqual(codex.of('thread/fork'), [{
    threadId: 'source', lastTurnId: 't2', ephemeral: false, excludeTurns: true, cwd: '/work/worktree',
    model: 'gpt-test', sandbox: 'workspace-write', approvalPolicy: 'never',
  }]);
  assert.deepEqual(codex.of('thread/turns/list'), [{ threadId: 'fork-1', limit: 1, sortDirection: 'desc' }]);
  assert.deepEqual(codex.of('thread/delete'), []);
  assert.equal(codex.closed, true);
  // The source is never changed: no revert, resume or delete of it.
  assert.deepEqual(codex.calls.map(call => call.method), ['thread/fork', 'thread/turns/list']);
});

test('a Codex branch before a turn forks with beforeTurnId and must end at the turn before it', async t => {
  const { runtime, runtimes } = await setup(t, codexFork('t2'));
  assert.deepEqual(await runtime.branch(codexRequest({ beforeTurnId: 't3' }, { mode: 'full-access' })), { threadId: 'fork-1' });
  const [fork] = runtimes[0].of('thread/fork');
  assert.equal(fork.beforeTurnId, 't3');
  assert.equal('lastTurnId' in fork, false);
  assert.equal(fork.cwd, '/work/source');
  assert.equal(fork.sandbox, 'danger-full-access');
  // The whole conversation must end at its last turn.
  const whole = await setup(t, codexFork('t3'));
  assert.deepEqual(await whole.runtime.branch(codexRequest(undefined, { mode: 'read-only' })), { threadId: 'fork-1' });
  const [all] = whole.runtimes[0].of('thread/fork');
  assert.equal('lastTurnId' in all || 'beforeTurnId' in all, false);
  assert.equal(all.sandbox, 'read-only');
});

test('a Codex fork that does not end at the expected turn is deleted and refused', async t => {
  const { runtime, runtimes } = await setup(t, codexFork('t3'));
  await refused(runtime.branch(codexRequest({ beforeTurnId: 't3' })), 'native_refused', false);
  assert.deepEqual(runtimes[0].of('thread/delete'), [{ threadId: 'fork-1' }]);
  assert.equal(runtimes[0].closed, true);

  // A fork forked from another thread, a fork still running, an unreadable fork: all deleted.
  for (const behave of [
    codexFork('t2', { forkedFromId: 'other' }),
    (runtime, method) => method === 'thread/turns/list' ? { data: [{ id: 't2', status: 'inProgress' }] } : codexFork('t2')(runtime, method),
    (runtime, method) => { if (method === 'thread/turns/list') throw new Error('thread not loaded'); return codexFork('t2')(runtime, method); },
  ]) {
    const next = await setup(t, behave);
    await refused(next.runtime.branch(codexRequest({ throughTurnId: 't2' })), 'native_refused', false);
    assert.deepEqual(next.runtimes[0].of('thread/delete'), [{ threadId: 'fork-1' }]);
    assert.equal(next.runtimes[0].closed, true);
  }

  // When the fork cannot be deleted either, it may still exist.
  const stuck = await setup(t, (runtime, method) => { if (method === 'thread/delete') throw new Error('cannot delete'); return codexFork('t1')(runtime, method); });
  await refused(stuck.runtime.branch(codexRequest({ throughTurnId: 't2' })), 'native_refused', true);
  assert.equal(stuck.runtimes[0].closed, true);
});

test('Codex refusals map to conversation reasons, and an unanswered fork has an unknown outcome', async t => {
  const cases = [
    [new Error('turn not found: t2'), 'boundary_unmapped', false],
    [new Error("lastTurnId 't2' identifies an in-progress turn"), 'session_busy', false],
    [new Error('no rollout found for thread id source'), 'native_refused', false],
    [unanswered('Codex app-server exited (1)'), 'native_refused', true],
    [unanswered('Runtime request timed out: thread/fork'), 'native_refused', true],
  ];
  for (const [error, reason, unknown] of cases) {
    const { runtime, runtimes } = await setup(t, (runtime, method) => { if (method === 'thread/fork') throw error; });
    await refused(runtime.branch(codexRequest({ throughTurnId: 't2' })), reason, unknown);
    assert.equal(runtimes[0].closed, true, 'the app-server always stops');
    assert.deepEqual(runtimes[0].of('thread/delete'), []);
  }
  // A fork answered without a thread id may exist.
  const blank = await setup(t, (runtime, method) => method === 'thread/fork' ? { thread: {} } : undefined);
  await refused(blank.runtime.branch(codexRequest({ throughTurnId: 't2' })), 'native_refused', true);
  assert.equal(blank.runtimes[0].closed, true);
  // An app-server that does not start has done nothing.
  const failing = createAlpRuntime({ supervisor: false, transport: () => ({ async initialize() { throw new Error('spawn codex ENOENT'); }, onNotification() {}, onFailure() {}, async request() {}, async close() { failing.closedTransport = true; } }) });
  t.after(() => failing.shutdown());
  await refused(failing.branch(codexRequest({ throughTurnId: 't2' })), 'native_refused', false);
  assert.equal(failing.closedTransport, true);
});

test('cuts ALP cannot map are refused before Codex is asked, and other runtimes cannot branch', async t => {
  const { runtime, runtimes } = await setup(t, codexFork('t1'));
  await refused(runtime.branch(codexRequest({ beforeTurnId: 't1' })), 'empty_prefix');
  await refused(runtime.branch(codexRequest(undefined, { turns: [] })), 'empty_prefix');
  await refused(runtime.branch(codexRequest({ throughTurnId: 'elsewhere' })), 'boundary_unmapped');
  await refused(runtime.branch(codexRequest({ beforeTurnId: 'elsewhere' })), 'boundary_unmapped');
  await refused(runtime.branch({ ...codexRequest({ throughTurnId: 't1' }), runtime: 'acp' }), 'runtime_unsupported');
  await refused(runtime.branch({ ...codexRequest({ throughTurnId: 't1' }), runtime: 'antigravity' }), 'runtime_unsupported');
  assert.equal(runtimes.length, 0, 'no app-server started');
});

// A Claude transcript's main chain: T1 plain, T2 with a tool call and its result, T3 plain.
const chain = [
  { uuid: 'p1', type: 'user' }, { uuid: 'a1', type: 'assistant' },
  { uuid: 'p2', type: 'user' }, { uuid: 'a2', type: 'assistant' }, { uuid: 'r2', type: 'user', toolResult: true }, { uuid: 'a2b', type: 'assistant' },
  { uuid: 'p3', type: 'user' }, { uuid: 'a3', type: 'assistant' },
];
const claudeRequest = (cutoff, extra = {}) => ({ runtime: 'claude', source: { threadId: 'S' }, cwd: '/work/source', model: 'sonnet', thinking: 'high', mode: 'workspace-write', turns: ['p1', 'p2', 'p3'], ...(cutoff ? { cutoff } : {}), ...extra });
const transcripts = sessions => (runtime, method, params) => method === 'thread/chain' ? { entries: sessions[params.threadId] ?? [] } : undefined;

test('a Claude branch validates the cut against the transcript and changes nothing', async t => {
  const { runtime, runtimes } = await setup(t, transcripts({ S: chain }));
  const cut = async cutoff => {
    const binding = await runtime.branch(claudeRequest(cutoff));
    assert.match(binding.threadId, /^[0-9a-f-]{36}$/);
    assert.equal(binding.base.threadId, 'S');
    return binding.base.at;
  };
  assert.equal(await cut({ beforeTurnId: 'p2' }), 'a1');
  assert.equal(await cut({ beforeTurnId: 'p3' }), 'a2b', 'a tool call and its result stay with their turn');
  assert.equal(await cut({ throughTurnId: 'p1' }), 'a1');
  assert.equal(await cut({ throughTurnId: 'p2' }), 'a2b');
  // Through the last turn, or the whole conversation: pinned at its last entry, so later turns never join it.
  assert.equal(await cut({ throughTurnId: 'p3' }), 'a3');
  assert.equal(await cut(undefined), 'a3');
  const first = await runtime.branch(claudeRequest({ beforeTurnId: 'p2' }));
  const second = await runtime.branch(claudeRequest({ beforeTurnId: 'p2' }));
  assert.notEqual(first.threadId, second.threadId);

  await refused(runtime.branch(claudeRequest({ beforeTurnId: 'p1' })), 'empty_prefix');
  await refused(runtime.branch(claudeRequest({ throughTurnId: 'missing' })), 'boundary_unmapped');
  await refused(runtime.branch(claudeRequest({ beforeTurnId: 'r2' })), 'boundary_unmapped', false);
  // A turn ALP knows that the transcript does not have (a Claude turn started by itself has another id).
  await refused(runtime.branch(claudeRequest({ beforeTurnId: 'p4' }, { turns: ['p1', 'p2', 'p3', 'p4'] })), 'boundary_unmapped');
  // A transcript turn ALP's timeline does not list.
  await refused(runtime.branch(claudeRequest({ beforeTurnId: 'p3' }, { turns: ['p1', 'p2'] })), 'boundary_unmapped');
  // Turns in another order than ALP's.
  await refused(runtime.branch(claudeRequest({ beforeTurnId: 'p2' }, { turns: ['p1', 'p3', 'p2'] })), 'boundary_unmapped');

  for (const claude of runtimes) {
    assert.equal(claude.kind, 'claude');
    assert.equal(claude.closed, true);
    assert.deepEqual([...new Set(claude.calls.map(call => call.method))], ['thread/chain'], 'only the transcript is read');
    assert.equal(claude.calls[0].params.cwd, '/work/source');
  }
});

test('a Claude turn ALP does not list, between two it does, belongs to the turn before it', async t => {
  const steered = [
    { uuid: 'p1', type: 'user' }, { uuid: 'a1', type: 'assistant' },
    { uuid: 'self', type: 'user' }, { uuid: 'aself', type: 'assistant' },
    { uuid: 'p2', type: 'user' }, { uuid: 'a2', type: 'assistant' },
  ];
  const { runtime } = await setup(t, transcripts({ S: steered }));
  assert.equal((await runtime.branch(claudeRequest({ throughTurnId: 'p1' }, { turns: ['p1', 'p2'] }))).base.at, 'aself');
  assert.equal((await runtime.branch(claudeRequest({ beforeTurnId: 'p2' }, { turns: ['p1', 'p2'] }))).base.at, 'aself');
});

test('a Claude source that is still a pending fork stands for its base cut at its own point', async t => {
  const { runtime } = await setup(t, transcripts({ S: chain, N: [] }));
  const pending = { threadId: 'N', base: { threadId: 'S', at: 'a2b' } };
  const branch = cutoff => runtime.branch(claudeRequest(cutoff, { source: pending, turns: ['p1', 'p2'] }));
  assert.deepEqual((await branch({ beforeTurnId: 'p2' })).base, { threadId: 'S', at: 'a1' });
  assert.deepEqual((await branch({ throughTurnId: 'p2' })).base, { threadId: 'S', at: 'a2b' });
  assert.deepEqual((await branch(undefined)).base, { threadId: 'S', at: 'a2b' });
  await refused(runtime.branch(claudeRequest({ throughTurnId: 'p3' }, { source: pending })), 'boundary_unmapped', false);
  // Its base without the entry it was cut at.
  await refused(runtime.branch(claudeRequest(undefined, { source: { threadId: 'N', base: { threadId: 'S', at: 'gone' } } })), 'native_refused');
  // A pending fork whose first prompt made it is read itself.
  const made = await setup(t, transcripts({ S: chain, N: [...chain.slice(0, 2), { uuid: 'q1', type: 'user' }, { uuid: 'b1', type: 'assistant' }] }));
  assert.deepEqual((await made.runtime.branch(claudeRequest({ beforeTurnId: 'q1' }, { source: pending, turns: ['p1', 'q1'] }))).base, { threadId: 'N', at: 'a1' });
  // An empty conversation has nothing to fork.
  const empty = await setup(t, transcripts({}));
  await refused(empty.runtime.branch(claudeRequest(undefined)), 'empty_prefix');
  await refused(empty.runtime.branch(claudeRequest({ beforeTurnId: 'p2' })), 'boundary_unmapped');
  // A transcript that cannot be read refuses.
  const broken = await setup(t, (runtime, method) => { if (method === 'thread/chain') throw new Error('EACCES'); });
  await refused(broken.runtime.branch(claudeRequest({ beforeTurnId: 'p2' })), 'native_refused', false);
  assert.equal(broken.runtimes[0].closed, true);
});

test('rebind moves an idle root to another conversation, keeping its id and configuration', async t => {
  const { root, runtime, runtimes, of, prompt } = await setup(t);
  await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.5', thinking: 'high' });
  await prompt('root', 'one');
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').busy);
  const before = runtime.snapshot('root');
  const snapshot = await runtime.rebind('root', { threadId: 'fork-1' });
  assert.equal(snapshot.threadId, 'fork-1');
  assert.equal(snapshot.id, 'root');
  assert.deepEqual({ ...snapshot, threadId: before.threadId }, before);
  assert.deepEqual(of('root', 'session.updated').at(-1).session, snapshot);
  assert.equal(runtimes[0].closed, true, 'the old process stopped');
  const [resume] = runtimes[1].of('thread/resume');
  assert.equal(resume.threadId, 'fork-1');
  assert.equal(resume.model, runtimes[0].of('thread/start')[0].model);
  assert.equal('base' in resume || 'requireHistory' in resume, false, 'Codex gets no Claude options');
  // The next prompt continues the new conversation in the new process.
  await prompt('root', 'two');
  assert.equal(runtimes[1].of('turn/start')[0].threadId, 'fork-1');
  runtimes[1].finish();
  await until(() => !runtime.snapshot('root').busy);
  // A reload: the same seam reopens its own conversation.
  assert.equal((await runtime.rebind('root', { threadId: 'fork-1' })).threadId, 'fork-1');
  assert.equal(runtimes[2].of('thread/resume')[0].threadId, 'fork-1');
  assert.equal(runtimes[1].closed, true);
});

test('a Claude root opens, rebinds and revives with its base until its first prompt makes the fork', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t);
  const base = { threadId: 'S', at: 'a1' };
  await runtime.open('root', { cwd: root, persist: true, model: 'claude:sonnet', restore: { agent: 'main', threadId: 'N', runtime: 'claude', model: 'sonnet', base } });
  assert.deepEqual(runtimes[0].of('thread/resume')[0].base, base);
  // Revive after the process dies keeps the base.
  runtimes[0].failure(new Error('Claude session exited'));
  await until(() => runtimes[1]?.of('thread/resume').length);
  assert.deepEqual(runtimes[1].of('thread/resume')[0], { ...runtimes[1].of('thread/resume')[0], threadId: 'N', base });
  await until(() => !runtime.snapshot('root').busy);
  // Rebind to another pending fork, then to a made conversation, which must exist.
  await runtime.rebind('root', { threadId: 'M', base: { threadId: 'S' } });
  assert.deepEqual(runtimes[2].of('thread/resume')[0].base, { threadId: 'S' });
  await runtime.rebind('root', { threadId: 'M' });
  const [plain] = runtimes[3].of('thread/resume');
  assert.equal(plain.requireHistory, true);
  assert.equal('base' in plain, false);
  await prompt('root', 'one');
  assert.equal(runtimes[3].of('turn/start')[0].threadId, 'M');
  // A Codex root has no base.
  const codex = await setup(t);
  await assert.rejects(codex.runtime.open('root', { cwd: codex.root, model: 'codex:gpt-5.5', restore: { agent: 'main', threadId: 'T', runtime: 'codex', model: 'gpt-5.5', base } }), /only Claude/);
  await codex.runtime.open('other', { cwd: codex.root, model: 'codex:gpt-5.5' });
  await refused(codex.runtime.rebind('other', { threadId: 'x', base }), 'runtime_unsupported');
});

test('a rebind that cannot open the new conversation reopens the old one; when neither opens the session fails', async t => {
  let refuse = new Set(['fork-1']);
  const { root, runtime, runtimes, of } = await setup(t, (runtime, method, params) => {
    if (method === 'thread/resume' && refuse.has(params.threadId)) throw new Error(`no rollout found for thread id ${params.threadId}`);
  });
  await runtime.open('root', { cwd: root, persist: true });
  const old = runtime.snapshot('root').threadId;
  const error = await refused(runtime.rebind('root', { threadId: 'fork-1' }), 'native_refused', false);
  assert.match(error.message, /no rollout found/);
  assert.equal(runtime.snapshot('root').threadId, old);
  assert.equal(runtime.snapshot('root').busy, false);
  assert.deepEqual(runtimes.map(r => r.of('thread/resume').map(p => p.threadId)), [[], ['fork-1'], [old]]);
  assert.deepEqual(runtimes.map(r => r.closed), [true, true, false]);
  assert.equal(of('root', 'session.updated').length, 0);
  // An unanswered resume may have opened: the refusal says so.
  const flaky = await setup(t, (runtime, method, params) => { if (method === 'thread/resume' && params.threadId === 'fork-2') throw unanswered('Runtime request timed out: thread/resume'); });
  await flaky.runtime.open('root', { cwd: flaky.root, persist: true });
  await refused(flaky.runtime.rebind('root', { threadId: 'fork-2' }), 'native_refused', true);
  assert.ok(flaky.runtime.snapshot('root'));
  // A failure reported while the new process resumes fails the rebind too.
  const dying = await setup(t, (runtime, method, params) => { if (method === 'thread/resume' && params.threadId === 'fork-3') runtime.failure?.(new Error('exited')); });
  await dying.runtime.open('root', { cwd: dying.root, persist: true });
  await refused(dying.runtime.rebind('root', { threadId: 'fork-3' }), 'native_refused');
  assert.notEqual(dying.runtime.snapshot('root').threadId, 'fork-3');

  refuse = new Set(['fork-1', old]);
  await refused(runtime.rebind('root', { threadId: 'fork-1' }), 'native_refused');
  assert.equal(runtime.snapshot('root'), undefined);
  assert.equal(of('root', 'session.failed').length, 1);
});

test('rebind refuses unless the whole tree is idle', async t => {
  const { root, runtime, runtimes, of, prompt } = await setup(t, undefined, { autoResume: false, recoveryResume: false });
  await refused(runtime.rebind('nobody', { threadId: 'x' }), 'session_busy');
  await runtime.open('root', { cwd: root, persist: true });
  const rebind = () => runtime.rebind('root', { threadId: 'fork-1' });

  // A running turn.
  await prompt('root', 'one');
  await refused(rebind(), 'session_busy');
  // A running assignment, and its child session, which is no root.
  await runtimes[0].call('alp_delegate', { agent: 'lead', task: 'Work', wait: false });
  await until(() => runtimes[1]?.of('turn/start').length);
  const child = of('root', 'assignment')[0].assignment.id;
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').activeTurnId);
  await refused(rebind(), 'session_busy');
  await refused(runtime.rebind(child, { threadId: 'fork-1' }), 'session_busy');
  await runtimes[1].call('alp_handoff', { outcome: 'complete', summary: 'Done' });
  runtimes[1].finish();
  // Its result wakes the root; that turn ends too.
  await until(() => runtimes[0].of('turn/start').length === 2);
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').busy);

  // Unread mail, which an interrupt holds until the next prompt.
  await prompt('root', 'two');
  await runtime.interrupt('root');
  runtimes[0].finish('interrupted');
  await until(() => !runtime.snapshot('root').activeTurnId);
  runtime.message('root', 'A note from the user');
  await until(() => runtime.snapshot('root').busy);
  assert.equal(runtime.snapshot('root').activeTurnId, undefined);
  await refused(rebind(), 'session_busy');
  await prompt('root', 'three');
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').busy);

  // Parked work.
  await runtime.recover('root', { parkedRoot: 'alpd restarted' });
  assert.ok(runtime.snapshot('root').parked);
  await refused(rebind(), 'session_busy');
  assert.equal(runtimes.filter(r => r.of('thread/resume').some(p => p.threadId === 'fork-1')).length, 0, 'nothing restarted');
  assert.equal(runtimes[0].closed, false);
});

test('a lifecycle hold keeps mail from waking the root; rebind is not refused for it; release wakes the new conversation', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t);
  assert.equal(runtime.hold('nobody'), undefined);
  await runtime.open('root', { cwd: root, persist: true });
  await prompt('root', 'one');
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').busy);
  const release = runtime.hold('root');
  runtime.message('root', 'A note while the conversation changes');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(runtimes[0].of('turn/start').length, 1, 'no wake while held');
  // The mail waits for the hold, so the rebind goes ahead.
  await runtime.rebind('root', { threadId: 'fork-1' });
  const now = runtimes.at(-1);
  assert.notEqual(now, runtimes[0]);
  release();
  release();
  await until(() => now.of('turn/start').length === 1);
  assert.equal(now.of('turn/start')[0].threadId, 'fork-1');
});

test('starting: a mail wake whose turn/start is in flight has no turn id yet but is starting; a hold taken then does not stop it', async t => {
  let gate;
  const { root, runtime, runtimes, prompt } = await setup(t, async (transport, method) => {
    if (method === 'turn/start' && gate) await gate.promise;
    return undefined;
  });
  assert.equal(runtime.starting('nobody'), false);
  await runtime.open('root', { cwd: root, persist: true });
  await prompt('root', 'one');
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').busy);
  assert.equal(runtime.starting('root'), false, 'idle');
  let open;
  gate = { promise: new Promise(resolve => { open = resolve; }) };
  let release;
  // Opened however the checks end: a turn/start left waiting would keep the runtime from shutting down.
  try {
    runtime.message('root', 'A note that wakes the root');
    await until(() => runtimes[0].of('turn/start').length === 2);
    assert.equal(runtime.snapshot('root').activeTurnId, undefined, 'no turn id yet');
    assert.equal(runtime.starting('root'), true, 'the wake is starting its turn');
    // A lifecycle hold keeps later wakes back; it cannot call back one already sent.
    release = runtime.hold('root');
    assert.equal(runtime.starting('root'), true);
  } finally { gate = undefined; open(); }
  await until(() => runtime.snapshot('root').activeTurnId);
  assert.equal(runtime.starting('root'), false, 'started: the turn has its id');
  release();
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').busy);
  assert.equal(runtime.starting('root'), false);
});

test('a parked root resumed during a lifecycle hold stays parked until the hold ends, then continues; a pause at that moment keeps it parked', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root, persist: true });
  await prompt('root', 'one');
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').busy);
  const kind = runtime.snapshot('root').runtime;
  const resumes = () => runtimes[0].of('turn/start').filter(params => JSON.stringify(params).includes("Continue the user's request where you stopped")).length;
  for (const pausedAtRelease of [true, false]) {
    runtime.pause({ runtime: kind });
    // New recovery continuation blocked solely by this pause has a known scope.
    // Legacy parkedRoot reason strings cannot establish that authority.
    await runtime.recover('root', { continueRoot: true });
    assert.ok(runtime.snapshot('root').parked);
    const before = resumes();
    const release = runtime.hold('root');
    runtime.resume({ runtime: kind });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(resumes(), before, 'no turn while held');
    assert.ok(runtime.snapshot('root').parked, 'still parked while held');
    if (pausedAtRelease) {
      // Paused again before the hold ends: the root stays parked, and the next resume continues it.
      runtime.pause({ runtime: kind });
      release();
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(resumes(), before, 'no turn while paused');
      assert.ok(runtime.snapshot('root').parked, 'still parked while paused');
      runtime.resume({ runtime: kind });
    } else release();
    await until(() => resumes() === before + 1);
    assert.equal(runtime.snapshot('root').parked, undefined);
    await until(() => runtime.snapshot('root').activeTurnId);
    runtimes[0].finish();
    await until(() => !runtime.snapshot('root').busy);
  }
});

test('mail that arrives while a rebind resumes waits for it without stalling the process, held or not', async t => {
  let gate;
  const { root, runtime, runtimes, prompt } = await setup(t, async (transport, method, params) => {
    if (method === 'thread/resume' && params.threadId?.startsWith('fork-')) await new Promise(resolve => { gate = resolve; });
    return undefined;
  });
  await runtime.open('root', { cwd: root, persist: true });
  await prompt('root', 'one');
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').busy);
  for (const holdIt of [false, true]) {
    gate = undefined;
    const release = holdIt ? runtime.hold('root') : undefined;
    const target = holdIt ? 'fork-2' : 'fork-1';
    const rebinding = runtime.rebind('root', { threadId: target });
    await until(() => gate);
    runtime.message('root', `A note during the rebind (${holdIt ? 'held' : 'not held'})`);
    // The event loop goes on: a timer fires while the resume waits.
    let fired = false;
    setTimeout(() => { fired = true; }, 5);
    await until(() => fired);
    gate();
    await rebinding;
    release?.();
    const now = runtimes.at(-1);
    await until(() => now.of('turn/start').length === 1);
    assert.equal(now.of('turn/start')[0].threadId, target);
    now.finish();
    await until(() => !runtime.snapshot('root').busy);
  }
});

test('mail that arrives while a session first opens waits for it without stalling the process, opened or failed', async t => {
  for (const fails of [false, true]) {
    let gate;
    const { root, runtime, runtimes } = await setup(t, async (transport, method) => {
      if (method !== 'thread/start') return undefined;
      await new Promise(resolve => { gate = resolve; });
      if (fails) throw new Error('thread/start failed');
      return undefined;
    });
    const opening = runtime.open('root', { cwd: root, persist: true });
    await until(() => gate);
    runtime.message('root', `A note while the session opens (${fails ? 'fails' : 'opens'})`);
    // The event loop goes on: a timer fires while thread/start waits.
    let fired = false;
    setTimeout(() => { fired = true; }, 5);
    await until(() => fired);
    gate();
    if (fails) {
      await assert.rejects(opening, /thread\/start failed/);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(runtimes[0].of('turn/start').length, 0, 'a session that did not open starts no turn');
      continue;
    }
    await opening;
    // The note wakes the session once it is open.
    await until(() => runtimes[0].of('turn/start').length === 1);
    runtimes[0].finish();
    await until(() => !runtime.snapshot('root').busy);
  }
});

test('mail that reaches an assignment while it first opens rides with its brief, in one turn', async t => {
  let gate;
  const { root, runtime, runtimes, of, prompt } = await setup(t, async (transport, method) => {
    if (method === 'thread/start' && transport.index === 1) await new Promise(resolve => { gate = resolve; });
    return undefined;
  });
  await runtime.open('root', { cwd: root, persist: true });
  await prompt('root', 'one');
  const delegating = runtimes[0].call('alp_delegate', { agent: 'lead', task: 'THE BRIEF', wait: false });
  await until(() => gate);
  const child = of('root', 'assignment')[0].assignment.id;
  await runtimes[0].call('alp_send', { to: child, kind: 'note', body: 'EARLY MAIL' });
  gate();
  await delegating;
  await until(() => runtimes[1].of('turn/start').length);
  // Nothing else starts: a second turn would overlap the brief's.
  await new Promise(resolve => setTimeout(resolve, 50));
  const turns = runtimes[1].of('turn/start').map(params => JSON.stringify(params));
  assert.equal(turns.length, 1, turns.join('\n'));
  assert.match(turns[0], /THE BRIEF/);
  assert.match(turns[0], /EARLY MAIL/);
});

test('an assignment whose brief does not start runs no turn on the mail that waited for it', async t => {
  let gate;
  const { root, runtime, runtimes, of, prompt } = await setup(t, async (transport, method) => {
    if (transport.index !== 1) return undefined;
    if (method === 'thread/start') await new Promise(resolve => { gate = resolve; });
    if (method === 'turn/start') throw new Error('turn start refused');
    return undefined;
  });
  await runtime.open('root', { cwd: root, persist: true });
  await prompt('root', 'one');
  const delegating = runtimes[0].call('alp_delegate', { agent: 'lead', task: 'THE BRIEF', wait: false });
  await until(() => gate);
  const child = of('root', 'assignment')[0].assignment.id;
  await runtimes[0].call('alp_send', { to: child, kind: 'note', body: 'EARLY MAIL' });
  gate();
  const result = await delegating;
  assert.match(JSON.stringify(result), /turn start refused/);
  await until(() => runtimes[1].closed);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runtimes[1].of('turn/start').length, 1, 'only the brief was tried');
});

test('mail that reaches an assignment while its brief starts steers the brief turn once it runs', async t => {
  let gate;
  const { root, runtime, runtimes, of, prompt } = await setup(t, async (transport, method) => {
    if (transport.index === 1 && method === 'turn/start') await new Promise(resolve => { gate = resolve; });
    return undefined;
  });
  await runtime.open('root', { cwd: root, persist: true });
  await prompt('root', 'one');
  const delegating = runtimes[0].call('alp_delegate', { agent: 'lead', task: 'THE BRIEF', wait: false });
  await until(() => gate);
  const child = of('root', 'assignment')[0].assignment.id;
  await runtimes[0].call('alp_send', { to: child, kind: 'note', body: 'LATE MAIL' });
  gate();
  await delegating;
  await until(() => runtimes[1].calls.some(call => call.method !== 'turn/start' && JSON.stringify(call.params).includes('LATE MAIL')));
  assert.equal(runtimes[1].of('turn/start').length, 1);
  assert.doesNotMatch(JSON.stringify(runtimes[1].of('turn/start')[0]), /LATE MAIL/);
});

test('mail held for a brief whose turn ends while it starts wakes the assignment after it', async t => {
  let gate;
  const { root, runtime, runtimes, of, prompt } = await setup(t, async (transport, method, params) => {
    if (transport.index !== 1 || method !== 'turn/start' || transport.of('turn/start').length > 1) return undefined;
    await new Promise(resolve => { gate = resolve; });
    // The turn starts and ends before its start returns: its notifications are replayed after it.
    transport.turnId = 'brief-turn';
    transport.notification('turn/started', { threadId: params.threadId, turn: { id: 'brief-turn' } });
    transport.notification('item/completed', { threadId: params.threadId, item: { type: 'agentMessage', id: 'brief-output', text: 'done' } });
    transport.notification('turn/completed', { threadId: params.threadId, turn: { id: 'brief-turn', status: 'completed' } });
    return { turn: { id: 'brief-turn' } };
  });
  await runtime.open('root', { cwd: root, persist: true });
  await prompt('root', 'one');
  const delegating = runtimes[0].call('alp_delegate', { agent: 'lead', task: 'THE BRIEF', wait: false });
  await until(() => gate);
  const child = of('root', 'assignment')[0].assignment.id;
  await runtimes[0].call('alp_send', { to: child, kind: 'note', body: 'LATE MAIL' });
  gate();
  await delegating;
  await until(() => runtimes[1].calls.some(call => JSON.stringify(call.params).includes('LATE MAIL')));
  assert.doesNotMatch(JSON.stringify(runtimes[1].of('turn/start')[0]), /LATE MAIL/);
});

// ---- reload (§12.8): the same seam reopens a root's own conversation in a new process.

test('reload restarts an idle root on its own conversation, keeping its id and configuration', async t => {
  const { root, runtime, runtimes, of, prompt } = await setup(t);
  await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.5', thinking: 'high' });
  await runtime.configure('root', { mode: 'read-only' });
  await prompt('root', 'one');
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').busy);
  const before = runtime.snapshot('root');
  const snapshot = await runtime.reload('root');
  assert.deepEqual(snapshot, before, 'same id, thread, model, thinking and mode');
  assert.equal(snapshot.mode, 'read-only');
  assert.deepEqual(of('root', 'session.updated').at(-1).session, snapshot);
  assert.equal(runtimes[0].closed, true, 'the old process stopped');
  const [resume] = runtimes[1].of('thread/resume');
  assert.equal(resume.threadId, before.threadId);
  const started = runtimes[0].of('thread/start')[0];
  assert.equal(resume.model, started.model);
  assert.equal(resume.sandbox, 'read-only', 'the mode the session was configured to, not the one it started with');
  assert.equal(resume.developerInstructions, started.developerInstructions);
  assert.equal(runtimes[1].of('thread/start').length, 0, 'no new thread');
  await prompt('root', 'two');
  assert.equal(runtimes[1].of('turn/start')[0].threadId, before.threadId);
});

test('reload of a Claude root resumes only a conversation that exists; otherwise it closes, never starting an empty one', async t => {
  const transcripts = new Set(['N']);
  const { root, runtime, runtimes, of } = await setup(t, (runtime, method, params) => {
    if (method === 'thread/resume' && params.requireHistory && !transcripts.has(params.threadId)) throw new Error(`Claude session ${params.threadId} not found`);
  });
  await runtime.open('root', { cwd: root, persist: true, model: 'claude:sonnet', restore: { agent: 'main', threadId: 'N', runtime: 'claude', model: 'sonnet' } });
  await until(() => !runtime.snapshot('root').busy);
  await runtime.reload('root');
  assert.deepEqual(runtimes[1].of('thread/resume')[0], { ...runtimes[1].of('thread/resume')[0], threadId: 'N', requireHistory: true });
  // A pending fork (a base) reloads with its base.
  const base = { threadId: 'S', at: 'a1' };
  await runtime.rebind('root', { threadId: 'M', base });
  await runtime.reload('root');
  assert.deepEqual(runtimes[3].of('thread/resume')[0].base, base);
  assert.equal(runtime.snapshot('root').threadId, 'M');
  // A transcript that is gone: refused, the session closes with its binding, nothing is started.
  await runtime.rebind('root', { threadId: 'N' });
  transcripts.delete('N');
  const error = await refused(runtime.reload('root'), 'native_refused', false);
  assert.match(error.message, /not found/);
  assert.equal(runtime.snapshot('root'), undefined);
  assert.equal(of('root', 'session.closed').length, 1);
  assert.equal(of('root', 'session.failed').length, 0);
  assert.equal(runtimes.flatMap(r => r.of('thread/start')).length, 0, 'never an empty replacement thread');
  assert.equal(runtimes.at(-1).closed, true);
});

test('reload refuses unless the whole tree is idle', async t => {
  const { root, runtime, runtimes, of, prompt } = await setup(t, undefined, { autoResume: false, recoveryResume: false });
  await refused(runtime.reload('nobody'), 'session_busy');
  await runtime.open('root', { cwd: root, persist: true });
  await prompt('root', 'one');
  await refused(runtime.reload('root'), 'session_busy');
  await runtimes[0].call('alp_delegate', { agent: 'lead', task: 'Work', wait: false });
  await until(() => runtimes[1]?.of('turn/start').length);
  const child = of('root', 'assignment')[0].assignment.id;
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').activeTurnId);
  await refused(runtime.reload('root'), 'session_busy');
  await refused(runtime.reload(child), 'session_busy');
  assert.equal(runtimes.filter(r => r.of('thread/resume').length).length, 0, 'nothing restarted');
});

for (const resumeBeforeRestart of [true, false]) {
  test(`process restart continuation waits for its pause, resume before restart=${resumeBeforeRestart}`, async t => {
    let releaseRestart;
    const restarted = new Promise(resolve => { releaseRestart = resolve; });
    const { root, runtime, runtimes, prompt } = await setup(t, async (transport, method) => {
      if (transport.index === 2 && method === 'thread/resume') await restarted;
    });
    await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.6-sol' });
    await runtime.open('barrier', { cwd: root, persist: true });
    await prompt('root', 'work');
    runtimes[0].failure(new Error('process exited'));
    try {
      await until(() => runtimes[2]?.of('thread/resume').length === 1);
      runtime.pause({ runtime: 'codex' });
      runtime.resume({ runtime: 'claude' });
      if (resumeBeforeRestart) runtime.resume({ runtime: 'codex' });
    } finally { releaseRestart(); }
    await until(() => !runtime.starting('root'));
    await runtime.recover('barrier');
    if (!resumeBeforeRestart) {
      assert.equal(runtimes[2].of('turn/start').length, 0);
      runtime.resume({ runtime: 'claude' });
      await runtime.recover('barrier');
      assert.equal(runtimes[2].of('turn/start').length, 0);
      runtime.resume({ runtime: 'codex' });
    }
    await until(() => runtimes[2].of('turn/start').length === 1);
    assert.equal(runtime.snapshot('root').parked, undefined);
  });
}

test('native process replacement does not give manual recovery roots automatic resume authority', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t, undefined, { recoveryResume: false });
  await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.6-sol' });
  await runtime.open('barrier', { cwd: root, persist: true });
  await prompt('root', 'work');
  runtimes[0].finish();
  await runtime.recover('root', { continueRoot: true });
  const reason = runtime.snapshot('root').parked;
  runtimes[0].failure(new Error('idle parked process exited'));
  await until(() => runtimes[2]?.of('thread/resume').length === 1 && !runtime.starting('root'));
  runtime.resume({ runtime: 'codex' });
  runtime.resume();
  await runtime.recover('barrier');
  assert.equal(runtimes[2].of('turn/start').length, 0);
  assert.equal(runtime.snapshot('root').parked, reason);
  await prompt('root', 'explicit recovery', 'Continue');
  assert.equal(runtimes[2].of('turn/start').length, 1);
});

for (const scope of ['codex', 'all']) {
  test(`process restart queued before pause retains its blocker for ${scope} resume`, async t => {
    let releaseQueue;
    const blocked = new Promise(resolve => { releaseQueue = resolve; });
    const { root, runtime, runtimes, prompt } = await setup(t, async (transport, method) => {
      if (transport.index === 1 && method === 'turn/start') await blocked;
    });
    await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.6-sol' });
    await runtime.open('blocker', { cwd: root, persist: true });
    await runtime.open('barrier', { cwd: root, persist: true });
    await prompt('root', 'work');
    const blocking = prompt('blocker', 'block queue');
    try {
      await until(() => runtimes[1].of('turn/start').length === 1);
      runtimes[0].failure(new Error('process exited'));
      await until(() => runtimes[3]?.of('thread/resume').length === 1 && !runtime.starting('root'));
      runtime.pause({ runtime: 'codex' });
    } finally { releaseQueue(); }
    await blocking;
    await runtime.recover('barrier');
    assert.equal(runtimes[3].of('turn/start').length, 0, 'queued restart obeyed the new pause');
    assert.ok(runtime.snapshot('root').parked);
    runtime.resume({ runtime: 'claude' });
    await runtime.recover('barrier');
    assert.equal(runtimes[3].of('turn/start').length, 0, 'wrong provider cannot release the restart');
    if (scope === 'all') runtime.resume();
    else runtime.resume({ runtime: scope });
    await runtime.recover('barrier');
    assert.equal(runtimes[3].of('turn/start').length, 1, 'matching resume releases the captured restart park');
    assert.match(JSON.stringify(runtimes[3].of('turn/start')[0]), /ALP restarted your/);
    runtime.resume({ runtime: 'codex' });
    runtime.resume();
    await runtime.recover('barrier');
    assert.equal(runtimes[3].of('turn/start').length, 1, 'repeated resumes cannot replay the continuation');
    assert.equal(runtime.snapshot('root').parked, undefined);
  });
}

test('a queued process restart cannot mark replacement manual recovery as paused', async t => {
  let releaseQueue;
  const blocked = new Promise(resolve => { releaseQueue = resolve; });
  const { root, runtime, runtimes, prompt } = await setup(t, async (transport, method) => {
    if (transport.index === 1 && method === 'turn/start') await blocked;
  });
  await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.6-sol' });
  await runtime.open('blocker', { cwd: root, persist: true });
  await runtime.open('barrier', { cwd: root, persist: true });
  await prompt('root', 'work');
  const blocking = prompt('blocker', 'block queue');
  let replacement;
  try {
    await until(() => runtimes[1].of('turn/start').length === 1);
    // This replacement enters the queue before revive enqueues its continuation.
    replacement = runtime.recover('root', { parkedRoot: 'manual recovery replacement' });
    runtimes[0].failure(new Error('process exited'));
    await until(() => runtimes[3]?.of('thread/resume').length === 1 && !runtime.starting('root'));
    runtime.pause({ runtime: 'codex' });
  } finally { releaseQueue(); }
  await blocking;
  await replacement;
  await runtime.recover('barrier');
  runtime.resume({ runtime: 'codex' });
  runtime.resume();
  await runtime.recover('barrier');
  assert.equal(runtimes[3].of('turn/start').length, 0, 'stale restart cannot attach pause authority to replacement');
  assert.equal(runtime.snapshot('root').parked, 'manual recovery replacement');
  await prompt('root', 'explicit replacement resume', 'Continue');
  assert.equal(runtimes[3].of('turn/start').length, 1);
});
