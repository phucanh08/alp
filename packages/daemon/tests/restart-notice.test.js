// What a restarted alpd says about the alpd before it, and what it reopens (t-11c7).
//
// The marker state/alpd.running is the only sign of a crash, and live.json the only sign of a
// running assignment. Three ways they said more than what happened:
//   (a) a start that failed after writing the marker left it, so the next start read a crash;
//   (b) a requested stop that outlasted alpd's exit timer left it too;
//   (c) a finished assignment whose removal from live.json never reached the disk was reopened.
// Each test sets the situation up for real (alpd processes on a scratch home, or two runtimes on
// one state directory) and also checks that a real crash is still reported and still reopens work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { createTask, getTask } from '@anhlp/alp-core/tasks';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { connect, daemonPaths, readLock } from '@anhlp/alp-client';
import { diagnose } from '@anhlp/alp-client/doctor';

import { fakeTransport, until as soon, workspace } from '../../../test/support/recovery.js';
import { teardown } from '../../../test/support/teardown.js';

const ALPD = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./support/fake-codex.js', import.meta.url));
const MODEL = 'codex:gpt-5.6-sol';
// The fake provider is a Node script run as an executable; (a) puts a plain file where a Unix socket goes.
const skip = process.platform === 'win32' && 'POSIX processes and sockets only';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(check, what) {
  for (let i = 0; i < 600; i++) { if (await check()) return; await sleep(25); }
  assert.fail(`${what} did not happen`);
}
const text = body => [{ type: 'text', text: body }];
const exists = file => stat(file).then(() => true, () => false);
/** What alp doctor says of alpd while none runs; no provider command is run for it. */
const doctorSays = async home => (await diagnose({ home, run: async () => ({ code: -1, stdout: '', stderr: 'not run by this test' }) })).find(check => check.id === 'alpd').summary;

