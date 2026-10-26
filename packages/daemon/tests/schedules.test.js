// alpd's scheduled continuations (ALPD §71): a job that comes due opens a turn on the
// session it names, without a user message, at most once, and says what became of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore, createScheduleStore, createScheduler } from '@anhlp/alp-daemon';

async function until(check, what = 'condition') {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} did not happen`);
}

/** A scripted native runtime; set `hold` to a promise to keep turn/start unanswered until it settles. */
function fakeTransport(runtimes, resumeGate) {
  return () => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() {},
      async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/resume') { await resumeGate?.(); return { thread: { id: params.threadId } }; }
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { await this.hold; this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        if (method === 'turn/interrupt') { queueMicrotask(() => this.notification('turn/completed', { threadId: this.threadId, turn: { id: params.turnId, status: 'interrupted' } })); return {}; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `out-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

/** A daemon with a real store; `start` again on the same directory is a restart. */
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-schedule-'));
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] } }));
  const runtimes = [];
  const stops = [];
  const releases = [];
  t.after(async () => { for (const release of releases) release(); for (const stop of stops.reverse()) await stop(); await rm(directory, { recursive: true, force: true }); });
  const state = path.join(directory, 'state');
  let count = 0;
  async function start(options = {}) {
    const { openDelayMs, openFailure, resumeGate, ...rest } = options;
    const runtime = createAlpRuntime({ transport: fakeTransport(runtimes, resumeGate), runLogDir: path.join(directory, 'runs') });
    // A daemon whose sessions take a moment to open again, as a real provider does,
    // or one whose sessions cannot be opened at all.
    const daemon = openDelayMs || openFailure
      ? { ...runtime, open: async (...args) => {
        if (openFailure) throw new Error(openFailure);
        if (openDelayMs) await new Promise(resolve => setTimeout(resolve, openDelayMs));
        return runtime.open(...args);
      } }
      : runtime;
    const store = createStore(state);
    const socketPath = daemonPaths(path.join(directory, `d${count++}`)).socket;
    const server = createDaemonServer({ runtime: daemon, socketPath, version: 'test', store, home: directory, scheduleTickMs: 20, ...rest });
    await server.listen();
    const clients = [];
    const open = async () => {
      const client = await connect(socketPath, { name: 'test', version: '0' });
      const events = [];
      client.onEvent(envelope => events.push(envelope));
      clients.push(client);
      return { client, events, request: (method, params) => client.request(method, params) };
    };
    let stopped = false;
    const stop = async () => { if (stopped) return; stopped = true; clients.forEach(client => client.close()); await store.flush().catch(() => {}); await server.close().catch(() => {}); await runtime.shutdown(); };
    stops.push(stop);
    const first = await open();
    // A request waits for the startup restore; Windows cannot move a directory it is still reading.
    await first.request('daemon.status');
    return { runtime, store, server, open, stop, project, ...first };
  }
  const create = (daemon, params = {}) => daemon.request('session.create', { spec: { cwd: project, persist: true }, ...params });
  return { directory, state, project, runtimes, start, create, releases };
}

/** The text of the user message the session received, if it received one. */
const userTexts = events => events.filter(event => event.event.type === 'item' && event.event.item.kind === 'user_message').map(event => event.event.item.text);
const promptOf = (events, text) => userTexts(events).find(body => body.includes(text));
const inMs = ms => new Date(Date.now() + ms).toISOString();
/** The job as the daemon answers it now; the project of the daemon names it. */
const jobOf = (daemon, id) => daemon.request('schedule.get', { id, projectRoot: daemon.project }).then(answer => answer.job);
/** Waits until the job says it is through. */
const untilStatus = (daemon, id, status) => until(async () => (await jobOf(daemon, id)).status === status, `the job did not become ${status}`);

test('a job that comes due opens a turn on its session, without a user message', async t => {
  const { start, create, project } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  assert.equal(session.parentId, undefined, 'the target is a root session');

  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60), prompt: 'Check the provider quota.' });
  assert.match(job.id, /^sch_[0-9a-f]{16}$/);
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 0);
  assert.equal(job.sessionId, session.id);

  await until(() => promptOf(daemon.events, 'Check the provider quota.'), 'the job did not open a turn');
  const text = promptOf(daemon.events, 'Check the provider quota.');
  assert.match(text, /scheduled continuation/, 'the prompt says what it is');
  assert.match(text, new RegExp(job.id), 'the prompt names the job');

  await untilStatus(daemon, job.id, 'delivered');
  const after = await jobOf(daemon, job.id);
  assert.equal(after.attempts, 1);
  assert.ok(after.deliveredAt, 'the delivery is timed');
  assert.equal(after.lastError, undefined);
});

