// Live configure in the runtime (docs/protocol/alp-json-rpc-v1.md §12.9, issue #121 branch D):
// previewConfigure() resolves what a change would run, reconfigure() restarts an idle root's native
// process with it on the same conversation and takes it only once the runtime did. Fakes; no model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { ConversationError, createAlpRuntime } from '@anhlp/alp-runtime';

/**
 * Fake transports. thread/resume and thread/start answer the model they were asked for, as Codex does;
 * `behave(runtime, method, params)` may answer first.
 */
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
        if (method === 'thread/resume') return { thread: { id: params.threadId }, model: params.model, reasoningEffort: params.thinking };
        if (method.startsWith('thread/')) return { thread: { id: this.threadId }, model: params?.model };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      finish() {
        this.notification('item/completed', { threadId: this.lastThread(), item: { type: 'agentMessage', id: `output-${index}-${turns}`, text: 'done' } });
        this.notification('turn/completed', { threadId: this.lastThread(), turn: { id: this.turnId, status: 'completed' } });
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

/** A project whose settings run Phở (init's), with the runtime's run log kept. */
async function setup(t, behave, options = {}, settings) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-configure-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  if (settings) {
    const file = path.join(root, '.alp/settings.json');
    await writeFile(file, JSON.stringify(settings(JSON.parse(await readFile(file, 'utf8')))));
  }
  const runtimes = [];
  const runLogDir = path.join(directory, 'runs');
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes, behave), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir, ...options });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const envelopes = [];
  runtime.onEvent(envelope => envelopes.push(envelope));
  const of = (sessionId, type) => envelopes.filter(e => e.sessionId === sessionId && e.event.type === type).map(e => e.event);
  const prompt = (sessionId, id, text = 'go') => runtime.prompt(sessionId, { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text }] });
  const runLog = async rootId => (await readFile(path.join(runLogDir, `${rootId}.jsonl`), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, root, runtime, runtimes, of, prompt, runLog };
}

async function refused(promise, reason) {
  const error = await promise.then(() => assert.fail(`expected a refusal (${reason})`), error => error);
  assert.ok(error instanceof ConversationError, `not a ConversationError: ${error?.stack ?? error}`);
  assert.equal(error.data.reason, reason, error.message);
  assert.equal(error.outcomeUnknown, false, error.message);
  return error;
}

/** An idle Codex root on Phở with one finished turn. */
async function idleRoot(t, behave, options, settings) {
  const context = await setup(t, behave, options, settings);
  await context.runtime.open('root', { cwd: context.root, persist: true, model: 'codex:gpt-5.6-sol', thinking: 'medium' });
  await context.prompt('root', 'one');
  context.runtimes[0].finish();
  await until(() => !context.runtime.snapshot('root').busy);
  return context;
}

test('a model and effort change restarts the root on the same conversation with them, after Codex echoes the model', async t => {
  const { runtime, runtimes, of, prompt, runLog } = await idleRoot(t);
  const before = runtime.snapshot('root');
  const preview = await runtime.previewConfigure('root', { model: 'codex:gpt-6.1-sol', thinking: 'high' });
  assert.deepEqual(preview.changes, ['model', 'thinking']);
  assert.equal(preview.allowed, true);
  assert.equal(preview.restart, true);
  assert.equal(preview.current.model, 'gpt-5.6-sol');
  assert.equal(preview.proposed.model, 'gpt-6.1-sol');
  assert.equal(preview.proposed.thinking, 'high');
  assert.equal(preview.proposed.team, 'pho');
  assert.ok(preview.teams.some(team => team.id === 'cafe'));
  assert.equal(runtimes.length, 1, 'a preview starts nothing');

  const result = await runtime.reconfigure('root', { model: 'codex:gpt-6.1-sol', thinking: 'high' });
  assert.equal(result.status, 'applied');
  assert.equal(result.restarted, true);
  assert.deepEqual(result.native, { model: 'gpt-6.1-sol', reasoningEffort: 'high' });
  assert.equal(result.effective.model, 'gpt-6.1-sol');
  assert.equal(result.session.id, 'root');
  assert.equal(result.session.threadId, before.threadId, 'same conversation');
  assert.equal(result.session.model, 'gpt-6.1-sol');
  assert.equal(result.session.thinking, 'high');
  assert.deepEqual(of('root', 'session.updated').at(-1).session, result.session);
  assert.equal(runtimes[0].closed, true);
  const [resume] = runtimes[1].of('thread/resume');
  assert.equal(resume.threadId, before.threadId);
  assert.equal(resume.model, 'gpt-6.1-sol');
  assert.equal(resume.thinking, 'high');
  // The next turn names the model and effort to Codex.
  await prompt('root', 'two');
  const [turn] = runtimes[1].of('turn/start');
  assert.equal(turn.model, 'gpt-6.1-sol');
  assert.equal(turn.effort, 'high');
  assert.equal(turn.threadId, before.threadId);
  await until(async () => (await runLog('root')).some(entry => entry.event === 'session.configured'));
  const configured = (await runLog('root')).find(entry => entry.event === 'session.configured');
  assert.deepEqual(configured.from, { model: 'gpt-5.6-sol', thinking: 'medium', team: 'pho', mode: 'full-access' });
  assert.deepEqual(configured.to, { model: 'gpt-6.1-sol', thinking: 'high', team: 'pho', mode: 'full-access' });
  assert.deepEqual(configured.native, { model: 'gpt-6.1-sol', reasoningEffort: 'high' });
});

