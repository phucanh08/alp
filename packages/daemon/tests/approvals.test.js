// Approvals waiting for the user survive an alpd restart and expire as 'expired' (t-43ed).
//
// alp_skill, alp_skill_retire, alp_lesson_curate and alp_issue return a pending approvalId at once;
// the decision reaches the agent as result mail. Before t-43ed an alpd restart lost the approval,
// and one nobody answered in 30 minutes came back as 'unanswered', which read like a refusal.
// Now approvalFile keeps each approval until it is decided, expires or is canceled; the next alpd
// reopens its root, asks again under the same approvalId with a new window from then, and an
// expiry tells the agent 'expired' and the user a notice. A root whose approval waits is not
// reaped while nobody watches it, and becomes reapable again once the approval is settled.
//
// The runtime tests run two runtimes one after the other on one state directory, as two alpd
// processes would; the daemon tests run the alpd server and store in process, with the restore
// after listen that main.ts uses (restoreOnListen). No real provider runs: the transport is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { connect, daemonPaths, readLock } from '@anhlp/alp-client';
import { initProject } from '@anhlp/alp-core/init';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { fakeTransport, until, workspace } from '../../../test/support/recovery.ts';
import { teardown } from '../../../test/support/teardown.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = body => [{ type: 'text', text: body }];
// alp_issue needs no supervisor (alp_skill and alp_lesson_curate do), and its GitHub is injected:
// a comment on ALP's own repository asks nothing of GitHub before the user approves it.
const BODY = 'Evidence for the approval restart';
const draft = { action: 'comment', target: 'alp', issue: 114, body: BODY };

/** A project, an approval file beside live.json, a fake GitHub that records what is posted, and the runtime options for them. */
async function setup(t) {
  const { directory, root, options } = await workspace(t);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const approvalFile = path.join(directory, 'state', 'approvals.json');
  const held = async () => JSON.parse(await readFile(approvalFile, 'utf8').catch(() => '[]'));
  const posted = [];
  const github = async (args, { input } = {}) => { posted.push({ args, input }); return 'https://github.com/phucanh08/alp/issues/114#issuecomment-1\n'; };
  return { directory, root, options: { ...options, approvalFile, github }, approvalFile, held, posted };
}

/** A runtime on the shared state, its events, and main's root opened as alpd opens it (fresh, or restored from `snapshot`). */
async function runtimeOn(t, base, runtimes, extra = {}) {
  const defer = teardown(t);
  const runtime = createAlpRuntime({ ...base.options, transport: fakeTransport(runtimes), ...extra });
  defer(() => runtime.shutdown());
  const events = [];
  runtime.onEvent(envelope => events.push(envelope));
  const notices = () => events.filter(envelope => envelope.event.type === 'item' && envelope.event.item.kind === 'notice').map(envelope => envelope.event.item.text);
  return { runtime, events, notices };
}