for (const phase of ['queued wake', 'in-flight wake start']) {
  test(`a due job waits for a ${phase} with no active turn id, then delivers once`, async t => {
    const { start, create, project, runtimes, releases } = await setup(t);
    const daemon = await start();
    const { session } = await create(daemon);
    const wake = runtimes[0];
    let releaseWake;
    wake.hold = new Promise(resolve => { releaseWake = resolve; });
    releases.push(() => releaseWake());
    let releaseBlock;
    let blocked;
    if (phase === 'queued wake') {
      await daemon.runtime.open('queue-blocker', { cwd: project });
      const blocker = runtimes.at(-1);
      blocker.hold = new Promise(resolve => { releaseBlock = resolve; });
      releases.push(() => releaseBlock());
      blocked = daemon.runtime.prompt('queue-blocker', { clientMessageId: 'block', delivery: 'auto', content: [{ type: 'text', text: 'Hold the global admission queue.' }] });
      await until(() => blocker.started.length === 1);
    }
    daemon.runtime.message(session.id, 'Wake before the scheduled continuation.');
    if (phase === 'in-flight wake start') await until(() => wake.started.length === 1);
    assert.equal(daemon.runtime.snapshot(session.id).activeTurnId, undefined);
    const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(-1), prompt: `Continue after ${phase}.` });
    await until(async () => {
      const current = await jobOf(daemon, job.id);
      return current.attempts > 0 || current.lastError?.code === 'session_busy';
    }, 'the due job was inspected');
    const waiting = await jobOf(daemon, job.id);
    assert.equal(waiting.attempts, 0, 'busy admission must not consume an attempt or create a receipt');
    assert.equal(waiting.status, 'pending');
    assert.equal(waiting.lastError.code, 'session_busy');
    assert.equal(promptOf(daemon.events, `Continue after ${phase}.`), undefined);
    releaseBlock?.();
    await blocked;
    await until(() => wake.started.length === 1);
    releaseWake();
    await until(() => daemon.runtime.snapshot(session.id).activeTurnId);
    wake.finish();
    await untilStatus(daemon, job.id, 'delivered');
    assert.equal((await jobOf(daemon, job.id)).attempts, 1);
    assert.equal(wake.started.length, 2, 'one wake and exactly one scheduled turn');
    assert.equal(userTexts(daemon.events).filter(text => text.includes(`Continue after ${phase}.`)).length, 1);
  });
}

for (const failReceipt of [false, true]) {
  test(`mail arriving during a scheduled receipt write cannot overtake admission (${failReceipt ? 'write failure' : 'success'})`, async t => {
    const { start, create, project, runtimes, releases } = await setup(t);
    const daemon = await start();
    const { session } = await create(daemon);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    releases.push(release);
    let entered = false;
    const putReceipt = daemon.store.putReceipt.bind(daemon.store);
    daemon.store.putReceipt = async (key, receipt) => {
      if (receipt.state === 'pending') {
        entered = true;
        await gate;
        if (failReceipt) throw new Error('receipt disk failure');
      }
      return putReceipt(key, receipt);
    };
    const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(-1), prompt: 'Persist before the wake.' });
    await until(() => entered);
    assert.equal(daemon.runtime.starting(session.id), true, 'lifecycle operations see admission before native start');
    daemon.runtime.message(session.id, 'Mail during the durable write.');
    assert.equal(runtimes[0].started.length, 0, 'neither prompt starts before durable preparation');
    await assert.rejects(daemon.request('schedule.cancel', { id: job.id, projectRoot: project }), { code: 1004 });
    release();
    await untilStatus(daemon, job.id, failReceipt ? 'failed' : 'delivered');
    await until(() => runtimes[0].started.length === 1);
    const input = JSON.stringify(runtimes[0].started[0].params.input);
    assert.equal(input.includes('Persist before the wake.'), !failReceipt, 'a write failure sends no job; success sends the admitted job first');
    assert.ok(input.includes('Mail during the durable write.'), 'mail is included in the admitted prompt or the failure wake');
    assert.equal((await jobOf(daemon, job.id)).attempts, 1);
    assert.equal(userTexts(daemon.events).filter(text => text.includes('Persist before the wake.')).length, failReceipt ? 0 : 1);
  });
}

test('the idle sender is single-use and expires when its admission callback ends', async t => {
  const { start, create, runtimes } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  let escaped;
  const result = await daemon.runtime.withIdlePrompt(session.id, async send => {
    escaped = send;
    await send({ clientMessageId: 'admitted', delivery: 'auto', content: [{ type: 'text', text: 'One admitted prompt.' }] });
    await assert.rejects(send({ clientMessageId: 'twice', delivery: 'auto', content: [] }), /no longer available/);
    return 'sent';
  });
  assert.deepEqual(result, { busy: false, value: 'sent' });
  await assert.rejects(escaped({ clientMessageId: 'escaped', delivery: 'auto', content: [] }), /no longer available/);
  assert.equal(runtimes[0].started.length, 1);
});