test('the same configuration again is unchanged and restarts nothing', async t => {
  const { runtime, runtimes } = await idleRoot(t);
  const result = await runtime.reconfigure('root', { model: 'gpt-5.6-sol', thinking: 'medium', team: 'pho' });
  assert.equal(result.status, 'unchanged');
  assert.equal(result.restarted, false);
  assert.equal(runtimes.length, 1);
});

test('a model the runtime does not echo, or a resume it refuses, keeps the old configuration on the same conversation', async t => {
  let mode = 'echo-other';
  const { runtime, runtimes, of } = await idleRoot(t, (fake, method, params) => {
    if (method !== 'thread/resume' || params.model !== 'gpt-6.1-sol') return undefined;
    if (mode === 'echo-other') return { thread: { id: params.threadId }, model: 'gpt-5.6-sol' };
    throw new Error('model gpt-6.1-sol is not available');
  });
  const before = runtime.snapshot('root');
  const updates = of('root', 'session.updated').length;
  const error = await refused(runtime.reconfigure('root', { model: 'gpt-6.1-sol' }), 'native_refused');
  assert.match(error.message, /gpt-5\.6-sol, not gpt-6\.1-sol/);
  assert.deepEqual(runtime.snapshot('root'), before, 'nothing changed');
  assert.equal(of('root', 'session.updated').length, updates, 'no descriptor with the new model was emitted');
  assert.equal(runtimes[2].of('thread/resume')[0].model, 'gpt-5.6-sol', 'restarted with its own model');
  assert.equal(runtimes[2].of('thread/resume')[0].threadId, before.threadId);

  mode = 'throw';
  const refusal = await refused(runtime.reconfigure('root', { model: 'gpt-6.1-sol' }), 'native_refused');
  assert.match(refusal.message, /not available/);
  assert.deepEqual(runtime.snapshot('root'), before);
  assert.equal(runtimes[4].of('thread/resume')[0].model, 'gpt-5.6-sol');
});

test('a restart that cannot come back on either configuration fails the session, keeping nothing new', async t => {
  const { runtime, of } = await idleRoot(t, (fake, method) => {
    if (method === 'thread/resume') throw new Error('codex is gone');
    return undefined;
  });
  await refused(runtime.reconfigure('root', { model: 'gpt-6.1-sol' }), 'native_refused');
  await until(() => !runtime.snapshot('root'));
  assert.equal(of('root', 'session.failed').length, 1);
  assert.equal(of('root', 'session.updated').some(event => event.session.model === 'gpt-6.1-sol'), false);
});

