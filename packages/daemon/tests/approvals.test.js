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
import { connect, daemonPaths } from '@anhlp/alp-client';

import { fakeTransport, until, workspace } from '../../../test/support/recovery.js';
import { teardown } from '../../../test/support/teardown.js';

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