test('mail arriving during attempt persistence stays behind the admitted job', async t => {
  const { start, create, directory, project, runtimes, releases } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const store = createScheduleStore(path.join(directory, 'attempt-jobs'));
  const job = await store.create({ projectRoot: project, sessionId: session.id, dueAt: inMs(-1), prompt: 'Attempt gate.' });
  let entered = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  releases.push(release);
  const change = store.change.bind(store);
  store.change = async (...args) => {
    const result = await change(...args);
    if (result?.status === 'pending' && result.attempts === 1) { entered = true; await gate; }
    return result;
  };
  const scheduler = createScheduler({ store, runtime: daemon.runtime, deliver: async (job, content, clientMessageId, send = (id, input) => daemon.runtime.prompt(id, input)) => {
    await send(job.sessionId, { clientMessageId, delivery: 'auto', content });
    return { outcome: 'accepted' };
  } });
  const tick = scheduler.tick();
  await until(() => entered);
  daemon.runtime.message(session.id, 'Mail at attempt gate.');
  assert.equal(runtimes[0].started.length, 0);
  assert.equal(scheduler.delivering(job.id), true);
  release();
  assert.deepEqual(await tick, { delivered: 1, failed: 0, waiting: 0 });
  assert.equal(runtimes[0].started.length, 1);
  const input = JSON.stringify(runtimes[0].started[0].params.input);
  assert.ok(input.includes('Attempt gate.'));
  assert.ok(input.includes('Mail at attempt gate.'));
  await scheduler.tick();
  assert.equal(runtimes[0].started.length, 1);
});

test('a cancelled job waiting for runtime admission never consumes an attempt', async t => {
  const { start, create, directory, project, runtimes, releases } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  await daemon.runtime.open('cancel-blocker', { cwd: project });
  const blocker = runtimes.at(-1);
  let release;
  blocker.hold = new Promise(resolve => { release = resolve; });
  releases.push(release);
  const blocked = daemon.runtime.prompt('cancel-blocker', { clientMessageId: 'block', delivery: 'auto', content: [] });
  await until(() => blocker.started.length === 1);
  const store = createScheduleStore(path.join(directory, 'cancel-jobs'));
  const job = await store.create({ projectRoot: project, sessionId: session.id, dueAt: inMs(-1), prompt: 'Never admitted.' });
  let queued = false;
  const runtime = { ...daemon.runtime, withIdlePrompt: (...args) => { queued = true; return daemon.runtime.withIdlePrompt(...args); } };
  let sends = 0;
  const scheduler = createScheduler({ store, runtime, deliver: async () => { sends++; return { outcome: 'accepted' }; } });
  const tick = scheduler.tick();
  await until(() => queued);
  await store.change(job.id, () => ({ status: 'cancelled', cancelledAt: new Date().toISOString() }));
  release();
  await blocked;
  assert.deepEqual(await tick, { delivered: 0, failed: 0, waiting: 0 });
  assert.equal((await store.get(job.id)).attempts, 0);
  assert.equal((await store.get(job.id)).status, 'cancelled');
  assert.equal(sends, 0);
});

test('a scheduled continuation can still prompt a parked quota root once', async t => {
  const { start, create, project, runtimes } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  daemon.runtime.pause({ reason: 'quota test' });
  await daemon.runtime.recover(session.id, { parkedRoot: 'provider quota' });
  assert.equal(daemon.runtime.snapshot(session.id).busy, true);
  assert.equal(daemon.runtime.snapshot(session.id).parked, 'provider quota');
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(-1), prompt: 'Recheck quota and continue.' });
  await untilStatus(daemon, job.id, 'delivered');
  assert.equal((await jobOf(daemon, job.id)).attempts, 1);
  assert.equal(runtimes[0].started.length, 1);
  assert.equal(daemon.runtime.snapshot(session.id).parked, undefined);
});

test('a job that comes due late says how late it is', async t => {
  const { start, create, project } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  // The machine slept: the time passed while nobody was there to run the job.
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(-5 * 60 * 1000), prompt: 'Continue the quota check.' });

  await until(() => promptOf(daemon.events, 'Continue the quota check.'), 'the late job did not open a turn');
  const text = promptOf(daemon.events, 'Continue the quota check.');
  assert.match(text, /5 minutes late/, 'the prompt says how late the job is');

  await untilStatus(daemon, job.id, 'delivered');
  const after = await jobOf(daemon, job.id);
  assert.ok(after.lateByMs >= 5 * 60 * 1000, 'the job records the delay');
});

test('a job whose session is closed fails with the reason, and is not delivered', async t => {
  const { start, create, project } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60), prompt: 'Never delivered.' });
  await daemon.request('session.close', { sessionId: session.id });

  await until(async () => (await jobOf(daemon, job.id)).status !== 'pending', 'the job did not fail');
  const after = await jobOf(daemon, job.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.lastError.code, 'session_closed');
  assert.match(after.lastError.message, /closed/);
  assert.ok(after.failedAt, 'the failure is timed');
  assert.equal(after.deliveredAt, undefined);
  assert.equal(promptOf(daemon.events, 'Never delivered.'), undefined, 'nothing was delivered');
});