test('another runtime, an unknown model or effort, or an unknown team is refused before anything restarts', async t => {
  const { runtime, runtimes } = await idleRoot(t);
  const before = runtime.snapshot('root');
  const migration = await refused(runtime.reconfigure('root', { model: 'claude:claude-opus-5-5' }), 'runtime_mismatch');
  assert.match(migration.message, /new session/);
  const preview = await runtime.previewConfigure('root', { model: 'claude/sonnet' });
  assert.equal(preview.allowed, false);
  assert.equal(preview.reason, 'runtime_mismatch');
  await refused(runtime.reconfigure('root', { model: 'gpt-made-up' }), 'invalid_params');
  await refused(runtime.reconfigure('root', { thinking: 'ultracode' }), 'invalid_params');
  await refused(runtime.reconfigure('root', { team: 'nonesuch' }), 'team_not_found');
  await refused(runtime.reconfigure('root', { model: '' }), 'invalid_params');
  assert.equal(runtimes.length, 1, 'nothing restarted');
  assert.deepEqual(runtime.snapshot('root'), before);
});

test('a session that is not open is refused', async t => {
  const { runtime } = await setup(t);
  await refused(runtime.reconfigure('nobody', { model: 'gpt-6.1-sol' }), 'session_busy');
});

test('a running turn or a running assignment refuses the change; the preview says why', async t => {
  const { runtime, runtimes, of, prompt, root } = await setup(t, undefined, { autoResume: false, recoveryResume: false });
  await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.6-sol' });
  await prompt('root', 'one');
  await refused(runtime.reconfigure('root', { model: 'gpt-6.1-sol' }), 'session_busy');
  const preview = await runtime.previewConfigure('root', { model: 'gpt-6.1-sol' });
  assert.equal(preview.allowed, false);
  assert.equal(preview.reason, 'session_busy');
  await runtimes[0].call('alp_delegate', { agent: 'peer', task: 'Work', wait: false });
  await until(() => runtimes[1]?.of('turn/start').length);
  const child = of('root', 'assignment')[0].assignment.id;
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').activeTurnId);
  await refused(runtime.reconfigure('root', { model: 'gpt-6.1-sol' }), 'session_busy');
  await refused(runtime.reconfigure(child, { model: 'gpt-6.1-sol' }), 'not_root');
  assert.equal(runtimes.filter(fake => fake.of('thread/resume').length).length, 0, 'nothing restarted');
  assert.equal(runtime.snapshot('root').model, 'gpt-5.6-sol');
});

test('a team change resolves the new team\'s delegation and replaces the supervisor at the boundary', async t => {
  const { runtime, runtimes, of, prompt, root } = await setup(t, undefined, { supervisor: true });
  await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.6-sol', thinking: 'medium' });
  await until(() => runtime.list().some(session => session.id.startsWith('alp-supervisor-')));
  const supervisorBefore = runtime.list().find(session => session.id.startsWith('alp-supervisor-'));
  assert.ok(supervisorBefore, 'Phở has a supervisor');
  await prompt('root', 'one');
  runtimes[0].finish();
  // The supervisor reviews the turn; while it does, the tree is not idle.
  await until(() => runtimes[1].of('turn/start').length);
  await refused(runtime.reconfigure('root', { team: 'cafe' }), 'session_busy');
  runtimes[1].finish();
  await until(() => !runtime.snapshot('root').busy);
  const preview = await runtime.previewConfigure('root', { team: 'cafe' });
  assert.deepEqual(preview.changes, ['team']);
  assert.equal(preview.allowed, true);
  assert.deepEqual(preview.proposed.delegates, ['lead', 'oracle', 'reviewer']);
  assert.equal(preview.proposed.teamLabel, 'Cafe');
  assert.equal(preview.proposed.model, 'gpt-5.6-sol', 'the model stays unless it is asked for');
  const result = await runtime.reconfigure('root', { team: 'cafe' });
  assert.equal(result.session.workflow.mode, 'cafe');
  assert.equal(result.session.teamLabel, 'Cafe');
  assert.equal(result.session.model, 'gpt-5.6-sol');
  assert.equal(result.effective.supervisor, true);
  const resume = runtimes.find(fake => fake.of('thread/resume').some(call => call.threadId === result.session.threadId)).of('thread/resume').at(-1);
  assert.match(resume.developerInstructions, /Profile: cafe; fixed for this session/);
  assert.match(resume.developerInstructions, /assign bounded work to: lead, oracle, reviewer/);
  // The old supervisor closed; the new team's started.
  await until(() => !runtime.snapshot(supervisorBefore.id));
  await until(() => runtime.list().some(session => session.id.startsWith('alp-supervisor-') && session.id !== supervisorBefore.id));
  assert.ok(of(supervisorBefore.id, 'session.closed').length >= 1);
});

