import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { createTask, getTask, loadTasks } from '@anhlp/alp-core/tasks';
import { createAlpRuntime, reclaimWorktrees } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { connect, daemonPaths, bootTime } from '@anhlp/alp-client';

let calls = 0;
/** A fake native harness; resuming a thread keeps its id, as Codex and Claude do. */
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, cwd, calls: [], threadId: `thread-${index}`, turnId: undefined, closed: false,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/resume') { this.threadId = params.threadId; return { thread: { id: params.threadId } }; }
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      lastText() { return this.started.at(-1)?.params.input.at(-1).text ?? ''; },
      async call(tool, args) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}-${++calls}`, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      item(text = 'working') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `item-${index}-${++calls}`, text } });
      },
      finish(text = 'done') {
        this.item(text);
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function until(check, what = 'condition') {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Expected ${what} did not arrive`);
}

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false'); // the host's global setting must not turn the files' LF into CRLF
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  const options = {
    supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'),
    worktreeDir: path.join(directory, 'worktrees'), copyDir: path.join(directory, 'copies'),
    liveFile: path.join(directory, 'state', 'live.json'), recallFile: path.join(directory, 'state', 'recall.json'),
  };
  return { directory, root, options };
}

const runLog = async (directory, rootId) => (await readFile(path.join(directory, 'runs', `${rootId}.jsonl`), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('a worktree assignment alpd stopped under continues in the next alpd: same thread, worktree, task and requester', async t => {
  const { directory, root, options } = await workspace(t);
  const runtimes = [];
  const first = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  await first.open('root', { cwd: root, persist: true });
  await first.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Build it' }] });
  const main = runtimes[0];
  const task = await createTask(root, { title: 'Add notes' }, 'user');
  const delegated = await main.call('alp_delegate', { agent: 'peer', task: 'Write notes.txt', taskId: task.id, mode: 'workspace-write', isolation: 'worktree', wait: false });
  assert.equal(delegated.status, 'running');
  const peer = runtimes[1];
  const id = delegated.assignmentId;
  await until(() => peer.started.length === 1, 'the peer turn');
  await writeFile(path.join(peer.cwd, 'notes.txt'), 'half done\n');
  const snapshot = first.snapshot('root');
  await first.shutdown();

  // Stopping kept the assignment for the next alpd; its task is still in progress.
  const live = JSON.parse(await readFile(options.liveFile, 'utf8'));
  assert.deepEqual(live.map(entry => [entry.assignmentId, entry.agent, entry.taskId, entry.isolation, entry.threadId]), [[id, 'peer', task.id, 'worktree', peer.threadId]]);
  assert.equal((await getTask(root, task.id)).status, 'in_progress');
  assert.ok((await runLog(directory, 'root')).some(entry => entry.event === 'assignment.interrupted' && entry.assignmentId === id));
  // As alpd does at start: work left in worktrees goes to their branches.
  assert.deepEqual(await reclaimWorktrees(options.worktreeDir), [`alp/${id}`]);

  const second = createAlpRuntime({ ...options, transport: fakeTransport(runtimes), previousExit: { kind: 'crash', at: '2026-10-09T03:00:00.000Z' } });
  t.after(() => second.shutdown());
  const events = [];
  second.onEvent(envelope => events.push(envelope));
  assert.deepEqual(second.recoverable().map(entry => entry.assignmentId), [id]);
  await second.open('root', { cwd: root, persist: true, restore: { agent: 'main', threadId: snapshot.threadId, runtime: snapshot.runtime, model: snapshot.model, workflow: snapshot.workflow } });
  const outcomes = await second.recover('root', { continueRoot: true });
  assert.deepEqual(outcomes, [{ assignmentId: id, agent: 'peer', outcome: 'resumed' }]);

  const [mainAgain, peerAgain] = runtimes.slice(2);
  assert.equal(peerAgain.calls[0].method, 'thread/resume');
  assert.equal(peerAgain.calls[0].params.threadId, peer.threadId);
  assert.equal(peerAgain.cwd, peer.cwd);
  assert.equal(await readFile(path.join(peerAgain.cwd, 'notes.txt'), 'utf8'), 'half done\n');
  await until(() => peerAgain.started.length === 1 && mainAgain.started.length === 1, 'both continued');
  assert.match(peerAgain.lastText(), /^ALP: alpd stopped unexpectedly while you worked on this assignment, and reopened this session\. Your earlier work in it and your worktree is intact/);
  assert.match(mainAgain.lastText(), new RegExp(`These assignments of yours continue and report to you: ${id} \\(peer, task ${task.id}\\)\\. Wait for them with alp_wait`));
  const retaken = await getTask(root, task.id);
  assert.equal(retaken.assignee.assignment, id);
  assert.equal(retaken.log.at(-1).event, 'resumed');
  assert.notEqual(retaken.assignee.epoch, live[0].epoch);
  const notice = events.find(envelope => envelope.event.type === 'item' && envelope.event.item.kind === 'notice');
  assert.equal(notice.event.item.text, 'ALP: alpd stopped unexpectedly (around 2026-10-09T03:00:00.000Z). 1 of 1 running assignments reopened, and this session.');

  // The continued assignment finishes as any other: main gets its result and the task waits for review.
  await peerAgain.call('alp_handoff', { outcome: 'complete', summary: 'Wrote notes.txt' });
  await writeFile(path.join(peerAgain.cwd, 'notes.txt'), 'done\n');
  peerAgain.finish('Done');
  const waited = await mainAgain.call('alp_wait', { assignments: [id] });
  assert.equal(waited.events[0].result.status, 'completed');
  assert.deepEqual(waited.events[0].result.worktree.files, ['notes.txt']);
  assert.equal((await getTask(root, task.id)).status, 'review');
  await until(async () => JSON.parse(await readFile(options.liveFile, 'utf8')).length === 0, 'the live file to empty');
  mainAgain.finish('ok');
});

test('a runtime process that dies mid-turn is restarted and its assignment continues; repeated deaths without progress fail it', async t => {
  const { directory, root, options } = await workspace(t);
  const runtimes = [];
  const runtime = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  const main = runtimes[0];
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Investigate', wait: false });
  let peer = runtimes[1];
  await until(() => peer.started.length === 1);
  const thread = peer.threadId;

  peer.failure(new Error('codex app-server exited with code 1'));
  await until(() => runtimes[2]?.started.length === 1, 'the restarted process');
  assert.equal(peer.closed, true);
  peer = runtimes[2];
  assert.deepEqual(peer.calls.slice(0, 2).map(call => [call.method, call.params.threadId]), [['thread/resume', thread], ['turn/start', thread]]);
  assert.match(peer.lastText(), /^ALP restarted your (Codex|Claude) process after it stopped in the middle of your turn\. Continue where you left off/);
  await until(async () => (await runLog(directory, 'root')).some(entry => entry.event === 'session.revived'), 'the revive in the run log');
  const log = await runLog(directory, 'root');
  assert.deepEqual(log.filter(entry => entry.event.startsWith('session.')).map(entry => entry.event), ['session.restarted', 'session.revived']);
  // Progress keeps the breaker closed: an assignment that works between deaths keeps being restarted.
  for (let death = 0; death < 3; death++) {
    peer.item('found something');
    const next = runtimes.length;
    peer.failure(new Error('killed'));
    await until(() => runtimes[next]?.started.length === 1, `restart ${death + 2}`);
    peer = runtimes[next];
  }
  // Three restarts in a row that bring no progress: the next death ends the assignment.
  for (let death = 0; death < 2; death++) {
    const next = runtimes.length;
    peer.failure(new Error('killed again'));
    await until(() => runtimes[next]?.started.length === 1, `restart without progress ${death + 1}`);
    peer = runtimes[next];
  }
  const count = runtimes.length;
  peer.failure(new Error('killed for good'));
  let finished;
  await until(async () => (finished = (await runLog(directory, 'root')).find(entry => entry.event === 'assignment.finished' && entry.assignmentId === assignmentId)), 'the assignment to end');
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /killed for good/);
  assert.equal(runtimes.length, count);
  main.finish('ok');
});

test('assignments the next alpd cannot continue end with their task reopened; parked recovery needs an explicit session prompt', async t => {
  const { directory, root, options } = await workspace(t);
  const runtimes = [];
  const start = async () => {
    const runtime = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
    await runtime.open('root', { cwd: root, persist: true });
    await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
    const main = runtimes.at(-1);
    const task = await createTask(root, { title: `Task ${runtimes.length}` }, 'user');
    const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Do it', taskId: task.id, wait: false });
    await until(() => runtimes.at(-1).started.length === 1);
    const snapshot = runtime.snapshot('root');
    await runtime.shutdown();
    return { task, assignmentId, snapshot };
  };

  const abandoned = await start();
  const second = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  const outcomes = await second.abandon('root', 'its root session cannot be reopened');
  assert.deepEqual(outcomes, [{ assignmentId: abandoned.assignmentId, agent: 'peer', outcome: 'failed', error: 'its root session cannot be reopened' }]);
  const task = await getTask(root, abandoned.task.id);
  assert.equal(task.status, 'open');
  assert.match(task.log.at(-1).reason, /alpd restarted and it could not continue: its root session cannot be reopened/);
  assert.ok((await runLog(directory, 'root')).some(entry => entry.event === 'assignment.finished' && entry.assignmentId === abandoned.assignmentId && entry.status === 'failed' && entry.reconciled));
  assert.deepEqual(JSON.parse(await readFile(options.liveFile, 'utf8')), []);
  await second.shutdown();

  const parked = await start();
  const third = createAlpRuntime({ ...options, transport: fakeTransport(runtimes), recoveryResume: false });
  t.after(() => third.shutdown());
  const events = [];
  third.onEvent(envelope => events.push(envelope));
  await third.open('root', { cwd: root, persist: true, restore: { agent: 'main', threadId: parked.snapshot.threadId, runtime: parked.snapshot.runtime, model: parked.snapshot.model, workflow: parked.snapshot.workflow } });
  assert.deepEqual((await third.recover('root')).map(outcome => outcome.outcome), ['parked']);
  const peer = runtimes.at(-1);
  assert.equal(peer.started.length, 0);
  assert.deepEqual(third.pauses().parked.map(entry => [entry.assignmentId, entry.reason]), [[parked.assignmentId, 'alpd restarted']]);
  assert.match(events.find(envelope => envelope.event.item?.kind === 'notice').event.item.text, /1 of 1 running assignments reopened; they wait parked: send an explicit prompt to each parked session to continue it: alp send <session> --prompt <text>\./);
  third.resume({ runtime: parked.snapshot.runtime });
  third.resume();
  // Queue barrier after both resume callbacks: manual recovery has no pause provenance.
  await third.recover('root');
  assert.equal(peer.started.length, 0);
  assert.ok(third.snapshot(parked.assignmentId).parked);
  await third.prompt(parked.assignmentId, { clientMessageId: 'explicit-recovery', delivery: 'auto', content: [{ type: 'text', text: 'Continue recovered assignment' }] });
  await until(() => peer.started.length === 1);
  assert.equal(third.snapshot(parked.assignmentId).parked, undefined);
  assert.match(peer.lastText(), /Continue recovered assignment/);
  assert.equal((await loadTasks(root)).tasks.find(entry => entry.id === parked.task.id).status, 'in_progress');
});

test('alpd reopens a tree by itself after a restart and its assignment continues with no client attached', async t => {
  const { directory, root, options } = await workspace(t);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] } }));
  const runtimes = [];
  const daemon = async () => {
    const runtime = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
    const store = createStore(path.join(directory, 'state'));
    const socketPath = daemonPaths(path.join(directory, `d${runtimes.length}`)).socket;
    const server = createDaemonServer({ runtime, socketPath, version: 'test', store, runLogDir: options.runLogDir });
    await server.listen();
    const stop = async () => { await server.close(); await runtime.shutdown(); await store.flush(); };
    t.after(stop);
    return { runtime, socketPath, store, stop };
  };
  const first = await daemon();
  const client = await connect(first.socketPath);
  const { session } = await client.request('session.create', { spec: { cwd: root, persist: true } });
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: [{ type: 'text', text: 'Delegate' }] });
  await until(() => runtimes[0]?.started.length === 1);
  const delegated = await runtimes[0].call('alp_delegate', { agent: 'lead', task: 'Work', wait: false });
  await until(() => runtimes[1]?.started.length === 1);
  runtimes[0].finish('Waiting for lead');
  client.close();
  // A clean stop keeps running work, as a crash does.
  await first.stop();

  const before = runtimes.length;
  const second = await daemon();
  await until(() => runtimes.length === before + 2 && runtimes[before + 1].started.length === 1, 'the lead to continue');
  const [mainAgain, leadAgain] = runtimes.slice(before);
  assert.equal(mainAgain.started.length, 0);
  assert.equal(leadAgain.calls[0].params.threadId, runtimes[1].threadId);
  assert.match(leadAgain.lastText(), /^ALP: alpd restarted while you worked on this assignment/);
  assert.equal(second.runtime.snapshot(delegated.assignmentId).parentId, session.id);
  // The lead finishes; main wakes for its result, then the tree closes since nobody watches it.
  await leadAgain.call('alp_handoff', { outcome: 'complete', summary: 'Worked' });
  leadAgain.finish('done');
  await until(() => mainAgain.started.length === 1, 'main to wake for the result');
  assert.match(mainAgain.started[0].params.input.at(-1).text, /Worked/);
  mainAgain.finish('Reported');
  await until(() => !second.runtime.snapshot(session.id), 'the unwatched root to close');
  // The store records the close after the root goes.
  await until(async () => (await second.store.list()).find(record => record.id === delegated.assignmentId)?.status === 'closed', 'the assignment record to close');
  assert.ok((await stat(options.liveFile)).isFile());
});