test('a job survives a restart of alpd and the next one delivers it', async t => {
  const { start, create, project } = await setup(t);
  // The first daemon's tick never comes; the job waits for the next alpd.
  const daemon = await start({ scheduleTickMs: 60_000 });
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(200), prompt: 'Survive the restart.' });
  await daemon.stop();

  const next = await start();
  const { jobs } = await next.request('schedule.list', { projectRoot: project });
  assert.equal(jobs.length, 1, 'the job is still there');
  assert.equal(jobs[0].id, job.id);
  assert.equal(jobs[0].status, 'pending');
  assert.equal(jobs[0].prompt, 'Survive the restart.');
  // The session the job names was reopened, so the job finds it.
  await next.request('session.attach', { sessionId: session.id });

  await until(() => promptOf(next.events, 'Survive the restart.'), 'the job did not fire after the restart');
  await untilStatus(next, job.id, 'delivered');
  const after = await jobOf(next, job.id);
  assert.equal(after.attempts, 1);
});

test('a job that came due while alpd was down is delivered, not failed', async t => {
  const { start, create, project } = await setup(t);
  // The first daemon's tick never comes; the job waits for the next alpd.
  const daemon = await start({ scheduleTickMs: 60_000 });
  const { session } = await create(daemon);
  // The job was due while nobody was there to run it: alpd was down.
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(-1000), prompt: 'Due while alpd was down.' });
  await daemon.stop();

  const next = await start({ scheduleTickMs: 20, openDelayMs: 300 });
  await next.request('session.attach', { sessionId: session.id });
  // The session is opened again by the recovery; the job waits for it and is delivered.
  await until(() => promptOf(next.events, 'Due while alpd was down.'), 'the job did not fire after the restart');
  await untilStatus(next, job.id, 'delivered');
  const after = await jobOf(next, job.id);
  assert.equal(after.lastError, undefined);
  assert.equal(after.attempts, 1);
});

test('a job that is hours late is still delivered after a restart', async t => {
  const { start, create, project, runtimes, releases } = await setup(t);
  const daemon = await start({ scheduleTickMs: 60_000 });
  const { session } = await create(daemon);
  // The machine slept for hours: the job is more than an hour late, and alpd was down.
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(-3 * 60 * 60 * 1000), prompt: 'Three hours late.' });
  await daemon.stop();

  let entered;
  const resuming = new Promise(resolve => { entered = resolve; });
  let release;
  const resume = new Promise(resolve => { release = resolve; });
  releases.push(release);
  // Hold the actual native resume: the runtime already exposes a snapshot, but its
  // thread is not ready. A scheduler tick must observe this exact recovery phase.
  const next = await start({ resumeGate: async () => { entered(); await resume; } });
  await resuming;
  assert.ok(next.runtime.snapshot(session.id), 'a snapshot exists before native resume answers');
  assert.equal(next.runtime.starting(session.id), true);
  await until(async () => {
    const current = await jobOf(next, job.id);
    return current.lastError || current.status !== 'pending';
  }, 'the scheduler inspected the job during native resume');
  const waiting = await jobOf(next, job.id);
  assert.equal(waiting.status, 'pending', 'native reopening is not a busy turn, however late the job');
  assert.equal(waiting.lastError.code, 'session_opening');
  assert.equal(waiting.attempts, 0);
  assert.equal(runtimes.at(-1).started.length, 0, 'no prompt reaches the unopened thread');
  release();
  await next.request('session.attach', { sessionId: session.id });
  // The lateness of the job says nothing about how long the session takes to open again.
  await until(() => promptOf(next.events, 'Three hours late.'), 'the late job did not fire after the restart');
  await untilStatus(next, job.id, 'delivered');
  const after = await jobOf(next, job.id);
  assert.ok(after.lateByMs >= 3 * 60 * 60 * 1000, 'the job records how late it is');
  assert.equal(after.attempts, 1);
  assert.equal(after.lastError, undefined);
  assert.equal(runtimes.at(-1).started.length, 1, 'the native runtime receives exactly one turn');
  assert.equal(userTexts(next.events).filter(text => text.includes('Three hours late.')).length, 1);
});

test('a job on a session the user closed is not resurrected after a restart', async t => {
  const { start, create, project } = await setup(t);
  const daemon = await start({ scheduleTickMs: 60_000 });
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(-1000), prompt: 'Never delivered.' });
  // The user closes the session: the job has no session to continue.
  await daemon.request('session.close', { sessionId: session.id });
  await daemon.stop();

  const next = await start({ scheduleTickMs: 20 });
  await until(async () => (await jobOf(next, job.id)).status !== 'pending', 'the job did not fail');
  const after = await jobOf(next, job.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.lastError.code, 'session_closed');
  assert.equal(promptOf(next.events, 'Never delivered.'), undefined, 'nothing was delivered');
});