test('after a team change, the next delegation follows the new team; an earlier assignment keeps its own', async t => {
  let releaseWrite = () => {};
  // Release before setup's shutdown cleanup, even if an assertion fails while the write is held.
  t.after(() => releaseWrite());
  const { runtime, runtimes, prompt, root, runLog, directory } = await setup(t);
  // Hold only the second assignment's disk append, leaving runtime events and tool replies free.
  const probe = await open(path.join(directory, 'file-handle-probe'), 'w');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const appendFile = fileHandlePrototype.appendFile;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  let leadWriteStarted = false;
  t.mock.method(fileHandlePrototype, 'appendFile', async function (data, ...args) {
    if (typeof data === 'string' && data.includes('"event":"assignment.started"') && data.includes('"agent":"lead"')) {
      leadWriteStarted = true;
      await writeGate;
    }
    return appendFile.call(this, data, ...args);
  });
  // A tool call's answer as the model reads it; each call has its own id (a repeated id answers from the cache).
  let calls = 0;
  const tool = async (fake, name, args) => {
    const result = await fake.serverRequest('item/tool/call', { threadId: fake.lastThread(), turnId: fake.turnId, callId: `${name}-${++calls}`, namespace: null, tool: name, arguments: args });
    return { success: result.success, ...JSON.parse(result.contentItems[0].text) };
  };
  await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.6-sol', thinking: 'medium' });
  await prompt('root', 'one');
  // On Phở, main delegates to peer.
  const first = await tool(runtimes[0], 'alp_delegate', { agent: 'peer', task: 'Work on Phở', mode: 'read-only', wait: false });
  assert.ok(first.assignmentId, JSON.stringify(first));
  await until(() => runtimes[1]?.of('turn/start').length);
  const [phoStart] = runtimes[1].of('thread/start');
  assert.match(phoStart.developerInstructions, /Profile: pho; fixed for this session/);
  await tool(runtimes[1], 'alp_handoff', { outcome: 'complete', summary: 'Done on Phở' });
  runtimes[1].finish();
  await tool(runtimes[0], 'alp_wait', { assignments: [first.assignmentId] });
  runtimes[0].finish();
  await until(() => !runtime.snapshot('root').busy);

  const result = await runtime.reconfigure('root', { team: 'cafe' });
  assert.equal(result.session.workflow.mode, 'cafe');
  const main = runtimes.find(fake => fake.of('thread/resume').some(call => call.threadId === result.session.threadId));
  await prompt('root', 'two');
  await until(() => main.of('turn/start').length);

  // Cafe's main delegates to lead, not to peer.
  const refusedPeer = await tool(main, 'alp_delegate', { agent: 'peer', task: 'Work on Cafe', mode: 'read-only', wait: false });
  assert.equal(refusedPeer.assignmentId, undefined, JSON.stringify(refusedPeer));
  assert.ok(refusedPeer.error, JSON.stringify(refusedPeer));
  const before = runtimes.length;
  const second = await tool(main, 'alp_delegate', { agent: 'lead', task: 'Lead on Cafe', mode: 'read-only', wait: false });
  assert.ok(second.assignmentId, JSON.stringify(second));
  await until(() => runtimes.length > before && runtimes.at(-1).of('turn/start').length);
  const lead = runtimes.at(-1);
  const [cafeStart] = lead.of('thread/start');
  assert.match(cafeStart.developerInstructions, /Profile: cafe; fixed for this session/);
  assert.match(cafeStart.developerInstructions, /assign bounded work to: peer, oracle, reviewer/);
  assert.equal(runtime.snapshot(second.assignmentId).workflow.mode, 'cafe');
  await until(() => leadWriteStarted);
  assert.deepEqual((await runLog('root')).filter(entry => entry.event === 'assignment.started').map(entry => [entry.assignmentId, entry.agent]), [[first.assignmentId, 'peer']], 'a running lead and a returned delegation do not imply its log append finished');
  releaseWrite();
  // The earlier assignment ran with Phở's instructions; nothing restarted it. Its record: packages/daemon/tests/configure.test.js.
  assert.equal(runtimes[1].of('thread/start').length, 1);
  assert.equal(runtimes[1].of('thread/resume').length, 0);
  await tool(lead, 'alp_handoff', { outcome: 'complete', summary: 'Done on Cafe' });
  lead.finish();
  await tool(main, 'alp_wait', { assignments: [second.assignmentId] });
  main.finish();
  await until(() => !runtime.snapshot('root').busy);
  // Run logs are best-effort asynchronous writes; shutdown is the existing drain barrier.
  await runtime.shutdown();
  const started = (await runLog('root')).filter(entry => entry.event === 'assignment.started').map(entry => [entry.assignmentId, entry.agent]);
  assert.deepEqual(started, [[first.assignmentId, 'peer'], [second.assignmentId, 'lead']]);
});