const restoreOf = snapshot => ({ agent: 'main', threadId: snapshot.threadId, runtime: snapshot.runtime, model: snapshot.model, workflow: snapshot.workflow });
/** The result mail a main's wake turn carried, by its approvalId. */
const resultMail = (main, id) => main.started.map(call => call.params.input.at(-1).text).find(input => input.includes('Issue approval result') && (!id || input.includes(id)));
const resultOf = input => JSON.parse(/Issue approval result: (\{.*\})/.exec(input)[1].replace(/\\"/g, '"'));

test('t-43ed (1, 2): a pending approval survives a restart under the same approvalId, with a new window, and is still approvable', async t => {
  const base = await setup(t);
  const runtimes = [];
  const window = 1500;
  const first = await runtimeOn(t, base, runtimes, { userAskTimeoutMs: window });
  await first.runtime.open('root', { cwd: base.root, persist: true });
  await first.runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: text('Tidy the lessons') });
  const main = runtimes[0];
  const pending = await main.call('alp_issue', draft);
  assert.equal(pending.status, 'pending_approval', JSON.stringify(pending));
  const id = pending.approvalId;
  const [asked] = first.runtime.questions();
  assert.equal(asked.id, id);
  // On disk with what the next alpd needs to ask again.
  const [stored] = await base.held();
  assert.deepEqual([stored.approvalId, stored.sessionId, stored.rootId, stored.tool, stored.args], [id, 'root', 'root', 'alp_issue', draft]);
  main.finish('Asked the user');
  const snapshot = first.runtime.snapshot('root');
  await sleep(window * 0.6);
  await first.runtime.shutdown();
  // Stopping alpd cancels nothing it keeps: the approval is still on disk, and main got no result.
  assert.deepEqual((await base.held()).map(entry => entry.approvalId), [id]);
  assert.equal(resultMail(main), undefined);
  const firstDeadline = Date.parse(asked.askedAt) + window;

  const before = runtimes.length;
  const second = await runtimeOn(t, base, runtimes, { userAskTimeoutMs: window, previousExit: { kind: 'clean' } });
  assert.deepEqual(second.runtime.pendingApprovalRoots(), ['root'], 'alpd reopens the root for it');
  await second.runtime.open('root', { cwd: base.root, persist: true, restore: restoreOf(snapshot) });
  const restoredAt = Date.now();
  assert.deepEqual(await second.runtime.recover('root'), []);
  const [again] = second.runtime.questions();
  assert.equal(again.id, id, 'the same approvalId');
  assert.match(again.body, new RegExp(BODY));
  assert.ok(Date.parse(again.askedAt) >= restoredAt - 5, 'asked again from the restore time');
  const mainAgain = runtimes[before];
  assert.equal(mainAgain.started.length, 0, 'a root reopened for its approval gets no recovery prompt');
  assert.deepEqual(second.notices(), [], 'and no recovery notice');

  // (2) The first window has passed; the new one, from the restore, has not.
  await sleep(Math.max(0, firstDeadline - Date.now()) + 200);
  assert.deepEqual(second.runtime.questions().map(question => question.id), [id], 'still pending after the first deadline');

  // (1) The user approves it under the same id; it is posted once and main hears of it.
  second.runtime.answer(id, { text: 'Approve' });
  await until(() => resultMail(mainAgain), 'the result mail');
  const result = resultOf(resultMail(mainAgain));
  assert.deepEqual([result.approvalId, result.approved, result.posted], [id, true, true]);
  assert.equal(base.posted.length, 1);
  assert.match(base.posted[0].input, new RegExp(BODY));
  assert.deepEqual(await base.held(), [], 'a decided approval leaves the file');
  assert.deepEqual(second.runtime.pendingApprovalRoots(), []);
});

test('t-43ed (2): the restored approval expires at the end of its new window, not the first one', async t => {
  const base = await setup(t);
  const runtimes = [];
  const window = 1200;
  const first = await runtimeOn(t, base, runtimes, { userAskTimeoutMs: window });
  await first.runtime.open('root', { cwd: base.root, persist: true });
  await first.runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: text('Tidy') });
  const { approvalId: id } = await runtimes[0].call('alp_issue', draft);
  runtimes[0].finish('asked');
  const snapshot = first.runtime.snapshot('root');
  await sleep(window * 0.75);
  await first.runtime.shutdown();

  const second = await runtimeOn(t, base, runtimes, { userAskTimeoutMs: window });
  await second.runtime.open('root', { cwd: base.root, persist: true, restore: restoreOf(snapshot) });
  const restoredAt = Date.now();
  await second.runtime.recover('root');
  let expiredAt;
  second.runtime.onEvent(({ event }) => { if (event.type === 'question.resolved' && event.questionId === id) expiredAt = Date.now(); });
  await until(async () => { await sleep(20); return expiredAt; }, 'the restored approval to expire');
  const resolved = second.events.find(({ event }) => event.type === 'question.resolved' && event.questionId === id).event;
  assert.equal(resolved.outcome, 'timeout');
  assert.ok(expiredAt - restoredAt >= window - 50, `expired ${expiredAt - restoredAt} ms after the restore; the window is ${window} ms`);
  assert.ok(expiredAt - restoredAt < window + 1000);
});