test('a job whose session cannot be opened again fails with the reason', async t => {
  const { start, create, project } = await setup(t);
  const daemon = await start({ scheduleTickMs: 60_000 });
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(-1000), prompt: 'Never delivered.' });
  await daemon.stop();

  // The recovery of the new alpd cannot open the session again.
  const next = await start({ scheduleTickMs: 20, openFailure: 'the provider is gone' });
  await until(async () => (await jobOf(next, job.id)).status !== 'pending', 'the job did not fail');
  const after = await jobOf(next, job.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.lastError.code, 'session_open_failed');
  assert.match(after.lastError.message, /the provider is gone/, 'the job says why the session is gone');
  assert.equal(promptOf(next.events, 'Never delivered.'), undefined, 'nothing was delivered');
});

test('the reason of a session that cannot be opened again serves every job of that session', async t => {
  const { start, create, project } = await setup(t);
  const daemon = await start({ scheduleTickMs: 60_000 });
  const { session } = await create(daemon);
  const { job: first } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(-1000), prompt: 'First.' });
  const { job: second } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(-1000), prompt: 'Second.' });
  await daemon.stop();

  // The recovery of the new alpd cannot open the session again: both jobs say why.
  const next = await start({ scheduleTickMs: 20, openFailure: 'the provider is gone' });
  await until(async () => (await jobOf(next, first.id)).status !== 'pending' && (await jobOf(next, second.id)).status !== 'pending', 'the jobs did not fail');
  const one = await jobOf(next, first.id);
  const two = await jobOf(next, second.id);
  assert.equal(one.status, 'failed');
  assert.equal(one.lastError.code, 'session_open_failed');
  // The reason is kept while a job still waits for that session.
  assert.equal(two.status, 'failed');
  assert.equal(two.lastError.code, 'session_open_failed');
  assert.match(two.lastError.message, /the provider is gone/);
  assert.equal(promptOf(next.events, 'First.'), undefined, 'nothing was delivered');
  assert.equal(promptOf(next.events, 'Second.'), undefined, 'nothing was delivered');
});

test('a project is the same project, however it is spelled', async t => {
  const { start, create, project } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60), prompt: 'Spelled.' });

  // The same directory, named with a trailing slash: the job is found, not lost.
  const spelled = `${project}/`;
  const { jobs } = await daemon.request('schedule.list', { projectRoot: spelled });
  assert.deepEqual(jobs.map(entry => entry.id), [job.id], 'the job of the project is listed');
  const found = await daemon.request('schedule.get', { id: job.id, projectRoot: spelled });
  assert.equal(found.job.id, job.id, 'the job of the project is found');
  const { job: cancelled } = await daemon.request('schedule.cancel', { id: job.id, projectRoot: spelled });
  assert.equal(cancelled.status, 'cancelled', 'the job of the project is cancelled');
});

test('the jobs of a project are asked for with a project and a known status', async t => {
  const { start, create, project } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60), prompt: 'Strict.' });

  // A status the protocol does not name is refused, not an empty answer.
  await assert.rejects(daemon.request('schedule.list', { projectRoot: project, status: 'unknown' }), { code: -32602 });
  // A request with no params at all is refused the same way on all three methods.
  await assert.rejects(daemon.request('schedule.list', {}), { code: -32602 });
  await assert.rejects(daemon.request('schedule.get', {}), { code: -32602 });
  await assert.rejects(daemon.request('schedule.cancel', {}), { code: -32602 });
  await assert.rejects(daemon.request('schedule.get'), { code: -32602 });
  await assert.rejects(daemon.request('schedule.cancel'), { code: -32602 });
});

test('a project is named by the directory it is, not by the way it is written', async t => {
  const { start, create, project, directory } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60), prompt: 'The same directory.' });

  // A link to the same directory names the same project.
  const link = path.join(directory, 'link-to-project');
  await symlink(project, link);
  const { jobs } = await daemon.request('schedule.list', { projectRoot: link });
  assert.deepEqual(jobs.map(entry => entry.id), [job.id], 'the job is found through the link');
  // A relative path is refused: it would be read against the daemon's own directory.
  await assert.rejects(daemon.request('schedule.list', { projectRoot: 'project' }), { code: -32602 });
  await assert.rejects(daemon.request('schedule.create', { projectRoot: 'project', sessionId: session.id, dueAt: inMs(60), prompt: 'Relative.' }), { code: -32602 });
});