/** A scratch home and project, and alpd processes started on them one after another. */
async function harness(t) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-restart-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), '{}');
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const journalFile = path.join(directory, 'provider.jsonl');
  const logFile = path.join(directory, 'alpd.log');
  const started = [];
  const journal = async () => (await readFile(journalFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  // After the removal above in setup order, so it runs before it: no process outlives the test.
  defer(async () => {
    for (const child of started) if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    for (const { pid } of await journal()) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  });

  function launch(env = {}) {
    const log = openSync(logFile, 'a');
    const child = spawn(process.execPath, [ALPD], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, ALP_HOME: home, ALP_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_JOURNAL: journalFile, ...env },
    });
    closeSync(log);
    started.push(child);
    return { child, exited: once(child, 'exit').then(([code, signal]) => ({ code, signal })) };
  }

  /** Starts alpd as a detached process group leader and waits until it is ready. */
  async function start({ env } = {}) {
    const { child, exited } = launch(env);
    let gone = false;
    void exited.then(() => { gone = true; });
    await until(async () => {
      if (gone) assert.fail(`alpd exited while starting:\n${await readFile(logFile, 'utf8')}`);
      const lock = await readLock(home);
      return lock?.ready && lock.pid === child.pid;
    }, 'alpd to be ready');
    const client = await connect((await readLock(home)).socket, { name: 'restart-test', version: '0' });
    return {
      pid: child.pid, client, exited,
      request: (method, params) => client.request(method, params),
      async kill() { process.kill(child.pid, 'SIGKILL'); await exited; client.close(); },
      async stop() { await client.request('daemon.shutdown').catch(() => {}); client.close(); return exited; },
    };
  }

  return {
    home, project, journal, logFile, start,
    marker: path.join(home, 'state', 'alpd.running'),
    log: () => readFile(logFile, 'utf8'),
    /** A start that cannot open its IPC endpoint: something that is not a socket is in its place. */
    async failedStart() {
      const { socket } = daemonPaths(home);
      await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
      // A killed alpd leaves its socket behind; a plain file takes its place.
      await rm(socket, { force: true });
      await writeFile(socket, 'not a socket', { mode: 0o600 });
      const result = await launch().exited;
      await rm(socket);
      return result;
    },
    create: daemon => daemon.request('session.create', { spec: { cwd: project, persist: true, model: MODEL } }),
    /** The recovery prompts the provider received, across every provider process. */
    async recoveryPrompts() { return (await journal()).filter(entry => entry.method === 'turn/start' && /during your turn/.test(entry.text ?? '')).map(entry => entry.text); },
    /** The notices kept in a root's timeline. */
    async notices(sessionId) {
      const lines = (await readFile(path.join(home, 'state', 'timeline', `${sessionId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      return lines.filter(envelope => envelope.event?.type === 'item' && envelope.event.item.kind === 'notice').map(envelope => envelope.event.item.text);
    },
  };
}

test('t-11c7 (a): a start that fails after writing its marker does not make the next alpd report a crash', { skip }, async t => {
  const defer = teardown(t);
  const h = await harness(t);
  const first = await h.start();
  const { session } = await h.create(first);
  assert.equal((await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('alfa [hold]') })).outcome, 'accepted');
  assert.deepEqual(await first.stop(), { code: 0, signal: null });
  assert.equal(await exists(h.marker), false, 'a clean stop removes the marker');

  assert.deepEqual(await h.failedStart(), { code: 1, signal: null });
  assert.match(await h.log(), /ALP_IPC_LISTEN_FAILED/);
  assert.equal(await exists(h.marker), false, 'a start that failed leaves no marker of its own');

  const third = await h.start();
  defer(() => third.stop());
  assert.deepEqual((await third.request('daemon.status')).previousExit, { kind: 'clean' });
  assert.doesNotMatch(await h.log(), /ALP_PREVIOUS_CRASH/);
  // Whether the root continues here is not this test's: the start that failed had begun settling the
  // session records before it failed to listen, so it may already have ended the root's turn. What
  // the root is told when it does continue follows previousExit alone; test (b) reads it from a real alpd.
  assert.doesNotMatch((await h.recoveryPrompts()).join('\n'), /stopped unexpectedly/);
});

test('t-11c7 (a): a failed start after a real crash keeps the crash and its time for the next alpd', { skip }, async t => {
  const defer = teardown(t);
  const h = await harness(t);
  const first = await h.start();
  const { session } = await h.create(first);
  assert.equal((await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('bravo [hold]') })).outcome, 'accepted');
  await first.kill();
  const crashedAt = (await stat(h.marker)).mtime;
  assert.match(await doctorSays(h.home), /the last alpd stopped unexpectedly, and the next start continues its work/);
  // Far enough from the crash that the two times cannot be mistaken for each other.
  await sleep(1200);

  const failedAt = Date.now();
  assert.deepEqual(await h.failedStart(), { code: 1, signal: null });
  assert.equal(await exists(h.marker), true, 'the crash is still on record');

  const third = await h.start();
  defer(() => third.stop());
  const { previousExit } = await third.request('daemon.status');
  assert.equal(previousExit.kind, 'crash');
  assert.equal(previousExit.at, crashedAt.toISOString(), 'the time of the crash, not of the start that failed');
  assert.ok(Date.parse(previousExit.at) < failedAt - 1000);
  // Said once more by the alpd that does start, with the time of the crash.
  const said = (await h.log()).split('\n').filter(line => line.includes('ALP_PREVIOUS_CRASH')).map(line => JSON.parse(line).at);
  assert.deepEqual(said, [crashedAt.toISOString(), crashedAt.toISOString()], 'the start that failed and the one after it name the same crash');
  // The root's own continuation after a crash is in crash-recovery.test.js (killed mid-turn); see (a) above for why not here.
});

test('t-11c7 (b): a requested stop that outlasts the exit timer is a restart to the next alpd, and what it left running is stopped', { skip }, async t => {
  const defer = teardown(t);
  const h = await harness(t);
  // The provider ignores its closed stdin, so closing its session takes alpd 1.5 s; the exit timer fires first.
  const first = await h.start({ env: { ALP_STOP_TIMEOUT_MS: '200', FAKE_CODEX_IGNORE_EOF: '1' } });
  const { session } = await h.create(first);
  assert.equal((await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('charlie [hold]') })).outcome, 'accepted');
  const [{ pid: provider }] = (await h.journal()).filter(entry => entry.method === 'turn/start');
  const stopped = Date.now();
  assert.deepEqual(await first.stop(), { code: 0, signal: null });
  assert.ok(Date.now() - stopped < 1400, 'the exit timer ended alpd before its sessions had closed');
  assert.doesNotMatch(await h.log(), /"event":"stopped"/, 'alpd did not reach the end of its stop');
  assert.ok(alive(provider), 'the provider outlived the alpd that was stopping it');
  const doctor = await doctorSays(h.home);
  assert.match(doctor, /the last alpd was stopped before it had finished stopping, and the next start continues its work/);
  assert.doesNotMatch(doctor, /unexpectedly/);

  const second = await h.start();
  defer(() => second.stop());
  assert.deepEqual((await second.request('daemon.status')).previousExit, { kind: 'clean' });
  // What the cut-short stop left running is ended before anything recovers, as after a crash.
  await until(() => !alive(provider), 'the leftover provider to stop');
  assert.match(await h.log(), new RegExp(`stopping processes the previous alpd \\(pid ${first.pid}\\) left running`));
  await until(async () => (await h.recoveryPrompts()).length === 1, 'the recovery prompt');
  assert.match((await h.recoveryPrompts())[0], /ALP: alpd restarted during your turn, and reopened this session\./);
  await until(async () => (await h.notices(session.id)).some(notice => /reopened/.test(notice)), 'the recovery notice');
  assert.deepEqual((await h.notices(session.id)).filter(notice => /reopened/.test(notice)), ['ALP: alpd restarted. 0 of 0 running assignments reopened, and this session.']);
  assert.doesNotMatch(await h.log(), /ALP_PREVIOUS_CRASH/);
});

test('t-11c7 (b): an ALP_STOP_TIMEOUT_MS that is not a number of milliseconds from 100 to 600000 is ignored: the stop runs to its end', { skip }, async t => {
  const defer = teardown(t);
  const h = await harness(t);
  for (const value of ['5', 'soon', '600001']) {
    const daemon = await h.start({ env: { ALP_STOP_TIMEOUT_MS: value, FAKE_CODEX_IGNORE_EOF: '1' } });
    const { session } = await h.create(daemon);
    assert.equal((await daemon.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('delta [hold]') })).outcome, 'accepted');
    const before = (await h.log()).length;
    // Closing the session takes 1.5 s; had "5" been taken, alpd would have exited long before.
    assert.deepEqual(await daemon.stop(), { code: 0, signal: null });
    const said = (await h.log()).slice(before);
    assert.match(said, /"event":"stopped"/, `ALP_STOP_TIMEOUT_MS=${value}: the stop reached its end`);
    assert.equal(await exists(h.marker), false, `ALP_STOP_TIMEOUT_MS=${value}: the marker went with a clean stop`);
    assert.ok((await h.log()).includes(`ignoring ALP_STOP_TIMEOUT_MS=${value}`), `ALP_STOP_TIMEOUT_MS=${value} is said to be ignored`);
  }
  const last = await h.start();
  defer(() => last.stop());
  assert.deepEqual((await last.request('daemon.status')).previousExit, { kind: 'clean' });
  assert.doesNotMatch(await h.log(), /ALP_PREVIOUS_STOP_CUT_SHORT|ALP_PREVIOUS_CRASH/);
});

/** Main delegates one task to a peer in a first runtime; returns what the test needs to end it either way. */
async function delegated(t) {
  const { directory, root, options } = await workspace(t);
  const runtimes = [];
  const first = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  await first.open('root', { cwd: root, persist: true });
  await first.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: text('Build it') });
  const main = runtimes[0];
  const task = await createTask(root, { title: 'Add notes' }, 'user');
  const { assignmentId: id, status } = await main.call('alp_delegate', { agent: 'peer', task: 'Write notes.txt', taskId: task.id, mode: 'workspace-write', isolation: 'worktree', wait: false });
  assert.equal(status, 'running');
  const peer = runtimes[1];
  await soon(() => peer.started.length === 1, 'the peer turn');
  const live = async () => JSON.parse(await readFile(options.liveFile, 'utf8').catch(() => '[]'));
  await soon(async () => (await live()).length === 1, 'the running assignment on disk');
  const runLog = async () => (await readFile(path.join(directory, 'runs', 'root.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, options, runtimes, first, main, peer, task, id, live, runLog };
}

/** The next alpd's runtime on the same state, with the root open again as alpd opens it. */
async function next(t, { options, runtimes, root }, snapshot) {
  const defer = teardown(t);
  const second = createAlpRuntime({ ...options, transport: fakeTransport(runtimes), previousExit: { kind: 'crash', at: '2026-10-29T11:52:22.440Z' } });
  defer(() => second.shutdown());
  const events = [];
  second.onEvent(envelope => events.push(envelope));
  const reopen = () => second.open('root', { cwd: root, persist: true, restore: { agent: 'main', threadId: snapshot.threadId, runtime: snapshot.runtime, model: snapshot.model, workflow: snapshot.workflow } });
  const notices = () => events.filter(envelope => envelope.event.type === 'item' && envelope.event.item.kind === 'notice').map(envelope => envelope.event.item.text);
  return { second, reopen, notices };
}

test('t-11c7 (c): a finished assignment that live.json still lists is not reopened, and its task stays where its handoff put it', async t => {
  const work = await delegated(t);
  const { options, runtimes, first, main, peer, task, id, live, runLog } = work;
  // What the disk holds while the assignment runs.
  const running = await readFile(options.liveFile, 'utf8');
  await peer.call('alp_handoff', { outcome: 'complete', summary: 'Wrote notes.txt' });
  await writeFile(path.join(peer.cwd, 'notes.txt'), 'done\n');
  peer.finish('Done');
  assert.equal((await main.call('alp_wait', { assignments: [id] })).events[0].result.status, 'completed');
  assert.equal((await getTask(work.root, task.id)).status, 'review');
  await soon(async () => (await live()).length === 0, 'the live file to empty');
  main.finish('ok');
  const snapshot = first.snapshot('root');
  await first.shutdown();
  assert.ok((await runLog()).some(entry => entry.event === 'assignment.finished' && entry.assignmentId === id && entry.status === 'completed'));
  // The removal never reached the disk: the write failed (a full disk), or alpd died before it landed.
  await writeFile(options.liveFile, running);

  const { second, reopen, notices } = await next(t, work, snapshot);
  assert.deepEqual(second.recoverable().map(entry => entry.assignmentId), [], 'finished work is not offered for recovery');
  await reopen();
  const before = runtimes.length;
  assert.deepEqual(await second.recover('root'), []);
  await soon(async () => (await live()).length === 0, 'the stale entry to leave the live file');
  assert.equal(runtimes.length, before, 'no session was opened for the finished assignment');
  assert.equal(second.snapshot(id), undefined);
  assert.deepEqual(notices(), [], 'nothing was reopened, so nothing is announced');
  const settled = await getTask(work.root, task.id);
  assert.equal(settled.status, 'review');
  assert.equal(settled.log.at(-1).event, 'submitted');
  assert.ok((await runLog()).some(entry => entry.event === 'assignment.stale' && entry.assignmentId === id), 'the run log says why it was left alone');
});

test('t-11c7 (c): an assignment that was still running when alpd crashed is reopened and announced', async t => {
  const work = await delegated(t);
  const { runtimes, first, peer, task, id, live } = work;
  const snapshot = first.snapshot('root');
  // Ending the first runtime keeps the running assignment in the live file, as a crash leaves it there.
  await first.shutdown();

  const { second, reopen, notices } = await next(t, work, snapshot);
  assert.deepEqual(second.recoverable().map(entry => entry.assignmentId), [id]);
  await reopen();
  assert.deepEqual(await second.recover('root', { continueRoot: true }), [{ assignmentId: id, agent: 'peer', outcome: 'resumed' }]);
  const peerAgain = runtimes.at(-1);
  assert.equal(peerAgain.calls[0].params.threadId, peer.threadId);
  await soon(() => peerAgain.started.length === 1, 'the peer to continue');
  assert.match(peerAgain.lastText(), /^ALP: alpd stopped unexpectedly while you worked on this assignment, and reopened this session\./);
  assert.deepEqual(notices(), ['ALP: alpd stopped unexpectedly (around 2026-10-29T11:52:22.440Z). 1 of 1 running assignments reopened, and this session.']);
  assert.equal((await getTask(work.root, task.id)).assignee.assignment, id);
  assert.equal((await live()).length, 1);
});