test('t-43ed (3): an approval nobody answers expires: the agent hears \'expired\', not a rejection, and the user gets a notice', async t => {
  const base = await setup(t);
  const runtimes = [];
  const { runtime, notices } = await runtimeOn(t, base, runtimes, { userAskTimeoutMs: 300, language: 'en' });
  await runtime.open('root', { cwd: base.root, persist: true });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: text('Tidy') });
  const main = runtimes[0];
  const { approvalId: id } = await main.call('alp_issue', draft);
  main.finish('asked');
  await until(async () => { await sleep(20); return resultMail(main); }, 'the expiry result');
  const result = resultOf(resultMail(main));
  assert.equal(result.outcome, 'expired');
  assert.equal(result.approved, false);
  assert.equal(result.posted, false);
  assert.match(result.feedback, /expired; the user did not reject it/);
  assert.deepEqual(notices(), [`The approval ${id} that main asked for expired: nobody answered within 1 minutes. Nothing was applied, and main was told it expired (it was not rejected).`]);
  assert.deepEqual(base.posted, [], 'nothing was posted');
  assert.deepEqual(await base.held(), [], 'an expired approval leaves the file');
});

test('t-43ed (3): the expiry notice is in the user\'s language', async t => {
  const base = await setup(t);
  const runtimes = [];
  const { runtime, notices } = await runtimeOn(t, base, runtimes, { userAskTimeoutMs: 200, language: 'vi' });
  await runtime.open('root', { cwd: base.root, persist: true });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: text('Tidy') });
  const { approvalId: id } = await runtimes[0].call('alp_issue', draft);
  runtimes[0].finish('asked');
  await until(async () => { await sleep(20); return notices().length; }, 'the notice');
  assert.deepEqual(notices(), [`Yêu cầu duyệt ${id} của main đã hết hạn: không có câu trả lời trong 1 phút. Không có gì được áp dụng, và main đã được báo là yêu cầu hết hạn (không phải bị từ chối).`]);
});

test('t-43ed (4): approve and reject without a restart or an expiry are as before, and leave the file', async t => {
  const base = await setup(t);
  const runtimes = [];
  const { runtime, notices } = await runtimeOn(t, base, runtimes);
  await runtime.open('root', { cwd: base.root, persist: true });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: text('Tidy') });
  const main = runtimes[0];

  // Reject: outcome 'answered' with the answer as feedback, nothing posted.
  const rejected = await main.call('alp_issue', draft);
  assert.equal((await base.held()).length, 1);
  main.finish('asked');
  runtime.answer(rejected.approvalId, { text: 'Reject' });
  await until(() => resultMail(main, rejected.approvalId), 'the rejection result');
  assert.deepEqual(resultOf(resultMail(main, rejected.approvalId)), { status: 'resolved', approvalId: rejected.approvalId, repo: 'phucanh08/alp', approved: false, posted: false, outcome: 'answered', feedback: 'Reject' });
  assert.deepEqual(base.posted, []);
  assert.deepEqual(await base.held(), []);

  // Approve: posted at once.
  const approved = await main.call('alp_issue', { ...draft, requestId: 'second' });
  main.finish('asked again');
  runtime.answer(approved.approvalId, { text: 'Approve' });
  await until(() => resultMail(main, approved.approvalId), 'the approval result');
  const result = resultOf(resultMail(main, approved.approvalId));
  assert.deepEqual([result.approvalId, result.approved, result.posted, result.url], [approved.approvalId, true, true, 'https://github.com/phucanh08/alp/issues/114#issuecomment-1']);
  assert.equal(base.posted.length, 1);
  assert.deepEqual(await base.held(), []);
  assert.deepEqual(notices(), []);
});

test('t-43ed: an approval canceled with its session is not asked again by the next alpd', async t => {
  const base = await setup(t);
  const runtimes = [];
  const first = await runtimeOn(t, base, runtimes);
  await first.runtime.open('root', { cwd: base.root, persist: true });
  await first.runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: text('Tidy') });
  await runtimes[0].call('alp_issue', draft);
  runtimes[0].finish('asked');
  assert.equal((await base.held()).length, 1);
  await first.runtime.close('root');
  assert.deepEqual(await base.held(), [], 'closing the session cancels it, and it leaves the file');
  await first.runtime.shutdown();
  const second = await runtimeOn(t, base, runtimes);
  assert.deepEqual(second.runtime.pendingApprovalRoots(), []);
});