test('the jobs of a project are that project\'s alone', async t => {
  const { start, create, project } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60), prompt: 'Mine.' });

  // Another project asks about the job: there is none for it.
  await assert.rejects(daemon.request('schedule.get', { id: job.id, projectRoot: '/another/project' }), { code: 1001 });
  await assert.rejects(daemon.request('schedule.cancel', { id: job.id, projectRoot: '/another/project' }), { code: 1001 });
  const { jobs: theirs } = await daemon.request('schedule.list', { projectRoot: '/another/project' });
  assert.deepEqual(theirs, [], 'the job of another project is not listed');
  // The project is required: a client that names no project sees nothing.
  await assert.rejects(daemon.request('schedule.get', { id: job.id }), { code: -32602 });
  await assert.rejects(daemon.request('schedule.cancel', { id: job.id }), { code: -32602 });
  await assert.rejects(daemon.request('schedule.list', {}), { code: -32602 });
  // An id that names no job is refused, not read from somewhere else.
  await assert.rejects(daemon.request('schedule.get', { id: '../../etc/passwd', projectRoot: project }), { code: -32602 });
  await assert.rejects(daemon.request('schedule.get', { id: 'sch_0000000000000000', projectRoot: project }), { code: 1001 });

  // The job is untouched.
  const after = await jobOf(daemon, job.id);
  assert.equal(after.status, 'pending');
});

test('the jobs of a project can be listed by their status', async t => {
  const { start, create, project } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60), prompt: 'Listed.' });
  const { job: cancelled } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60), prompt: 'Cancelled.' });
  await daemon.request('schedule.cancel', { id: cancelled.id, projectRoot: project });

  const { jobs: pending } = await daemon.request('schedule.list', { projectRoot: project, status: 'pending' });
  assert.deepEqual(pending.map(entry => entry.id), [job.id]);
  const { jobs: cancelledJobs } = await daemon.request('schedule.list', { projectRoot: project, status: 'cancelled' });
  assert.deepEqual(cancelledJobs.map(entry => entry.id), [cancelled.id]);
  const { jobs: none } = await daemon.request('schedule.list', { projectRoot: project, status: 'delivered' });
  assert.deepEqual(none, []);
});

test('a job runs once, however often the daemon looks for it', async t => {
  const { start, create, project, runtimes } = await setup(t);
  const daemon = await start({ scheduleTickMs: 10 });
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(30), prompt: 'Only once.' });

  await until(() => promptOf(daemon.events, 'Only once.'), 'the job did not open a turn');
  await untilStatus(daemon, job.id, 'delivered');
  // Several more ticks pass.
  await new Promise(resolve => setTimeout(resolve, 120));
  const after = await jobOf(daemon, job.id);
  assert.equal(after.attempts, 1, 'the job was delivered once');
  assert.equal(userTexts(daemon.events).filter(text => text.includes('Only once.')).length, 1, 'the session got one turn');
  assert.equal(runtimes[0].started.length, 1, 'the runtime was asked for one turn');
});

test('a job that was delivered is not delivered again after a restart', async t => {
  const { start, create, project, runtimes } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(30), prompt: 'Once, and once only.' });
  await until(() => promptOf(daemon.events, 'Once, and once only.'), 'the job did not open a turn');
  await daemon.stop();

  const next = await start();
  await new Promise(resolve => setTimeout(resolve, 120));
  const after = await jobOf(next, job.id);
  assert.equal(after.status, 'delivered');
  assert.equal(after.attempts, 1);
  assert.equal(runtimes[0].started.length, 1, 'the runtime was asked for one turn, across both daemons');
});

test('a job whose file still says pending after its delivery is not delivered twice', async t => {
  const { start, create, project, directory, runtimes } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(30), prompt: 'Only once, even if the file lies.' });
  await untilStatus(daemon, job.id, 'delivered');
  runtimes[0].finish('done'); // the turn ends; the session is idle again

  // The daemon died between the receipt of the delivery and the job file that says so:
  // the file says pending again, the receipt says the message was delivered.
  const file = path.join(directory, 'schedules', `${job.id}.json`);
  const written = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...written, status: 'pending', deliveredAt: undefined, failedAt: undefined, cancelledAt: undefined }));

  await until(async () => (await jobOf(daemon, job.id)).status === 'delivered', 'the job did not settle again');
  const after = await jobOf(daemon, job.id);
  assert.equal(after.attempts, 2, 'the daemon tried again');
  assert.equal(runtimes[0].started.length, 1, 'the runtime was asked for one turn only');
});

test('a job file that is not a job is skipped, and the other jobs still run', async t => {
  const { start, create, project, directory } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const { job: good } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60), prompt: 'The good one.' });
  const { job: broken } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60), prompt: 'The broken one.' });
  // The second job's file is cut short: it is not a job any more.
  await writeFile(path.join(directory, 'schedules', `${broken.id}.json`), `{"version":1,"id":"${broken.id}","status":"pen`);

  await until(() => promptOf(daemon.events, 'The good one.'), 'the good job did not fire');
  const { jobs } = await daemon.request('schedule.list', { projectRoot: project });
  assert.deepEqual(jobs.map(entry => entry.id), [good.id], 'the broken job is not listed');
  assert.equal(promptOf(daemon.events, 'The broken one.'), undefined, 'the broken job did not fire');
});