test('an external shared writer recovers its write root, inspection scope and repository lease', async t => {
  const { directory, root, options } = await workspace(t);
  const core = path.join(directory, 'core');
  await mkdir(core);
  git(core, 'init', '-q', '-b', 'main');
  git(core, 'config', 'core.autocrlf', 'false'); // the host's global setting must not turn the files' LF into CRLF
  await writeFile(path.join(core, 'a.txt'), 'initial');
  git(core, 'add', '-A');
  git(core, 'commit', '-qm', 'init');
  const canonicalCore = await realpath(core);
  const runtimes = [];
  const first = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  t.after(() => first.shutdown());
  await first.open('root', { cwd: root, persist: true });
  await first.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Work in core' }] });
  const delegated = await runtimes[0].call('alp_delegate', { agent: 'peer', task: 'Write only core', mode: 'workspace-write', writeRoot: '../core' });
  assert.equal(delegated.status, 'running', JSON.stringify(delegated));
  const snapshot = first.snapshot('root');
  await first.shutdown();
  const live = JSON.parse(await readFile(options.liveFile, 'utf8'));
  assert.deepEqual([live[0].spec.writeRoot, live[0].spec.workdir, live[0].lease], [canonicalCore, canonicalCore, canonicalCore]);
  const second = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  t.after(() => second.shutdown());
  await second.open('root', { cwd: root, persist: true, restore: { agent: 'main', threadId: snapshot.threadId, runtime: snapshot.runtime, model: snapshot.model, workflow: snapshot.workflow } });
  assert.equal((await second.recover('root', { continueRoot: true }))[0].outcome, 'resumed');
  const main = runtimes[2];
  const peer = runtimes[3];
  assert.equal(peer.cwd, canonicalCore);
  await until(() => peer.started.length && main.started.length);
  assert.ok((await peer.call('alp_pin', { kind: 'claim', body: 'Core', paths: ['../core/a.txt'] })).pinned);
  const blocked = await main.call('alp_delegate', { agent: 'peer', task: 'Core again', mode: 'workspace-write', writeRoot: '../core' });
  assert.match(blocked.error, /already running/);
  const beside = await main.call('alp_delegate', { agent: 'peer', task: 'Project instead', mode: 'workspace-write' });
  assert.equal(beside.status, 'running', JSON.stringify(beside));
});

