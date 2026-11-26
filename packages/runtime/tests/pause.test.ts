import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { createTask, getTask } from '@anhlp/alp-core/tasks';
import { ClaudeTransport, createAlpRuntime } from '@anhlp/alp-runtime';

let calls = 0;
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, cwd, calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      get config() { return this.calls.find(call => call.method === 'thread/start')?.params; },
      async call(tool, args) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}-${++calls}`, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      finish(text = 'done', turn = {}) {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed', ...turn } });
      },
      limit() {
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'failed', error: { message: 'You have hit your usage limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function until(check) {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

async function setup(t, options = {}, workflow = 'pho') {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-pause-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: workflow, maxPeers: 2, supervisor: false } }));
  const runtimes = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'), boardDir: path.join(directory, 'boards'), ...options(directory) });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const events = [];
  runtime.onEvent(envelope => events.push(envelope));
  // Main runs on Codex here, so a Codex pause holds its wakes.
  await runtime.open('root', { cwd: root, model: 'codex:gpt-5.6-sol' });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
  return { directory, root, runtime, runtimes, events, main: runtimes[0] };
}
const none = () => ({});
const notices = (events, sessionId = 'root') => events.filter(envelope => envelope.sessionId === sessionId && envelope.event.type === 'item' && envelope.event.item.kind === 'notice').map(envelope => envelope.event.item);

test('a usage limit pauses its runtime and parks the assignment it stopped, until the user resumes', async t => {
  const { root, runtime, runtimes, events, main } = await setup(t, directory => ({ silentForMs: 40, pauseFile: path.join(directory, 'home', 'state', 'pause.json') }));
  const task = await createTask(root, { title: 'Long job' }, 'user');
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Do the long job', taskId: task.id, mode: 'read-only', wait: false });
  await until(() => runtimes[1]?.started.length === 1);
  const peer = runtimes[1];
  // Codex reports the used-up window before the turn fails.
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  peer.notification('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt }, secondary: null } });
  peer.limit();

  await until(() => runtime.pauses().runtimes.codex);
  const state = runtime.pauses();
  assert.deepEqual([state.runtimes.codex.by, state.runtimes.codex.reason, state.runtimes.codex.resetsAt], ['alpd', 'Codex usage limit reached', new Date(resetsAt * 1000).toISOString()]);
  assert.deepEqual(state.parked.map(entry => [entry.assignmentId, entry.agent, entry.runtime]), [[assignmentId, 'peer', 'codex']]);
  assert.match(notices(events)[0].text, /^Codex usage limit reached; it resets .*ALP paused delegation to Codex agents and parked their assignments; Claude agents keep working\. ALP asks Codex every minute and resumes it as soon as the limit lifts\.$/);
  assert.equal(notices(events)[0].level, 'error');
  // The pause file is written in the background.
  const pauseFile = path.join(path.dirname(root), 'home', 'state', 'pause.json');
  await until(() => readFile(pauseFile, 'utf8').then(() => true, () => false));
  assert.deepEqual(JSON.parse(await readFile(pauseFile, 'utf8')).runtimes.codex.by, 'alpd');

  // The requester learns why, the task stays with the assignment, and the watchdog leaves it alone.
  // It is steered into main's running turn: main must decide, so it is not left for a later wait.
  const steered = () => main.calls.filter(call => call.method === 'turn/steer').map(call => call.params.input.at(-1).text).join('\n');
  await until(() => /Parked:/.test(steered()));
  assert.match(steered(), /stalled from peer[\s\S]*Parked: the Codex usage limit was reached\. ALP continues this assignment where it stopped when Codex is resumed/);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await getTask(root, task.id)).status, 'in_progress');
  assert.equal(runtime.status('root').assignments.length, 1);

  // No new Codex assignments; Claude still takes them.
  const refused = await main.call('alp_delegate', { agent: 'peer', task: 'More', mode: 'read-only', wait: false });
  assert.match(refused.error, /^Codex is paused \(Codex usage limit reached\); the limit resets /);
  assert.match(refused.next, /Pass a model of claude: from the catalog to run it on Claude/);
  const onClaude = await main.call('alp_delegate', { agent: 'peer', task: 'More', mode: 'read-only', model: 'claude:claude-sonnet-4-6', wait: false });
  assert.ok(onClaude.assignmentId, JSON.stringify(onClaude));
  await until(() => runtimes[2]?.kind === 'claude' && runtimes[2].started.length === 1);
  await runtimes[2].call('alp_handoff', { outcome: 'complete', summary: 'Read it' });
  runtimes[2].finish('Read');
  await main.call('alp_wait', { assignments: [onClaude.assignmentId] });

  assert.throws(() => runtime.resume({ runtime: 'gemini' }), /runtime must be codex or claude/);
  runtime.resume({ runtime: 'codex' });
  await until(() => peer.started.length === 2);
  assert.deepEqual(runtime.pauses(), { runtimes: {}, parked: [] });
  assert.match(peer.started[1].params.input.at(-1).text, /^ALP resumed this assignment; it had stopped because the Codex usage limit was reached\. Continue where you left off/);
  assert.match(notices(events).at(-1).text, /^Codex resumed by the user\. Parked assignments continue\.$/);
  await peer.call('alp_handoff', { outcome: 'complete', summary: 'Finished the long job' });
  peer.finish('Done');
  const { events: done } = await main.call('alp_wait', { assignments: [assignmentId] });
  assert.equal(done[0].result.task.status, 'review');
  main.finish('Done');
});

test('alp pause holds delegation and wakes; --now parks running assignments where they are', async t => {
  const { runtime, runtimes, events, main } = await setup(t, none);
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Work slowly', mode: 'read-only', wait: false });
  await until(() => runtimes[1]?.started.length === 1);
  const peer = runtimes[1];

  const state = runtime.pause({ now: true, reason: 'Lunch' });
  assert.deepEqual([state.all.by, state.all.reason], ['the user', 'Lunch']);
  assert.match(notices(events).at(-1).text, /^ALP paused by the user: Lunch\. Delegation waits, and running assignments park where they are\. alp resume continues\.$/);
  // The running assignment is interrupted; its turn ends as interrupted and it parks.
  assert.ok(peer.calls.some(call => call.method === 'turn/interrupt'));
  peer.notification('turn/completed', { threadId: peer.threadId, turn: { id: peer.turnId, status: 'interrupted' } });
  await until(() => runtime.pauses().parked.length === 1);
  assert.equal(runtime.pauses().parked[0].reason, 'paused by the user');
  assert.equal(runtime.snapshot(assignmentId).parked, 'paused by the user');
  assert.match((await main.call('alp_delegate', { agent: 'peer', task: 'More', mode: 'read-only', model: 'claude:claude-sonnet-4-6', wait: false })).error, /^ALP is paused \(Lunch, by the user\)/);
  assert.throws(() => runtime.resume({ runtime: 'codex' }), /All of ALP is paused/);

  // Main ends its turn; mail for it waits while paused.
  main.finish('Waiting');
  runtime.message(assignmentId, 'Also check the docs');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(peer.started.length, 1);

  runtime.resume();
  await until(() => peer.started.length === 2);
  assert.equal(runtime.snapshot(assignmentId).parked, undefined);
  assert.match(peer.started[1].params.input.map(entry => entry.text).join('\n'), /ALP resumed this assignment; it had stopped because paused by the user/);
  await peer.call('alp_handoff', { outcome: 'complete', summary: 'Checked' });
  peer.finish('Checked');
  // Main is woken by the result once nothing is paused.
  await until(() => main.started.length === 2);
});

test('a pause without --now lets running turns finish, and holds wakes until resume', async t => {
  const { runtime, runtimes, main } = await setup(t, none);
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Quick', mode: 'read-only', wait: false });
  await until(() => runtimes[1]?.started.length === 1);
  main.finish('Started it');
  runtime.pause({ runtime: 'codex' });
  assert.equal(runtimes[1].calls.some(call => call.method === 'turn/interrupt'), false);
  await runtimes[1].call('alp_handoff', { outcome: 'complete', summary: 'Quick done' });
  runtimes[1].finish('Done');
  // The result waits: main is on Codex.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(main.started.length, 1);
  assert.equal(runtime.status('root').assignments.length, 0);
  runtime.resume({ runtime: 'codex' });
  await until(() => main.started.length === 2);
  assert.match(main.started[1].params.input.at(-1).text, new RegExp(assignmentId));
});

test('Claude reports a usage limit as a failed turn with the reset time', async () => {
  const transport = new ClaudeTransport(process.execPath, tmpdir(), process.env);
  const seen = [];
  transport.onNotification((method, params) => seen.push({ method, params }));
  transport.activeTurn = 'turn-1';
  transport.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.91, resetsAt: 1_900_000_000 } });
  transport.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' } });
  transport.handle({ type: 'assistant', error: 'rate_limit', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: "You've hit your limit" }] } });
  transport.handle({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(seen.filter(entry => entry.method === 'account/rateLimits/updated').map(entry => entry.params.claude.status), ['allowed_warning', 'rejected']);
  const ended = seen.find(entry => entry.method === 'turn/completed').params.turn;
  assert.deepEqual([ended.status, ended.error.codexErrorInfo, ended.error.resetsAt], ['failed', 'usageLimitExceeded', 1_900_000_000]);
  assert.match(ended.error.message, /^Claude usage limit reached; resets 2030-/);
  // With overage still allowed, a failed turn is an ordinary failure.
  transport.activeTurn = 'turn-2';
  transport.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', overageStatus: 'allowed' } });
  transport.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] });
  const second = seen.filter(entry => entry.method === 'turn/completed')[1].params.turn;
  assert.deepEqual([second.status, second.error.message, second.error.codexErrorInfo], ['failed', 'boom', undefined]);
  await transport.close();
});

test('usage warnings reach the user once per window', async t => {
  const { runtimes, events, main } = await setup(t, none);
  const resetsAt = Math.floor(Date.now() / 1000) + 7200;
  for (let i = 0; i < 2; i++) main.notification('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 93, windowDurationMins: 300, resetsAt }, secondary: null } });
  assert.equal(notices(events).length, 1);
  assert.match(notices(events)[0].text, /^Codex has used 93% of a usage window that resets /);
  assert.equal(notices(events)[0].level, 'warning');
  assert.equal(runtimes.length, 1);
  main.finish('Done');
});

test('a limit pause survives a restart, and autoResume lifts it after the reset', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-pause-file-'));
  const file = path.join(directory, 'pause.json');
  const past = new Date(Date.now() - 120_000).toISOString();
  await writeFile(file, JSON.stringify({ runtimes: { codex: { since: past, by: 'alpd', reason: 'Codex usage limit reached', resetsAt: past } } }));
  const kept = createAlpRuntime({ language: 'English', transport: fakeTransport([]), supervisor: false, pauseFile: file });
  assert.equal(kept.pauses().runtimes.codex.reason, 'Codex usage limit reached');
  await kept.shutdown();
  const lifted = createAlpRuntime({ language: 'English', transport: fakeTransport([]), supervisor: false, pauseFile: file, autoResume: true });
  t.after(() => lifted.shutdown());
  // After hooks run in the order they are added: remove the files only once that has stopped.
  t.after(() => rm(directory, { recursive: true, force: true }));
  await until(() => !lifted.pauses().runtimes.codex);
  await until(async () => JSON.parse(await readFile(file, 'utf8')).runtimes.codex === undefined);
});

test('a requester stops a parked assignment with alp_cancel and hands the rest to Claude, while a reviewer may run beside', async t => {
  const { root, runtime, runtimes, main } = await setup(t, directory => ({ silentForMs: 3_600_000, pauseFile: path.join(directory, 'home', 'state', 'pause.json') }));
  const task = await createTask(root, { title: 'Restyle the nav' }, 'user');
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Restyle the nav', taskId: task.id, mode: 'workspace-write' });
  await until(() => runtimes[1]?.started.length === 1);
  runtimes[1].limit();
  await until(() => runtime.pauses().parked.length === 1);
  // The requester is told what it can do, not only that it waits.
  const steered = () => main.calls.filter(call => call.method === 'turn/steer').map(call => call.params.input.at(-1).text).join('\n');
  await until(() => /Parked:/.test(steered()));
  assert.match(steered(), /stalled from peer[\s\S]*stop it with alp_cancel and give the rest to an agent on another runtime/);

  // A second writer waits for the parked one; a read-only reviewer runs beside it.
  const blocked = await main.call('alp_delegate', { agent: 'peer', task: 'Finish it', mode: 'workspace-write', model: 'claude:claude-opus-5-5' });
  assert.match(blocked.error, /already running/);
  assert.match(blocked.next, new RegExp(`peer ${assignmentId} is parked; to go on without it, stop it with alp_cancel`));
  const review = await main.call('alp_delegate', { agent: 'reviewer', task: 'Review the diff', mode: 'read-only', model: 'claude:claude-fable-5-1' });
  assert.equal(review.status, 'running', JSON.stringify(review));

  assert.match((await main.call('alp_cancel', { assignmentId: 'alp-child-unknown' })).error, /Not one of your running assignments/);
  const canceled = await main.call('alp_cancel', { assignmentId, reason: 'Codex hit its usage limit; Claude takes over' });
  assert.deepEqual([canceled.status, canceled.agent], ['canceled', 'peer']);
  assert.equal(runtimes[1].closed, true);
  assert.equal((await getTask(root, task.id)).status, 'open');
  assert.equal(runtime.pauses().parked.length, 0);
  const takeover = await main.call('alp_delegate', { agent: 'peer', task: 'Finish the restyle', taskId: task.id, mode: 'workspace-write', model: 'claude:claude-opus-5-5' });
  assert.equal(takeover.status, 'running', JSON.stringify(takeover));
});


test('Cafe main and lead can inspect beside a parked peer, and lead can return a partial handoff', async t => {
  const { runtime, runtimes, main } = await setup(t, none, 'cafe');
  const leadAssignment = await main.call('alp_delegate', { agent: 'lead', task: 'Implement and review', mode: 'workspace-write', model: 'claude:claude-sonnet-4-6' });
  await until(() => runtimes[1]?.started.length === 1);
  const lead = runtimes[1];
  const peerAssignment = await lead.call('alp_delegate', { agent: 'peer', task: 'Implement', mode: 'workspace-write', model: 'codex:gpt-6-astra' });
  await until(() => runtimes[2]?.started.length === 1);
  runtimes[2].limit();
  await until(() => runtime.pauses().parked.length === 1);
  for (const requester of [main, lead]) {
    for (const agent of ['reviewer', 'oracle']) {
      const advice = await requester.call('alp_delegate', { agent, task: 'Inspect finished work', mode: 'read-only', model: 'claude:claude-fable-5-1' });
      assert.equal(advice.status, 'running', JSON.stringify(advice));
      const advisor = runtimes.at(-1);
      await until(() => advisor.started.length === 1);
      await requester.call('alp_cancel', { assignmentId: advice.assignmentId });
    }
  }
  const handoff = await lead.call('alp_handoff', { outcome: 'partial', summary: 'Implementation preserved; peer hit quota before handing off' });
  assert.deepEqual(handoff.stoppedParked, [peerAssignment.assignmentId]);
  lead.finish('Partial work ready for main');
  const result = await main.call('alp_wait', { assignments: [leadAssignment.assignmentId], timeoutMs: 1000 });
  assert.equal(result.events[0]?.result?.handoff?.outcome, 'partial', JSON.stringify(result));
  assert.equal(runtimes[2].closed, true);
  assert.equal(runtime.pauses().parked.length, 0);
  assert.equal(runtime.status('root').assignments.length, 0);
});

// An idle root is a queue barrier: recover does not send a turn without continuation intent.
async function barrier(runtime) { await runtime.recover('barrier'); }
async function openIdle(runtime, root, id, model = 'codex:gpt-5.6-sol') {
  await runtime.open(id, { cwd: root, model });
}

for (const scope of ['claude', 'codex', 'all']) {
  test(`resume ${scope} leaves manual recovery roots parked, including one recovered during a pause`, async t => {
    const { root, runtime, runtimes, main, events } = await setup(t, () => ({ recoveryResume: false }));
    main.finish();
    await openIdle(runtime, root, 'barrier');
    await runtime.recover('root', { continueRoot: true });
    await openIdle(runtime, root, 'other', 'claude:claude-sonnet-4-6');
    runtime.pause({ runtime: 'claude' });
    await runtime.recover('other', { continueRoot: true });
    runtime.resume(scope === 'all' ? {} : { runtime: scope });
    await barrier(runtime);
    assert.equal(main.started.length, 1, 'manual Codex recovery must wait for an explicit session prompt');
    assert.doesNotMatch(notices(events).at(-1).text, /Parked assignments continue/);
    assert.equal(runtimes[2].started.length, 0, 'manual Claude recovery must wait even when recovered during a provider pause');
    assert.ok(runtime.snapshot('root').parked);
    assert.ok(runtime.snapshot('other').parked);
    await runtime.prompt('root', { clientMessageId: 'explicit-recovery', delivery: 'auto', content: [{ type: 'text', text: 'Continue my recovered session' }] });
    assert.equal(main.started.length, 2, 'explicit session resume still starts the recovered root');
    assert.equal(runtime.snapshot('root').parked, undefined);
  });
}

test('provider resume selects the pause that parked work and survives resume before interrupt completion', async t => {
  const { root, runtime, runtimes, main } = await setup(t, none);
  await openIdle(runtime, root, 'barrier');
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Work', mode: 'read-only', wait: false });
  await until(() => runtimes[2]?.started.length === 1);
  const peer = runtimes[2];
  runtime.pause({ runtime: 'codex', now: true });
  runtime.resume({ runtime: 'claude' });
  await barrier(runtime);
  assert.equal(peer.started.length, 1);
  runtime.resume({ runtime: 'codex' });
  runtime.resume({ runtime: 'codex' });
  await barrier(runtime);
  assert.equal(peer.started.length, 1, 'the interrupted turn has not settled yet');
  peer.notification('turn/completed', { threadId: peer.threadId, turn: { id: peer.turnId, status: 'interrupted' } });
  await barrier(runtime);
  assert.equal(peer.started.length, 2, 'the matching earlier resume continues the turn once it parks');
  assert.equal(runtime.snapshot(assignmentId).parked, undefined);
  runtime.resume();
  await barrier(runtime);
  assert.equal(peer.started.length, 2, 'repeated resume cannot duplicate a continuation');
});

test('wrong-provider resume cannot reach a parked root through a lifecycle hold', async t => {
  const { root, runtime, main } = await setup(t, () => ({ recoveryResume: false }));
  main.finish();
  await openIdle(runtime, root, 'barrier');
  await runtime.recover('root', { continueRoot: true });
  const release = runtime.hold('root');
  runtime.resume({ runtime: 'claude' });
  await barrier(runtime);
  release();
  release();
  await barrier(runtime);
  assert.equal(main.started.length, 1);
  assert.ok(runtime.snapshot('root').parked);
});

for (const terminal of ['interrupted', 'completed']) {
  test(`pause resume ordering is safe when the interrupted assignment ends ${terminal}`, async t => {
    const { root, runtime, runtimes, main } = await setup(t, none);
    await openIdle(runtime, root, 'barrier');
    await main.call('alp_delegate', { agent: 'peer', task: 'Work', mode: 'read-only', wait: false });
    await until(() => runtimes[2]?.started.length === 1);
    const peer = runtimes[2];
    runtime.pause({ runtime: 'codex', now: true });
    peer.finish('ended', { status: terminal });
    await barrier(runtime);
    runtime.resume({ runtime: 'claude' });
    await barrier(runtime);
    assert.equal(peer.started.length, 1, 'wrong scope cannot continue the assignment');
    runtime.resume({ runtime: 'codex' });
    runtime.resume();
    await barrier(runtime);
    assert.equal(peer.started.length, terminal === 'completed' ? 1 : 2, 'completed work is not restarted; parked work continues once');
  });
}

for (const timing of ['queued', 'held']) {
  test(`a ${timing} pause resume cannot continue replacement manual recovery intent`, async t => {
    const { root, runtime, main } = await setup(t, () => ({ autoResume: false }));
    await openIdle(runtime, root, 'barrier');
    main.limit();
    await until(() => runtime.snapshot('root').parked);
    const release = timing === 'held' ? runtime.hold('root') : undefined;
    let replacement;
    if (timing === 'queued') replacement = runtime.recover('root', { parkedRoot: 'manual recovery replacement' });
    runtime.resume({ runtime: 'codex' });
    if (timing === 'held') {
      await barrier(runtime);
      replacement = runtime.recover('root', { parkedRoot: 'manual recovery replacement' });
    }
    await replacement;
    release?.();
    await barrier(runtime);
    assert.equal(main.started.length, 1, 'old resume authority belongs only to its original parked object');
    assert.equal(runtime.snapshot('root').parked, 'manual recovery replacement');
  });
}

test('automatic quota resume continues its limited root and leaves unrelated manual recovery alone', async t => {
  const { root, runtime, runtimes, main } = await setup(t, () => ({ limitCheckMs: 20, recoveryResume: false }));
  await openIdle(runtime, root, 'barrier');
  await openIdle(runtime, root, 'manual');
  await runtime.recover('manual', { continueRoot: true });
  let allowed = false;
  main.orchestrationContext = async () => ({ usage: { available: true, limits: [{ windows: [{ usedPercent: allowed ? 0 : 100, resetsAt: 1_900_000_000 }] }] } });
  main.limit();
  await until(() => runtime.pauses().runtimes.codex?.checkedAt);
  allowed = true;
  await until(() => main.started.length === 2);
  await barrier(runtime);
  assert.equal(runtimes[2].started.length, 0);
  assert.ok(runtime.snapshot('manual').parked);
});

test('matching pause resume survives nested holds and a second pause without duplicate turns', async t => {
  const { root, runtime, main } = await setup(t, none);
  await openIdle(runtime, root, 'barrier');
  main.limit();
  await until(() => runtime.snapshot('root').parked && runtime.pauses().runtimes.codex);
  const first = runtime.hold('root');
  const last = runtime.hold('root');
  runtime.resume({ runtime: 'codex' });
  runtime.resume({ runtime: 'codex' });
  await barrier(runtime);
  first();
  await barrier(runtime);
  assert.equal(main.started.length, 1);
  runtime.pause({ runtime: 'codex' });
  last();
  await barrier(runtime);
  assert.equal(main.started.length, 1, 're-pause holds the authorized continuation');
  runtime.resume({ runtime: 'claude' });
  await barrier(runtime);
  assert.equal(main.started.length, 1);
  runtime.resume({ runtime: 'codex' });
  runtime.resume();
  await barrier(runtime);
  assert.equal(main.started.length, 2);
});

test('a newer provider pause replaces released global pause intent before the interrupted turn settles', async t => {
  const { root, runtime, runtimes, main } = await setup(t, none);
  await openIdle(runtime, root, 'barrier');
  await main.call('alp_delegate', { agent: 'peer', task: 'Work', mode: 'read-only', wait: false });
  await until(() => runtimes[2]?.started.length === 1);
  const peer = runtimes[2];
  runtime.pause({ now: true });
  runtime.resume();
  runtime.pause({ runtime: 'codex', now: true });
  peer.finish('interrupted', { status: 'interrupted' });
  await barrier(runtime);
  assert.equal(peer.started.length, 1);
  runtime.resume({ runtime: 'codex' });
  await barrier(runtime);
  assert.equal(peer.started.length, 2);
});

for (const scope of ['codex', 'all']) {
  test(`automatic working recovery blocked by ${scope} pause waits for the matching resume`, async t => {
    const { root, runtime, main } = await setup(t, none);
    main.finish();
    await openIdle(runtime, root, 'barrier');
    runtime.pause(scope === 'all' ? {} : { runtime: scope });
    await runtime.recover('root', { continueRoot: true });
    assert.ok(runtime.snapshot('root').parked);
    if (scope === 'all') assert.throws(() => runtime.resume({ runtime: 'codex' }), /All of ALP is paused/);
    else runtime.resume({ runtime: 'claude' });
    await barrier(runtime);
    assert.equal(main.started.length, 1);
    runtime.resume(scope === 'all' ? {} : { runtime: scope });
    runtime.resume();
    await barrier(runtime);
    assert.equal(main.started.length, 2);
    assert.equal(runtime.snapshot('root').parked, undefined);
  });
}

for (const paused of [false, true]) {
  test(`legacy persisted parked reasons remain explicit-only when initially paused=${paused}`, async t => {
    const { root, runtime, main, events } = await setup(t, none);
    main.finish();
    await openIdle(runtime, root, 'barrier');
    if (paused) runtime.pause({ runtime: 'codex' });
    // Reason text is deliberately a familiar quota message. It is not provenance.
    const reason = 'the Codex usage limit was reached';
    await runtime.recover('root', { parkedRoot: reason });
    assert.match(notices(events).at(-1).text, /send an explicit prompt to each parked session to continue it/);
    await barrier(runtime);
    assert.equal(main.started.length, 1, 'unpaused recovery must not infer automatic continuation');
    runtime.resume({ runtime: 'claude' });
    runtime.resume({ runtime: 'codex' });
    runtime.resume();
    await barrier(runtime);
    assert.equal(main.started.length, 1, 'provider/all resume cannot infer a legacy park scope');
    assert.equal(runtime.snapshot('root').parked, reason);
    await runtime.prompt('root', { clientMessageId: 'explicit-legacy', delivery: 'auto', content: [{ type: 'text', text: 'Continue' }] });
    assert.equal(main.started.length, 2);
    assert.equal(runtime.snapshot('root').parked, undefined);
  });
}

test('a full disk pauses all ALP and parks running work; releasing it continues that work and keeps a usage-limit pause (t-2831)', async t => {
  const { runtime, runtimes, events, main } = await setup(t, none);
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Write a lot', mode: 'read-only', wait: false });
  await until(() => runtimes[1]?.started.length === 1);
  const peer = runtimes[1];

  const state = runtime.holdForDisk('the disk is full');
  assert.deepEqual([state.all.by, state.all.reason, state.all.cause], ['alpd', 'the disk is full', 'disk']);
  assert.equal(runtime.diskHeld(), true);
  assert.match(notices(events).at(-1).text, /^Disk full: the disk is full\. ALP paused its work and parked running assignments/);
  assert.equal(notices(events).at(-1).level, 'error');
  assert.ok(peer.calls.some(call => call.method === 'turn/interrupt'));
  peer.notification('turn/completed', { threadId: peer.threadId, turn: { id: peer.turnId, status: 'interrupted' } });
  await until(() => runtime.pauses().parked.length === 1);
  assert.equal(runtime.snapshot(assignmentId).parked, 'the disk is full');
  // Main learns why and what happens next.
  const steered = () => main.calls.filter(call => call.method === 'turn/steer').map(call => call.params.input.at(-1).text).join('\n');
  await until(() => /Parked:/.test(steered()));
  assert.match(steered(), /Parked: the disk is full\. ALP continues this assignment where it stopped as soon as the disk takes writes again/);
  // Another hold changes nothing; a usage-limit pause made meanwhile survives the release.
  runtime.holdForDisk('the disk is full');
  assert.equal(notices(events).filter(item => /^Disk full/.test(item.text)).length, 1);
  runtime.pause({ runtime: 'claude' });

  runtime.releaseDisk('alpd, after disk space returned');
  assert.equal(runtime.diskHeld(), false);
  await until(() => peer.started.length === 2);
  assert.match(peer.started[1].params.input.at(-1).text, /it had stopped because the disk is full\. Continue where you left off/);
  assert.equal(runtime.pauses().all, undefined);
  assert.equal(runtime.pauses().runtimes.claude.by, 'the user');
  assert.match(notices(events).at(-1).text, /^ALP resumed by alpd, after disk space returned\. Parked assignments continue\.$/);
  await peer.call('alp_handoff', { outcome: 'complete', summary: 'Wrote it' });
  peer.finish('Done');
  await main.call('alp_wait', { assignments: [assignmentId] });
  main.finish('Done');
});

test('a full disk leaves a pause the user made theirs to lift (t-2831)', async t => {
  const { runtime, main } = await setup(t, none);
  runtime.pause({ reason: 'Lunch' });
  runtime.holdForDisk('the disk is full');
  assert.equal(runtime.diskHeld(), false);
  assert.equal(runtime.pauses().all.by, 'the user');
  runtime.releaseDisk('alpd');
  assert.equal(runtime.pauses().all.reason, 'Lunch');
  runtime.resume();
  main.finish('Done');
});