test('a job whose session never answers fails with a reason, and cannot be cancelled while it is delivered', async t => {
  const { start, create, project, runtimes } = await setup(t);
  const daemon = await start({ scheduleDeliveryTimeoutMs: 150 });
  const { session } = await create(daemon);
  // The provider takes the prompt and is slow to answer it.
  runtimes[0].hold = new Promise(resolve => setTimeout(resolve, 400));
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(30), prompt: 'A slow answer.' });

  await until(() => runtimes[0].started.length === 1, 'the delivery did not start');
  // The job is being delivered: a cancel of it is refused, not silently lost.
  await assert.rejects(daemon.request('schedule.cancel', { id: job.id, projectRoot: project }), { code: 1004 });

  await untilStatus(daemon, job.id, 'failed');
  const after = await jobOf(daemon, job.id);
  assert.equal(after.lastError.code, 'delivery_timeout');
  assert.match(after.lastError.message, /execution outcome is unknown/);
  assert.match(after.lastError.message, /not cancelled/);
  // The timer does not cancel the request. A real late ACK must stay visible,
  // while the terminal job is never delivered again on subsequent ticks.
  await until(async () => (await jobOf(daemon, job.id)).lastError?.code === 'delivery_accepted_late', 'late ACK was not recorded');
  assert.equal((await jobOf(daemon, job.id)).status, 'failed');
  assert.equal(runtimes[0].started.length, 1);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(runtimes[0].started.length, 1);
});

test('a delivery timeout retains the runtime queue until the native start settles', async t => {
  const { start, create, project, runtimes, releases } = await setup(t);
  const daemon = await start({ scheduleDeliveryTimeoutMs: 30 });
  const { session } = await create(daemon);
  const { session: other } = await create(daemon);
  let admissionAnswered = false;
  const admit = daemon.runtime.withIdlePrompt.bind(daemon.runtime);
  daemon.runtime.withIdlePrompt = async (...args) => {
    const answer = await admit(...args);
    admissionAnswered = true;
    return answer;
  };
  let release;
  runtimes[0].hold = new Promise(resolve => { release = resolve; });
  releases.push(release);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(-1), prompt: 'Keep native start ownership.' });
  await until(() => runtimes[0].started.length === 1);
  await untilStatus(daemon, job.id, 'failed');
  assert.equal((await jobOf(daemon, job.id)).lastError.code, 'delivery_timeout');
  await until(() => admissionAnswered, 'the admission caller to receive its timeout result');
  let secondAdmitted = false;
  const queued = admit(other.id, async send => {
    secondAdmitted = true;
    await send({ clientMessageId: 'after-timeout', delivery: 'auto', content: [] });
  });
  // Drain a separate event-loop turn: an incorrectly released queue can run its
  // queued prompt, while a retained queue still waits for the explicit gate.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondAdmitted, false, 'no later operation enters the global queue before the native start settles');
  assert.equal(runtimes[1].started.length, 0, 'the timed-out native start still owns the global queue');
  release();
  await queued;
  await until(async () => (await jobOf(daemon, job.id)).lastError?.code === 'delivery_accepted_late');
  assert.equal(runtimes[0].started.length, 1);
  assert.equal(runtimes[1].started.length, 1);
  assert.equal((await jobOf(daemon, job.id)).attempts, 1);
});

test('a job that is cancelled before its time never runs', async t => {
  const { start, create, project, runtimes } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(150), prompt: 'Cancelled.' });

  const { job: cancelled } = await daemon.request('schedule.cancel', { id: job.id, projectRoot: project });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.cancelledAt, 'the cancellation is timed');
  await new Promise(resolve => setTimeout(resolve, 250));
  const after = await jobOf(daemon, job.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(promptOf(daemon.events, 'Cancelled.'), undefined, 'nothing was delivered');
  assert.equal(runtimes[0].started.length, 0, 'the runtime was asked for no turn');
  await assert.rejects(daemon.request('schedule.cancel', { id: job.id, projectRoot: project }), { code: 1004 });
});

test('a job waits for a session that is working, and never steers its turn', async t => {
  const { start, create, project, runtimes } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  // The user is talking to the session; the job must not cut into that turn.
  await daemon.request('session.prompt', { sessionId: session.id, clientMessageId: 'user-1', content: [{ type: 'text', text: 'Working now.' }] });
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(30), prompt: 'Queued behind the turn.' });

  await new Promise(resolve => setTimeout(resolve, 150));
  const waiting = await jobOf(daemon, job.id);
  assert.equal(waiting.status, 'pending', 'the job waits for the turn to end');
  assert.equal(waiting.lastError.code, 'session_busy');
  assert.equal(promptOf(daemon.events, 'Queued behind the turn.'), undefined, 'the running turn was not steered');
  assert.equal(waiting.attempts, 0, 'nothing was delivered yet');
  runtimes[0].finish();
  await untilStatus(daemon, job.id, 'delivered');
  assert.equal(runtimes[0].started.length, 2, 'the job gets a new turn after the busy turn completes');
});