test('recovery migrates an old thinking level and persists the resolved effort', async t => {
  const { root, options } = await workspace(t);
  const runtimes = [];
  const first = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  t.after(() => first.shutdown());
  await first.open('root', { cwd: root, persist: true });
  await first.prompt('root', { clientMessageId: 'm1', content: [{ type: 'text', text: 'Work' }] });
  const main = runtimes[0];
  const args = { agent: 'peer', task: 'Inspect', mode: 'read-only', model: 'codex:gpt-6-astra' };
  assert.match((await main.call('alp_delegate', { ...args, thinking: 'high' })).error, /unsupported|takes effort/i);
  const started = await main.call('alp_delegate', args);
  assert.ok(started.assignmentId, JSON.stringify(started));
  const peer = runtimes.at(-1);
  await until(() => peer.started.length === 1);
  const snapshot = first.snapshot('root');
  await first.shutdown();
  const live = JSON.parse(await readFile(options.liveFile, 'utf8'));
  assert.equal(live[0].spec.thinking, 'low');
  // Simulate an assignment accepted by the older catalog, before Astra became low-only.
  live[0].spec.thinking = 'high';
  await writeFile(options.liveFile, JSON.stringify(live));
  const second = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  t.after(() => second.shutdown());
  await second.open('root', { cwd: root, persist: true, restore: { agent: 'main', threadId: snapshot.threadId, runtime: snapshot.runtime, model: snapshot.model, workflow: snapshot.workflow } });
  assert.deepEqual(await second.recover('root'), [{ assignmentId: started.assignmentId, agent: 'peer', outcome: 'resumed' }]);
  const resumed = runtimes.at(-1);
  await until(() => resumed.started.length === 1);
  assert.equal(resumed.calls.find(call => call.method === 'thread/resume').params.threadId, peer.threadId);
  assert.equal(resumed.started[0].params.effort, 'low');
  await second.shutdown();
  assert.equal(JSON.parse(await readFile(options.liveFile, 'utf8'))[0].spec.thinking, 'low');
});