test('a team change that would not keep the session\'s agent as main is refused', async t => {
  const { runtime, root } = await setup(t);
  await mkdir(path.join(root, '.alp/teams/solo'), { recursive: true });
  await writeFile(path.join(root, '.alp/teams/solo/team.json'), JSON.stringify({ label: 'Solo', main: 'lead', members: { lead: {}, peer: { role: 'peer' } }, delegation: { lead: ['peer'] }, maxPeers: 1 }));
  await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.6-sol' });
  const error = await refused(runtime.reconfigure('root', { team: 'solo' }), 'agent_mismatch');
  assert.match(error.message, /main agent is lead/);
});

test('a mode beyond the permission profile, or a change that brings a new hook, is refused as an escalation', async t => {
  const { runtime, runtimes, root } = await setup(t, undefined, {}, settings => ({ ...settings, permissions: { agents: { main: 'ws' }, profiles: { ws: { base: 'workspace-write' } } } }));
  await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.6-sol' });
  assert.equal(runtime.snapshot('root').mode, 'workspace-write');
  const error = await refused(runtime.reconfigure('root', { model: 'gpt-6.1-sol', mode: 'full-access' }), 'permission_escalation');
  assert.match(error.message, /allows at most workspace-write/);
  // A hook written for the agent since it opened would run commands the session did not.
  await mkdir(path.join(root, '.alp/agents/main/hooks'), { recursive: true });
  await writeFile(path.join(root, '.alp/agents/main/AGENT.md'), '# Main\n\nThe project\'s main.\n');
  await writeFile(path.join(root, '.alp/agents/main/hooks/notify.json'), JSON.stringify({ event: 'session.start', command: 'touch /tmp/alp-should-not-run' }));
  const hook = await refused(runtime.reconfigure('root', { model: 'gpt-6.1-sol' }), 'permission_escalation');
  assert.match(hook.message, /commands it did not run \(hook notify/);
  assert.equal(runtimes.length, 1, 'nothing restarted');
});

test('a root with no turn yet starts a new conversation with the new configuration', async t => {
  const { runtime, runtimes, root } = await setup(t);
  await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.6-sol' });
  const before = runtime.snapshot('root');
  const result = await runtime.reconfigure('root', { model: 'gpt-6.1-sol' }, { fresh: true });
  assert.equal(result.session.model, 'gpt-6.1-sol');
  assert.equal(runtimes[1].of('thread/resume').length, 0);
  assert.equal(runtimes[1].of('thread/start')[0].model, 'gpt-6.1-sol');
  assert.notEqual(result.session.threadId, before.threadId);
});

test('a Claude root restarts on its transcript and logs the model Claude Code reports', async t => {
  const { runtime, runtimes, root, runLog } = await setup(t);
  await runtime.open('root', { cwd: root, persist: true, model: 'claude:claude-sonnet-5-5', restore: { agent: 'main', threadId: 'N', runtime: 'claude', model: 'claude-sonnet-5-5' } });
  const result = await runtime.reconfigure('root', { model: 'claude:claude-opus-5-5', thinking: 'high' });
  assert.equal(result.session.model, 'claude-opus-5-5');
  const [resume] = runtimes[1].of('thread/resume');
  assert.equal(resume.threadId, 'N');
  assert.equal(resume.requireHistory, true, 'never an empty conversation in its place');
  assert.equal(resume.model, 'claude-opus-5-5');
  runtimes[1].notification('alp/nativeModel', { threadId: 'N', model: 'claude-opus-5-5' });
  await until(async () => (await runLog('root')).some(entry => entry.event === 'session.native_model'));
  const observed = (await runLog('root')).find(entry => entry.event === 'session.native_model');
  assert.equal(observed.model, 'claude-opus-5-5');
  assert.equal(observed.configured, 'claude-opus-5-5');
});

test('a root alpd says has no turn is resumed when the runtime holds turns, started anew only when it says it holds none, refused when it cannot say', async t => {
  let answer = { data: [{ id: 'turn-x' }] };
  const { runtime, runtimes, root } = await setup(t, (fake, method) => {
    if (method !== 'thread/turns/list') return undefined;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  await runtime.open('root', { cwd: root, persist: true, model: 'codex:gpt-5.6-sol' });
  const before = runtime.snapshot('root');
  await runtime.reconfigure('root', { model: 'gpt-6.1-sol' }, { fresh: true });
  assert.deepEqual(runtimes[1].calls.filter(call => call.method.startsWith('thread/') && call.method !== 'thread/turns/list').map(call => [call.method, call.params.threadId]), [['thread/resume', before.threadId]]);
  answer = new Error('thread t is not materialized yet; thread/turns/list is unavailable before first user message');
  await runtime.reconfigure('root', { model: 'gpt-6-sol' }, { fresh: true });
  assert.equal(runtimes[2].of('thread/start').length, 1, 'Codex holds none: a new conversation');
  const current = runtime.snapshot('root');
  answer = new Error('Runtime request timed out: thread/turns/list');
  await refused(runtime.reconfigure('root', { model: 'gpt-6.1-sol' }, { fresh: true }), 'native_refused');
  assert.equal(runtimes.length, 3, 'nothing restarted');
  assert.deepEqual(runtime.snapshot('root'), current);
});

for (const changes of [{ model: 'gpt-6.1-sol', thinking: 'high' }, { mode: 'read-only' }]) {
  const label = changes.mode ? 'mode only' : 'native restart';
  test(`reconfigure ${label} awaits causal persistence before publishing the applied snapshot`, async t => {
    const { runtime, of } = await idleRoot(t);
    const before = of('root', 'session.updated').length;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let taken;
    let calls = 0;
    const applying = runtime.reconfigure('root', changes, { onApplied: async result => { calls++; taken = result; await gate; } });
    try {
      // Completing without entering the hook is a deterministic failure on the old implementation.
      await Promise.race([applying.then(() => assert.fail('reconfigure bypassed persistence')), until(() => taken)]);
      assert.equal(of('root', 'session.updated').length, before, 'no successful update before persistence');
      assert.equal(taken.status, 'applied');
      assert.equal(taken.restarted, !changes.mode);
    } finally { release(); }

    const result = await applying;
    assert.deepEqual(result, taken);
    assert.equal(calls, 1);
    assert.deepEqual(of('root', 'session.updated').at(-1).session, taken.session);
  });

  test(`reconfigure ${label} persistence failure stays unknown after native apply, with no rollback`, async t => {
    const { runtime, runtimes, of } = await idleRoot(t);
    const before = of('root', 'session.updated').length;
    const error = await runtime.reconfigure('root', changes, { onApplied: async () => { throw new Error('disk full'); } }).then(() => assert.fail('must report unknown'), error => error);
    assert.equal(error.outcomeUnknown, true);
    assert.equal(of('root', 'session.updated').length, before, 'no successful update after failed persistence');
    const current = runtime.snapshot('root');
    for (const [field, value] of Object.entries(changes)) assert.equal(current[field], value, 'runtime keeps the configuration it already took');
    assert.equal(runtimes.length, changes.mode ? 1 : 2, 'no rollback restart');
  });
}

test('unchanged and refused configures never call the applied persistence hook', async t => {
  const { runtime, runtimes } = await idleRoot(t);
  const onApplied = async () => assert.fail('no applied change to persist');
  assert.equal((await runtime.reconfigure('root', { model: 'gpt-5.6-sol' }, { onApplied })).status, 'unchanged');
  await refused(runtime.reconfigure('root', { model: 'not-a-model' }, { onApplied }), 'invalid_params');
  assert.equal(runtimes.length, 1);
});