test('a job needs a live root session of its project', async t => {
  const { start, create, project } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  await assert.rejects(daemon.request('schedule.create', { projectRoot: project, sessionId: 'ses_missing', dueAt: inMs(60), prompt: 'Nowhere.' }), { code: 1001 });
  await assert.rejects(daemon.request('schedule.create', { projectRoot: '/another/project', sessionId: session.id, dueAt: inMs(60), prompt: 'Elsewhere.' }), { code: -32602 });
  await assert.rejects(daemon.request('schedule.get', { id: 'sch_0000000000000000', projectRoot: project }), { code: 1001 });
  // A job of another project is not listed with this one's.
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60), prompt: 'Mine.' });
  const { jobs } = await daemon.request('schedule.list', { projectRoot: '/another/project' });
  assert.deepEqual(jobs, []);
  const { jobs: mine } = await daemon.request('schedule.list', { projectRoot: project });
  assert.deepEqual(mine.map(entry => entry.id), [job.id]);
});

test('an earlier attempt with a missing or expired receipt fails closed instead of sending again', async t => {
  const { start, create, project, directory, runtimes } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(60000), prompt: 'An uncertain previous attempt.' });
  const file = path.join(directory, 'schedules', `${job.id}.json`);
  const written = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...written, dueAt: inMs(-1000), attemptedAt: inMs(-500), lateByMs: 500, attempts: 1 }));
  await untilStatus(daemon, job.id, 'failed');
  const after = await jobOf(daemon, job.id);
  assert.equal(after.lastError.code, 'outcome_unknown');
  assert.equal(after.attempts, 2);
  assert.equal(runtimes[0].started.length, 0, 'receipt expiry cannot cause a duplicate provider turn');
});

test('the scheduled turn receives fresh provider availability and quota recheck instructions', async t => {
  const { start, create, project, runtimes } = await setup(t);
  const daemon = await start();
  const { session } = await create(daemon);
  let reads = 0;
  runtimes[0].orchestrationContext = async () => { reads++; return { runtime: 'codex', usage: { available: true, ordinaryUsageAllowed: false, limits: [{ windows: [{ usedPercent: 100 }] }] } }; };
  const { job } = await daemon.request('schedule.create', { projectRoot: project, sessionId: session.id, dueAt: inMs(30), prompt: 'Quota reset continuation.' });
  await untilStatus(daemon, job.id, 'delivered');
  assert.equal(reads, 1, 'availability is fetched at wake time');
  const input = runtimes[0].started[0].params.input.map(part => part.text ?? '').join('\n');
  assert.match(input, /"ordinaryUsageAllowed":false/);
  assert.match(input, /"usedPercent":100/);
  assert.match(input, /Before delegating[\s\S]*recheck actual provider availability/);
  assert.match(input, /scheduled time does not guarantee quota/);
  assert.equal(runtimes[0].calls.filter(call => call.method === 'thread/start').length, 1, 'no delegation is performed by the scheduler');
});

test('an overlapping tick cannot hide the active delivery from stop', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-schedule-stop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createScheduleStore(directory);
  const job = await store.create({ projectRoot: directory, sessionId: 'root', dueAt: inMs(-1000), prompt: 'Wait for ACK.' });
  let acknowledge, started = false;
  const delivery = new Promise(resolve => { acknowledge = resolve; });
  const scheduler = createScheduler({ store, runtime: { snapshot: () => ({ projectRoot: directory }) }, deliver: async () => { started = true; return delivery; } });
  const first = scheduler.tick();
  await until(() => started);
  const overlap = scheduler.tick();
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(stopped, false, 'stop must wait despite an overlapping interval tick');
  acknowledge({ outcome: 'accepted' });
  await Promise.all([first, overlap, stopping]);
  assert.equal((await store.get(job.id)).status, 'delivered');
});

test('a busy session beyond the grace window fails without sending a prompt', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-schedule-grace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = () => 10000;
  const store = createScheduleStore(directory, { now });
  const job = await store.create({ projectRoot: directory, sessionId: 'root', dueAt: new Date(9000).toISOString(), prompt: 'Too late.' });
  let sent = 0;
  const scheduler = createScheduler({ store, runtime: { snapshot: () => ({ projectRoot: directory, activeTurnId: 'busy' }) }, now, graceMs: 500, deliver: async () => { sent++; return { outcome: 'accepted' }; } });
  assert.equal((await scheduler.tick()).failed, 1);
  const after = await store.get(job.id);
  assert.equal(after.lastError.code, 'session_busy');
  assert.equal(after.status, 'failed');
  assert.equal(sent, 0);
});