test('finished shared assignments remain continuable after a daemon restart', async t => {
  const { root, options } = await workspace(t);
  const runtimes = [];
  const first = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  t.after(() => first.shutdown());
  await first.open('root', { cwd: root, persist: true });
  await first.prompt('root', { clientMessageId: 'm1', content: [{ type: 'text', text: 'Work' }] });
  const main = runtimes[0];
  const started = await main.call('alp_delegate', { agent: 'peer', task: 'Read the code', mode: 'read-only' });
  const peer = runtimes.at(-1);
  await until(() => peer.started.length === 1);
  assert.match((await main.call('alp_delegate', { agent: 'peer', task: 'Continue', mode: 'read-only', continueFrom: started.assignmentId })).error, /running or parked/);
  await peer.call('alp_handoff', { outcome: 'complete', summary: 'Found the parser' });
  peer.finish('Look in parser.js');
  await main.call('alp_wait', { assignments: [started.assignmentId] });
  const snapshot = first.snapshot('root');
  await first.shutdown();
  const second = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  t.after(() => second.shutdown());
  await second.open('root', { cwd: root, persist: true, restore: { agent: 'main', threadId: snapshot.threadId, runtime: snapshot.runtime, model: snapshot.model, workflow: snapshot.workflow } });
  await second.prompt('root', { clientMessageId: 'm2', content: [{ type: 'text', text: 'Continue' }] });
  const continued = await runtimes.at(-1).call('alp_delegate', { agent: 'peer', task: 'Explain the parser', mode: 'read-only', continueFrom: started.assignmentId });
  assert.ok(continued.assignmentId, JSON.stringify(continued));
  const next = runtimes.at(-1);
  await until(() => next.started.length === 1);
  assert.equal(next.cwd, root);
  assert.match(next.lastText(), /Read the code/);
  assert.match(next.lastText(), /Found the parser/);
  assert.match(next.lastText(), /Look in parser.js/);
});