test('t-43ed: a write of the approval file that fails is told to the disk guard and logged; the approval goes on in memory', async t => {
  const base = await setup(t);
  // The file's directory is a file: every write fails.
  await mkdir(path.dirname(path.dirname(base.approvalFile)), { recursive: true });
  await writeFile(path.dirname(base.approvalFile), 'not a directory');
  const failures = [];
  const runtimes = [];
  const { runtime } = await runtimeOn(t, base, runtimes, { onWriteError: error => failures.push(error), liveFile: undefined });
  const logged = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) { logged.push(String(chunk)); return write.call(this, chunk, ...rest); };
  try {
    await runtime.open('root', { cwd: base.root, persist: true });
    await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: text('Tidy') });
    const pending = await runtimes[0].call('alp_issue', draft);
    assert.equal(pending.status, 'pending_approval');
  } finally {
    process.stderr.write = write;
  }
  assert.ok(failures.length >= 1, 'the disk guard heard of the failed write');
  assert.ok(logged.some(line => /ALP_PERSISTENCE_WRITE_FAILED/.test(line) && /pending approvals/.test(line)), `logged with its code: ${logged.join('')}`);
  assert.equal(runtime.questions().length, 1, 'the approval still waits for the user');
});

/** alpd in process on one state directory: the server restores after listen, as main.ts starts it. */
async function daemonOn(t, base, runtimes, extra = {}) {
  const defer = teardown(t);
  const runtime = createAlpRuntime({ ...base.options, transport: fakeTransport(runtimes), ...extra });
  const store = createStore(path.join(base.directory, 'state'));
  const socketPath = daemonPaths(path.join(base.directory, `d${runtimes.length}-${Date.now()}`)).socket;
  const server = createDaemonServer({ runtime, socketPath, version: 'test', store, runLogDir: base.options.runLogDir, restoreOnListen: true });
  await server.listen();
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await server.close(); await runtime.shutdown(); await store.flush(); };
  defer(stop);
  return { runtime, socketPath, store, stop };
}