for (const mode of ['poll after restart', 'reset before restart', 'autoResume false', 'manual pause', 'global pause', 'failed start']) {
  test(`an isolated legacy usage-stopped root waits for an explicit prompt after daemon restart: ${mode}`, async t => {
    const { directory, root, options } = await workspace(t);
    const runtimes = [];
    let used = 100;
    let failNext = mode === 'failed start';
    const factory = fakeTransport(runtimes);
    const pauseFile = path.join(directory, 'state', 'pause.json');
    const daemon = async () => {
      const runtime = createAlpRuntime({ ...options, pauseFile, autoResume: mode !== 'autoResume false', limitCheckMs: 20,
        transport: (...args) => {
          const agent = factory(...args);
          const request = agent.request.bind(agent);
          return Object.assign(agent, {
            async orchestrationContext() { return { usage: { available: true, limits: [{ windows: [{ usedPercent: used }] }] } }; },
            async request(method, params) {
              if (failNext && method === 'turn/start' && agent.calls.some(call => call.method === 'thread/resume')) {
                failNext = false;
                throw new Error('resume start failed');
              }
              return request(method, params);
            },
          });
        } });
      const store = createStore(path.join(directory, 'state'));
      const socketPath = daemonPaths(path.join(directory, `limit-${runtimes.length}`)).socket;
      const server = createDaemonServer({ runtime, store, socketPath, version: 'test', runLogDir: options.runLogDir });
      await server.listen();
      let stopped = false;
      const stop = async () => { if (stopped) return; stopped = true; await server.close(); await runtime.shutdown(); await store.flush(); };
      t.after(stop);
      return { runtime, store, socketPath, stop };
    };
    const first = await daemon();
    const client = await connect(first.socketPath);
    const { session } = await client.request('session.create', { spec: { cwd: root, persist: true, model: 'codex:gpt-5.6-sol' } });
    await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'limit-work', content: [{ type: 'text', text: 'Finish notes' }] });
    const main = runtimes.find(agent => agent.started.length);
    await until(() => first.runtime.snapshot(session.id)?.activeTurnId, 'root active');
    await writeFile(path.join(root, 'notes.txt'), 'unfinished work');
    main.notification('turn/completed', { threadId: main.threadId, turn: { id: main.turnId, status: 'failed', error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded', resetsAt: Math.floor(Date.now() / 1000) + 3600 } } });
    await until(() => first.runtime.snapshot(session.id)?.parked, 'root parked');
    await until(() => first.runtime.pauses().runtimes.codex, 'usage pause');
    if (mode === 'global pause') await first.runtime.pause({});
    if (mode === 'manual pause') await first.runtime.pause({ runtime: 'codex' });
    client.close();
    await first.stop();
    assert.ok((await first.store.list()).find(record => record.id === session.id).session.parked);
    const before = runtimes.length;
    if (mode === 'reset before restart') { used = 0; await writeFile(pauseFile, JSON.stringify({ runtimes: {} })); }
    let second = await daemon();
    await until(() => second.runtime.snapshot(session.id)?.threadId === main.threadId, 'root thread reopened without client');
    let again = runtimes.slice(before).find(agent => agent.calls.some(call => call.method === 'thread/resume' && call.params.threadId === main.threadId));
    assert.ok(again);
    await until(() => second.runtime.snapshot(session.id)?.parked, 'legacy root restored parked');
    assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'unfinished work');
    // Hold real atomic record replacements so runtime completion cannot accidentally
    // stand in for persistence completion. Other tests/files keep their normal I/O.
    await second.store.flush();
    const rename = fs.rename;
    let releaseWrites;
    let heldWrites = 0;
    if (mode === 'global pause') {
      const held = new Promise(resolve => { releaseWrites = resolve; });
      const recordFile = path.join(directory, 'state', 'sessions', `${session.id}.json`);
      fs.rename = async (from, to) => {
        if (to === recordFile) { heldWrites++; await held; }
        return rename(from, to);
      };
      syncBuiltinESMExports();
    }
    try {
      used = 0;
      if (mode === 'autoResume false' || mode === 'manual pause' || mode === 'global pause') {
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(again.started.length, 0);
        assert.ok(second.runtime.snapshot(session.id).parked);
        second.runtime.resume();
      }
      await until(() => !second.runtime.pauses().all && !second.runtime.pauses().runtimes.codex, 'provider pause lifted');
      second.runtime.resume({ runtime: 'codex' });
      second.runtime.resume();
      await second.runtime.recover(session.id);
      assert.equal(again.started.length, 0, 'legacy reason cannot grant automatic scope resume');
      assert.ok(second.runtime.snapshot(session.id).parked);
      const prompt = clientMessageId => second.runtime.prompt(session.id, { clientMessageId, delivery: 'auto', content: [{ type: 'text', text: 'Continue the recovered notes' }] });
      await prompt('explicit-recovery');
      if (mode === 'failed start') {
        await until(() => !failNext && second.runtime.snapshot(session.id)?.parked, 'failed start retains intent');
        assert.equal(again.started.length, 0);
        await second.stop();
        const retryIndex = runtimes.length;
        second = await daemon();
        await until(() => second.runtime.snapshot(session.id)?.threadId === main.threadId, 'failed start recovers on another restart');
        again = runtimes.slice(retryIndex).find(agent => agent.calls.some(call => call.method === 'thread/resume' && call.params.threadId === main.threadId));
        await until(() => second.runtime.snapshot(session.id)?.parked, 'failed explicit start remains parked after restart');
        assert.equal(again.started.length, 0);
        await prompt('explicit-recovery-retry');
      }
      await until(() => again.started.length === 1, 'exactly one continued root turn');
      second.runtime.resume();
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(again.started.length, 1);
      assert.equal(again.started[0].params.threadId, main.threadId);
      assert.doesNotMatch(again.lastText(), /alp_handoff/);
      let closed = false;
      const unsubscribe = second.runtime.onEvent(({ sessionId: id, event }) => {
        if (id === session.id && event.type === 'session.closed') closed = true;
      });
      try {
        again.finish('done');
        await until(() => closed, 'finished unwatched root emits session.closed');
      } finally { unsubscribe(); }
      assert.equal(second.runtime.snapshot(session.id), undefined, 'finished unwatched root closes');
      if (mode === 'global pause') {
        assert.ok(heldWrites > 0, 'a real record replacement is held');
        assert.ok((await second.store.list()).find(record => record.id === session.id).session.parked, 'disk still has the parked record while replacement is held');
      }
      releaseWrites?.();
      await second.store.flush();
      const completed = (await second.store.list()).find(record => record.id === session.id);
      assert.equal(completed.status, 'closed');
      assert.equal(completed.session.parked, undefined);
      await second.stop();
      const finishedIndex = runtimes.length;
      const third = await daemon();
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(third.runtime.snapshot(session.id), undefined, 'completed root stays closed after restart');
      assert.ok(runtimes.slice(finishedIndex).every(agent => !agent.calls.some(call => call.method === 'thread/resume' && call.params.threadId === main.threadId)));
    } finally {
      releaseWrites?.();
      fs.rename = rename;
      syncBuiltinESMExports();
      await second.store.flush();
    }
  });
}


// Built CLI -> real socket daemon -> runtime -> scripted native transport. Every home is disposable.
test('explicit CLI prompt continues a manual recovery child; default send remains mail', async t => {
  const { directory, root, options } = await workspace(t);
  const home = path.join(directory, 'cli-home');
  await mkdir(home, { mode: 0o700 });
  const runtimes = [];
  const first = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  await first.open('root', { cwd: root, persist: true });
  await first.prompt('root', { clientMessageId: 'initial', delivery: 'auto', content: [{ type: 'text', text: 'Delegate' }] });
  const delegated = await runtimes[0].call('alp_delegate', { agent: 'peer', task: 'ORIGINAL ASSIGNMENT', mode: 'read-only', wait: false });
  const control = await runtimes[0].call('alp_delegate', { agent: 'peer', task: 'CONTROL ASSIGNMENT', mode: 'read-only', wait: false });
  assert.ok(control.assignmentId, JSON.stringify(control));
  await until(() => runtimes[1]?.started.length === 1 && runtimes[2]?.started.length === 1);
  const peerThread = runtimes[1].threadId;
  const controlThread = runtimes[2].threadId;
  const snapshot = first.snapshot('root');
  await first.shutdown();
  const runtime = createAlpRuntime({ ...options, recoveryResume: false, transport: fakeTransport(runtimes) });
  const socketPath = daemonPaths(home).socket;
  const server = createDaemonServer({ runtime, socketPath, version: 'test', runLogDir: options.runLogDir });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); });
  await writeFile(daemonPaths(home).lock, JSON.stringify({ pid: process.pid, bootTime: bootTime(), ready: true, socket: socketPath }));
  const observer = await connect(socketPath);
  t.after(() => observer.close());
  await observer.request('session.create', { sessionId: 'root', spec: { cwd: root, persist: true, restore: { agent: 'main', threadId: snapshot.threadId, runtime: snapshot.runtime, model: snapshot.model, workflow: snapshot.workflow } } });
  await runtime.recover('root');
  const peer = runtimes.findLast(agent => agent.threadId === peerThread);
  const controlPeer = runtimes.findLast(agent => agent.threadId === controlThread);
  const rootPeer = runtimes.findLast(agent => agent.threadId === snapshot.threadId);
  const cli = (...args) => {
    const child = spawn(process.execPath, [process.env.ALP_TEST_RECOVERY_CLI ?? path.resolve('packages/cli/dist/cli.js'), ...args], { cwd: root, env: { ...process.env, ALP_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const timeout = setTimeout(() => child.kill(), 10000);
    const done = new Promise(resolve => child.on('close', code => { clearTimeout(timeout); resolve({ code, output }); }));
    return { child, done };
  };
  const mailed = await cli('send', delegated.assignmentId, 'QUEUED USER MAIL').done;
  assert.equal(mailed.code, 0, mailed.output);
  assert.equal(peer.started.length, 0, 'mail must not unpark recovery');
  assert.ok(runtime.snapshot(delegated.assignmentId).parked);
  const client = await connect(socketPath);
  t.after(() => client.close());
  // The existing RPC is an independent positive control on another recovery child.
  await client.request('session.prompt', { sessionId: control.assignmentId, clientMessageId: 'control', content: [{ type: 'text', text: 'RPC CONTROL' }] });
  await until(() => controlPeer.started.length === 1);
  assert.match(JSON.stringify(controlPeer.started[0]), /RPC CONTROL/);
  assert.ok(runtime.snapshot(delegated.assignmentId).parked);
  await runtime.pause({ runtime: runtime.snapshot(delegated.assignmentId).runtime });
  const prompted = cli('send', delegated.assignmentId, '--prompt', '--json', 'EXPLICIT CLI TEXT');
  await until(() => peer.started.length === 1 || prompted.child.exitCode !== null, 'CLI prompt or rejection');
  assert.equal(peer.started.length, 1, (await Promise.race([prompted.done, Promise.resolve({ output: 'CLI did not start a turn' })])).output);
  assert.match(JSON.stringify(peer.started[0]), /EXPLICIT CLI TEXT/);
  assert.doesNotMatch(JSON.stringify(peer.started[0]), /ORIGINAL ASSIGNMENT|alpd restarted while/);
  assert.equal(JSON.stringify(peer.started[0]).split('QUEUED USER MAIL').length - 1, 1, 'queued mail is delivered once');
  assert.ok(runtime.pauses().runtimes[runtime.snapshot(delegated.assignmentId).runtime], 'explicit prompt does not lift provider pause');
  assert.equal(runtime.snapshot(delegated.assignmentId).parked, undefined);
  const blocked = await cli('send', delegated.assignmentId, '--prompt', '--json', 'SECOND ACTIVE PROMPT').done;
  assert.equal(blocked.code, 1, blocked.output);
  assert.match(blocked.output, /Turn already active/);
  assert.equal(peer.started.length, 1, 'active refusal never starts another turn');
  runtime.resume({ runtime: runtime.snapshot(delegated.assignmentId).runtime });
  rootPeer.item('ROOT OUTPUT MUST NOT LEAK');
  assert.equal(rootPeer.started.length, 0, 'child action never prompts the root');
  peer.finish();
  const result = await prompted.done;
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /ROOT OUTPUT MUST NOT LEAK|RPC CONTROL/);
  const closed = await cli('send', delegated.assignmentId, '--prompt', 'DO NOT REOPEN').done;
  assert.equal(closed.code, 1, closed.output);
  const unknown = await cli('send', 'missing-child', '--prompt', 'UNKNOWN').done;
  assert.equal(unknown.code, 1, unknown.output);
  controlPeer.finish();
  await until(() => {
    if (runtime.snapshot('root').activeTurnId) rootPeer.finish();
    return !runtime.snapshot('root').busy;
  });
  const rootTurns = rootPeer.started.length;
  const rootRun = cli('send', 'root', '--prompt', '--json', 'ROOT EXPLICIT');
  await until(() => rootPeer.started.length === rootTurns + 1);
  assert.match(JSON.stringify(rootPeer.started.at(-1)), /ROOT EXPLICIT/);
  rootPeer.finish();
  const rootResult = await rootRun.done;
  assert.equal(rootResult.code, 0, rootResult.output);
  const defaultRoot = cli('send', 'root', '--json', 'DEFAULT ROOT STILL WORKS');
  await until(() => rootPeer.started.length === rootTurns + 2);
  assert.match(JSON.stringify(rootPeer.started.at(-1)), /DEFAULT ROOT STILL WORKS/);
  rootPeer.finish();
  assert.equal((await defaultRoot.done).code, 0);
  assert.equal(peer.started.length, 1, 'exactly one new turn');
});