test('t-43ed (1, 5): through alpd, a pending approval keeps its unwatched root open, survives a restart, and the root is reapable once it is decided', async t => {
  const defer = teardown(t);
  const base = await setup(t);
  const runtimes = [];
  const first = await daemonOn(t, base, runtimes);
  const client = await connect(first.socketPath);
  defer(() => client.close());
  const { session } = await client.request('session.create', { spec: { cwd: base.root, persist: true } });
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Tidy the lessons') });
  await until(() => runtimes[0]?.started.length === 1, 'main\'s turn');
  const { approvalId: id } = await runtimes[0].call('alp_issue', draft);
  runtimes[0].finish('Asked the user');
  await until(() => first.runtime.snapshot(session.id)?.busy === false, 'main to be idle');

  // (5) The client goes away: an idle root is reaped, but not while its approval waits.
  client.close();
  await sleep(300);
  assert.ok(first.runtime.snapshot(session.id), 'the root stays open');
  assert.deepEqual(first.runtime.questions().map(question => question.id), [id], 'and its approval was not canceled');
  await first.stop();
  assert.deepEqual((await base.held()).map(entry => entry.approvalId), [id]);

  // (1) The next alpd reopens the root for its approval, with no recovery prompt.
  const before = runtimes.length;
  const second = await daemonOn(t, base, runtimes);
  await until(() => second.runtime.questions().some(question => question.id === id), 'the approval to be asked again');
  const mainAgain = runtimes[before];
  assert.equal(mainAgain.started.length, 0, 'no recovery prompt for a root reopened only for its approval');
  const viewer = await connect(second.socketPath);
  defer(() => viewer.close());
  const { questions } = await viewer.request('question.list', {});
  assert.deepEqual(questions.map(question => [question.id, question.sessionId]), [[id, session.id]]);
  const timeline = (await readFile(path.join(base.directory, 'state', 'timeline', `${session.id}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(!timeline.some(({ event }) => event.type === 'item' && event.item.kind === 'notice' && /reopened|restarted/.test(event.item.text)), 'nothing announces it as interrupted work');
  await sleep(200);
  assert.ok(second.runtime.snapshot(session.id), 'nobody watches it, and it stays open while its approval waits');

  // The user approves through alpd; main hears of it, and once its turn ends the root is reaped again.
  assert.deepEqual(await viewer.request('question.answer', { questionId: id, text: 'Approve' }), { questionId: id });
  await until(() => resultMail(mainAgain), 'the result mail');
  assert.deepEqual([resultOf(resultMail(mainAgain)).approved, resultOf(resultMail(mainAgain)).posted], [true, true]);
  assert.equal(base.posted.length, 1);
  assert.deepEqual(second.runtime.pendingApprovalRoots(), []);
  mainAgain.finish('Reported');
  await until(async () => { await sleep(20); return !second.runtime.snapshot(session.id); }, 'the unwatched root to be reaped');
  assert.deepEqual(await base.held(), []);
});

test('t-43ed (3, 5): an unwatched root is reapable again once its approval expires', async t => {
  const defer = teardown(t);
  const base = await setup(t);
  const runtimes = [];
  const daemon = await daemonOn(t, base, runtimes, { userAskTimeoutMs: 600 });
  const client = await connect(daemon.socketPath);
  defer(() => client.close());
  const { session } = await client.request('session.create', { spec: { cwd: base.root, persist: true } });
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Tidy') });
  await until(() => runtimes[0]?.started.length === 1, 'main\'s turn');
  await runtimes[0].call('alp_issue', draft);
  runtimes[0].finish('asked');
  client.close();
  await sleep(200);
  assert.ok(daemon.runtime.snapshot(session.id), 'kept open while the approval waits');
  await until(async () => { await sleep(20); return resultMail(runtimes[0]); }, 'the expiry result');
  assert.equal(resultOf(resultMail(runtimes[0])).outcome, 'expired');
  runtimes[0].finish('noted');
  await until(async () => { await sleep(20); return !daemon.runtime.snapshot(session.id); }, 'the root to be reaped');
});


/** The mail a wake turn carried with an approval's outcome, by its approvalId, as `Approval result: {...}`. */
const approvalMail = (main, id) => main.started.map(call => call.params.input.at(-1).text).find(input => input.includes('Approval result: ') && input.includes(id));
/** What runtime code wrote to stderr while `body` ran: the log lines with their codes. */
async function logged(body) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) { lines.push(String(chunk)); return write.call(this, chunk, ...rest); };
  try { await body(); } finally { process.stderr.write = write; }
  return lines.join('');
}
const runLogOf = async (base, root) => (await readFile(path.join(base.options.runLogDir, `${root}.jsonl`), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));

/** One approval kept by a first runtime that then stopped, as an alpd that stopped with it pending. */
async function keptApproval(t, base, runtimes, extra = {}) {
  const first = await runtimeOn(t, base, runtimes, extra);
  await first.runtime.open('root', { cwd: base.root, persist: true });
  await first.runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: text('Tidy') });
  const { approvalId } = await runtimes[0].call('alp_issue', draft);
  runtimes[0].finish('asked');
  const snapshot = first.runtime.snapshot('root');
  await first.runtime.shutdown();
  return { id: approvalId, snapshot };
}

test('t-43ed (9): an approval whose root is abandoned is dropped, with its log code and run-log event, and not kept for the next start', async t => {
  const base = await setup(t);
  const runtimes = [];
  const { id } = await keptApproval(t, base, runtimes);
  const second = await runtimeOn(t, base, runtimes);
  assert.deepEqual(second.runtime.pendingApprovalRoots(), ['root']);
  const output = await logged(() => second.runtime.abandon('root', 'its root session cannot be reopened'));
  assert.match(output, /ALP_APPROVAL_DROPPED/);
  assert.match(output, new RegExp(id));
  assert.deepEqual(await base.held(), [], 'it leaves the file');
  assert.deepEqual(second.runtime.pendingApprovalRoots(), []);
  // The run log is written in the background: wait for the line rather than read it once.
  let dropped;
  await until(async () => { [dropped] = (await runLogOf(base, 'root')).filter(entry => entry.event === 'approval.dropped'); return dropped; }, 'the approval.dropped run-log line');
  assert.deepEqual([dropped.approvalId, dropped.outcome, dropped.reason, dropped.tool], [id, 'not_restored', 'its root session cannot be reopened', 'alp_issue']);
  assert.deepEqual(second.notices(), [], 'its root is not open: no notice, the log is the record');
  await second.runtime.shutdown();
  const third = await runtimeOn(t, base, runtimes);
  assert.deepEqual(third.runtime.pendingApprovalRoots(), [], 'the next alpd does not try it again');
});

test('t-43ed (9): through alpd, an approval whose root record is gone is dropped at the restore', async t => {
  const defer = teardown(t);
  const base = await setup(t);
  const runtimes = [];
  const first = await daemonOn(t, base, runtimes);
  const client = await connect(first.socketPath);
  defer(() => client.close());
  const { session } = await client.request('session.create', { spec: { cwd: base.root, persist: true } });
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Tidy') });
  await until(() => runtimes[0]?.started.length === 1, 'main\'s turn');
  const { approvalId: id } = await runtimes[0].call('alp_issue', draft);
  runtimes[0].finish('asked');
  client.close();
  await first.stop();
  // The root cannot be reopened: its record is gone.
  const sessionsDir = path.join(base.directory, 'state', 'sessions');
  for (const name of await readdir(sessionsDir)) if (name.startsWith(session.id)) await rm(path.join(sessionsDir, name));
  const output = await logged(async () => {
    const second = await daemonOn(t, base, runtimes);
    await until(async () => { await sleep(20); return (await base.held()).length === 0; }, 'the approval to be dropped');
    assert.deepEqual(second.runtime.pendingApprovalRoots(), []);
    assert.deepEqual(second.runtime.questions(), []);
  });
  assert.match(output, /ALP_APPROVAL_DROPPED/);
  await until(async () => (await runLogOf(base, session.id)).some(entry => entry.event === 'approval.dropped' && entry.approvalId === id), 'the approval.dropped run-log line');
});

test('t-43ed (9): an approval not asked again within its restore window is dropped, and the window is kept across starts', async t => {
  const base = await setup(t);
  const runtimes = [];
  const window = 800;
  const { id, snapshot } = await keptApproval(t, base, runtimes, { userAskTimeoutMs: window });
  // The first alpd that inherits it sets its restore deadline and keeps it on disk.
  const startedAt = Date.now();
  const second = await runtimeOn(t, base, runtimes, { userAskTimeoutMs: window });
  const [kept] = await base.held();
  const restoreBy = Date.parse(kept.restoreBy);
  assert.ok(restoreBy >= startedAt + window - 5 && restoreBy <= Date.now() + window, `restoreBy ${kept.restoreBy}`);
  await second.runtime.shutdown();
  // A later start keeps that deadline: restarting does not renew it.
  const third = await runtimeOn(t, base, runtimes, { userAskTimeoutMs: window, language: 'en' });
  assert.equal((await base.held())[0].restoreBy, kept.restoreBy);
  // Its root is open, but nothing asked it again (recover() never ran): at the deadline it is
  // dropped, the user sees a notice and main the outcome 'not_restored'.
  await third.runtime.open('root', { cwd: base.root, persist: true, restore: restoreOf(snapshot) });
  const main = runtimes.at(-1);
  const output = await logged(() => until(async () => { await sleep(20); return approvalMail(main, id); }, 'the dropped approval\'s result'));
  assert.ok(Date.now() >= restoreBy - 5, 'not before its deadline');
  assert.match(output, /ALP_APPROVAL_DROPPED/);
  const result = JSON.parse(/Approval result: (\{.*\})/.exec(approvalMail(main, id))[1].replace(/\\"/g, '"'));
  assert.deepEqual([result.approvalId, result.approved, result.outcome], [id, false, 'not_restored']);
  assert.match(result.next, /Nothing was posted, saved or changed/);
  assert.match(result.next, /submit it again/);
  assert.deepEqual(third.notices(), [`The approval ${id}, kept from before alpd restarted, was dropped: it was not asked again within its restore window. Nothing was applied; the agent can submit it again.`]);
  assert.deepEqual(await base.held(), []);
  assert.deepEqual(base.posted, []);
  await third.runtime.shutdown();

  // One whose deadline passed while no alpd ran is dropped as the next one starts.
  const runtimes2 = [];
  const { id: late } = await keptApproval(t, base, runtimes2, { userAskTimeoutMs: window });
  const stored = await base.held();
  stored[0].restoreBy = new Date(Date.now() - 1000).toISOString();
  await writeFile(base.approvalFile, JSON.stringify(stored));
  const atLoad = await logged(async () => {
    const fourth = await runtimeOn(t, base, runtimes2, { userAskTimeoutMs: window });
    assert.deepEqual(fourth.runtime.pendingApprovalRoots(), []);
  });
  assert.match(atLoad, /ALP_APPROVAL_DROPPED/);
  assert.match(atLoad, new RegExp(late));
  assert.deepEqual(await base.held(), []);
});

const ALPD = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./support/fake-codex.js', import.meta.url));
/** A real alpd and provider are slower than in process: up to 15 s. */
async function waitLong(check, what) {
  for (let i = 0; i < 600; i++) { if (await check()) return; await sleep(25); }
  assert.fail(`${what} did not happen`);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

test('t-43ed (8): a real alpd stopped with SIGTERM while an approval waits: the next alpd on the same home asks the same approvalId again, answerably, with no recovery prompt', { skip: process.platform === 'win32' && 'POSIX processes and sockets only' }, async t => {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-approvals-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), '{}');
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const journalFile = path.join(directory, 'provider.jsonl');
  const logFile = path.join(directory, 'alpd.log');
  const journal = async () => (await readFile(journalFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const started = [];
  // Registered after the removal, so it runs before it: no alpd or provider outlives the test.
  defer(async () => {
    for (const child of started) if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    for (const { pid } of await journal()) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  });
  const approvalFile = path.join(home, 'state', 'approvals.json');
  const held = async () => JSON.parse(await readFile(approvalFile, 'utf8').catch(() => '[]'));

  async function start() {
    const log = openSync(logFile, 'a');
    // gh is never found: nothing reaches GitHub, whatever the user answers.
    const child = spawn(process.execPath, [ALPD], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ALP_HOME: home, ALP_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_JOURNAL: journalFile, ALP_GH_BIN: path.join(directory, 'no-gh') } });
    closeSync(log);
    started.push(child);
    const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
    let gone = false;
    void exited.then(() => { gone = true; });
    await waitLong(async () => {
      if (gone) assert.fail(`alpd exited while starting:\n${await readFile(logFile, 'utf8')}`);
      const lock = await readLock(home);
      return lock?.ready && lock.pid === child.pid;
    }, 'alpd to be ready');
    const client = await connect((await readLock(home)).socket, { name: 'approvals-test', version: '0' });
    return { child, client, exited, request: (method, params) => client.request(method, params) };
  }

  const first = await start();
  defer(() => first.client.close());
  const { session } = await first.request('session.create', { spec: { cwd: project, persist: true, model: 'codex:gpt-5.6-sol' } });
  assert.equal((await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Propose it [issue]') })).outcome, 'accepted');
  await waitLong(async () => (await journal()).some(entry => entry.method === 'tool/answered'), 'alpd to answer the alp_issue call');
  const answered = (await journal()).find(entry => entry.method === 'tool/answered');
  const id = JSON.parse(JSON.parse(answered.text).contentItems[0].text).approvalId;
  assert.match(id, /^q-/, answered.text);
  assert.deepEqual((await first.request('question.list', {})).questions.map(question => question.id), [id]);
  assert.deepEqual((await held()).map(entry => entry.approvalId), [id]);

  // SIGTERM: alpd stops as it does on a requested stop, and keeps the approval.
  first.client.close();
  process.kill(first.child.pid, 'SIGTERM');
  assert.deepEqual(await first.exited, { code: 0, signal: null });
  assert.deepEqual((await held()).map(entry => entry.approvalId), [id], 'kept on disk across the stop');
  const turnsBefore = (await journal()).filter(entry => entry.method === 'turn/start').length;

  const second = await start();
  defer(() => second.client.close());
  await waitLong(async () => (await second.request('question.list', {})).questions.some(question => question.id === id), 'the same approval to wait again');
  const [question] = (await second.request('question.list', {})).questions;
  assert.deepEqual([question.id, question.sessionId], [id, session.id]);
  assert.match(question.body, /Fake issue/);
  await sleep(300);
  const after = (await journal()).filter(entry => entry.method === 'turn/start').slice(turnsBefore);
  assert.deepEqual(after, [], 'the reopened root got no recovery prompt (no turn/start after the restart)');

  // The user rejects it through the new alpd: nothing is posted, and it leaves the file.
  assert.deepEqual(await second.request('question.answer', { questionId: id, text: 'Reject' }), { questionId: id });
  await waitLong(async () => (await held()).length === 0, 'the decided approval to leave the file');
  await waitLong(async () => (await journal()).some(entry => entry.method === 'turn/start' && /Issue approval result/.test(entry.text ?? '') && new RegExp(id).test(entry.text)), 'main to hear the decision');
  assert.deepEqual((await second.request('question.list', {})).questions, []);
  await second.request('daemon.shutdown').catch(() => {});
  second.client.close();
  assert.deepEqual(await second.exited, { code: 0, signal: null });
});
