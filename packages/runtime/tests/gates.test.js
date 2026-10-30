import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '@anhlp/alp-core/init';
import { addGate, createTask, getTask, resolveGate } from '@anhlp/alp-core/tasks';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { words } from '@anhlp/alp-runtime/language';
import { fakeTransport, until } from '../../../test/support/fake-agent.js';

// Human gates mirrored as cards on main (t-ccac): the task files stay the source of truth.

async function project(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gates-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  homes.set(root, path.join(directory, 'home'));
  return root;
}
const homes = new Map();

async function start(t, root, { prompt = true, gateSyncMs = 20 } = {}) {
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), supervisor: false, gateSyncMs, libraryDir: homes.get(root) });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await runtime.shutdown(); } };
  t.after(stop);
  await runtime.open('root', { cwd: root });
  if (prompt) await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  return { runtime, agents, main: () => agents[0], stop };
}

/** Every text ALP gave main: turn inputs and steering. */
const said = agent => [...agent.started.map(call => call.params.input.map(part => part.text ?? '').join('\n')), ...agent.steered].join('\n---\n');
const decisions = agent => said(agent).split('Gate decision').length - 1;
const card = (runtime, task, gate = 'g1') => runtime.questions().find(question => question.id === `gate-${task}-${gate}`);

test('an open human gate shows as a card on main, outside the one-question limit and without a timeout; an option approves it and main is mailed once', async t => {
  const root = await project(t);
  const task = await createTask(root, { title: 'Release' }, 'user');
  await addGate(root, task.id, { kind: 'human', note: 'Release the beta?', options: ['Ship it', 'Ship to staging'] }, 'main');
  const { runtime, main } = await start(t, root);
  await until(() => card(runtime, task.id), 'gate card');
  const question = card(runtime, task.id);
  assert.deepEqual(question.options.slice(0, 2), ['Ship it', 'Ship to staging']);
  assert.match(question.options[2], /^(Reject|Từ chối)$/, 'an options card still offers Reject');
  assert.deepEqual(question.gate, { projectRoot: root, taskId: task.id, gateId: 'g1' });
  assert.match(question.body, /Release the beta\?/);
  // The card is not the session's one question: main may still ask the user.
  const asked = main().call('alp_ask', { question: 'Which branch?', to: 'user' });
  await until(() => runtime.questions().some(entry => entry.body === 'Which branch?'), 'second question');
  const other = runtime.questions().find(entry => entry.body === 'Which branch?');
  runtime.answer(other.id, { text: 'main' });
  assert.equal((await asked).answer, 'main');
  assert.notEqual(runtime.status('root').sessions[0].state, 'waiting_user');
  // A turn's end does not end the card.
  main().finish();
  await until(() => !runtime.snapshot('root').activeTurnId);
  assert.ok(card(runtime, task.id));

  await runtime.answer(question.id, { text: 'Ship to staging', channel: 'paseo' });
  const gate = (await getTask(root, task.id)).gates[0];
  assert.equal(gate.resolved.choice, 'Ship to staging');
  assert.equal(gate.resolved.channel, 'paseo');
  assert.equal(gate.resolved.by, 'user');
  await until(() => decisions(main()) === 1, 'decision mail');
  // Marked reported once main's turn took the mail (t-595d).
  main().finish();
  await until(async () => (await getTask(root, task.id)).gates[0].resolved?.notified, 'decision reported');
  assert.match(said(main()), /approved human gate g1 of .* in paseo, choosing "Ship to staging"/);
  assert.equal(card(runtime, task.id), undefined);
  await runtime.syncGates(root);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(decisions(main()), 1, 'mailed exactly once');
});

test('dismissing a card rejects the gate: it stays open, the reason is recorded, main is told once and the card is not shown again', async t => {
  const root = await project(t);
  const task = await createTask(root, { title: 'Deploy' }, 'user');
  await addGate(root, task.id, { kind: 'human', note: 'Deploy now?' }, 'main');
  const { runtime, main } = await start(t, root);
  await until(() => card(runtime, task.id), 'gate card');
  assert.deepEqual(card(runtime, task.id).options, ['Duyệt', 'Từ chối']);
  await runtime.answer(`gate-${task.id}-g1`, { dismiss: true, reason: 'Wait for QA', channel: 'web' });
  await until(() => decisions(main()) === 1, 'rejection mail');
  main().finish();
  await until(async () => (await getTask(root, task.id)).gates[0].rejected?.notified, 'rejection reported');
  const gate = (await getTask(root, task.id)).gates[0];
  assert.equal(gate.resolved, undefined);
  assert.deepEqual([gate.rejected.reason, gate.rejected.channel], ['Wait for QA', 'web']);
  assert.match(said(main()), /rejected human gate g1 .* in web: Wait for QA\. The gate stays open/);
  await runtime.syncGates(root);
  assert.equal(card(runtime, task.id), undefined);
  assert.equal(decisions(main()), 1);
});

test('the default Reject answer rejects; the panel and the card racing on one gate clear it once and mail once', async t => {
  const root = await project(t);
  const task = await createTask(root, { title: 'Race' }, 'user');
  await addGate(root, task.id, { kind: 'human', note: 'Go?' }, 'main');
  await addGate(root, task.id, { kind: 'human', note: 'Also?' }, 'main');
  const { runtime, main } = await start(t, root);
  await until(() => card(runtime, task.id, 'g1') && card(runtime, task.id, 'g2'), 'two cards');
  await runtime.answer(`gate-${task.id}-g2`, { text: 'Từ chối' });
  // The web panel (task.gate.resolve) clears g1 while the card answer for it is in flight.
  const before = (await getTask(root, task.id)).rev;
  const panel = resolveGate(root, task.id, 'g1', { by: 'user', channel: 'web', ifRev: before });
  const answered = runtime.answer(`gate-${task.id}-g1`, { text: 'Duyệt', channel: 'paseo' });
  const outcomes = await Promise.allSettled([panel, answered, runtime.syncGates(root)]);
  // One of the two wins; the one that lost is told so (t-595d).
  assert.equal(outcomes.slice(0, 2).filter(outcome => outcome.status === 'fulfilled').length, 1, JSON.stringify(outcomes));
  await until(() => decisions(main()) === 2, 'two decision mails');
  main().finish();
  await until(async () => { const gates = (await getTask(root, task.id)).gates; return gates[0].resolved?.notified && gates[1].rejected?.notified; }, 'both reported');
  const gates = (await getTask(root, task.id)).gates;
  assert.ok(['web', 'paseo'].includes(gates[0].resolved.channel));
  assert.equal(gates[1].rejected.reason, undefined, 'the Reject option itself is not a reason');
  const log = (await getTask(root, task.id)).log.filter(entry => entry.event === 'gate cleared');
  assert.equal(log.length, 1, 'cleared once');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(decisions(main()), 2, 'no double mail');
  assert.equal(runtime.questions().filter(question => question.gate).length, 0);
});

test('cards are rebuilt after a restart, and a decision made with no main live reaches the next main once', async t => {
  const root = await project(t);
  const task = await createTask(root, { title: 'Durable' }, 'user');
  await addGate(root, task.id, { kind: 'human', note: 'Keep?' }, 'main');
  await addGate(root, task.id, { kind: 'human', note: 'Later?' }, 'main');
  const first = await start(t, root);
  await until(() => card(first.runtime, task.id, 'g1'), 'card before restart');
  await first.stop();

  // alpd is down: the user clears g2 with the CLI.
  await resolveGate(root, task.id, 'g2', { by: 'user', channel: 'cli', note: 'fine' });
  const second = await start(t, root, { prompt: false });
  await until(() => card(second.runtime, task.id, 'g1'), 'card rebuilt');
  assert.equal(card(second.runtime, task.id, 'g2'), undefined);
  await until(() => decisions(second.main()) === 1, 'mail to the next main');
  assert.match(said(second.main()), /approved human gate g2 .* in cli: fine/);
  second.main().finish();
  await until(async () => (await getTask(root, task.id)).gates[1].resolved?.notified, 'reported to the next main');
  await until(() => !second.runtime.snapshot('root').activeTurnId);
  await second.runtime.prompt('root', { clientMessageId: 'm2', delivery: 'auto', content: [{ type: 'text', text: 'Hi' }] });
  await second.runtime.syncGates(root);
  assert.equal(decisions(second.main()), 1);
});

test('a clear made outside alpd (CLI) settles the card by the timer; alp_task gate takes options and agents still cannot clear a human gate', async t => {
  const root = await project(t);
  const { runtime, main } = await start(t, root);
  const created = await main().call('alp_task', { action: 'create', title: 'Pick' });
  const id = created.task?.id ?? created.id;
  assert.match((await main().call('alp_task', { action: 'gate', id, kind: 'human', note: 'Which?', options: Array.from({ length: 11 }, (_, i) => `o${i}`) })).error, /at most 10/);
  assert.match((await main().call('alp_task', { action: 'gate', id, kind: 'human', note: 'Which?', options: ['x'.repeat(201)] })).error, /200 characters/);
  assert.match((await main().call('alp_task', { action: 'gate', id, kind: 'timer', until: '+1h', options: ['a'] })).error, /Only a human gate/);
  await main().call('alp_task', { action: 'gate', id, kind: 'human', note: 'Which?', options: ['A', 'B'] });
  await until(() => card(runtime, id), 'card for a new gate');
  const gateId = card(runtime, id).gate.gateId;
  assert.match((await main().call('alp_task', { action: 'clear', id, gate: gateId })).error, /Only the user clears a human gate/);
  // Nor close the task around it, for any reason (t-f438).
  for (const reason of ['done', 'wontfix', 'superseded', 'duplicate']) assert.match((await main().call('alp_task', { action: 'close', id, reason, unverified: 'x' })).error ?? '', /Only the user closes/);
  assert.equal((await getTask(root, id)).status, 'open');
  await resolveGate(root, id, gateId, { by: 'user', channel: 'cli', choice: 'B' });
  await until(() => !card(runtime, id), 'card settled by the timer');
  await until(() => decisions(main()) === 1, 'cli decision mail');
});

test('an options card: Reject keeps the gate open with no reason, and free text rejects with it as the reason', async t => {
  const root = await project(t);
  const task = await createTask(root, { title: 'Pick' }, 'user');
  await addGate(root, task.id, { kind: 'human', note: 'Which?', options: ['A', 'B'] }, 'main');
  await addGate(root, task.id, { kind: 'human', note: 'Which else?', options: ['C'] }, 'main');
  const { runtime, main } = await start(t, root);
  await until(() => card(runtime, task.id) && card(runtime, task.id, 'g2'), 'cards');
  const reject = card(runtime, task.id).options.at(-1);
  await Promise.all([
    runtime.answer(card(runtime, task.id).id, { text: reject, channel: 'web' }),
    runtime.answer(card(runtime, task.id, 'g2').id, { text: 'Neither, ask QA', channel: 'paseo' }),
  ]);
  await until(() => decisions(main()) === 2, 'two mails');
  main().finish();
  await until(async () => { const gates = (await getTask(root, task.id)).gates; return gates[0].rejected?.notified && gates[1].rejected?.notified; }, 'both rejections reported');
  const gates = (await getTask(root, task.id)).gates;
  assert.equal(gates[0].resolved, undefined);
  assert.equal(gates[0].rejected.reason, undefined);
  assert.equal(gates[1].resolved, undefined);
  assert.equal(gates[1].rejected.reason, 'Neither, ask QA');
  await runtime.syncGates(root);
  assert.equal(card(runtime, task.id), undefined, 'a rejected gate shows no card again');
  assert.equal(card(runtime, task.id, 'g2'), undefined);
});

test('an option that is the Reject label, in any language ALP writes it, is refused when the gate is made (t-595d)', async t => {
  const root = await project(t);
  const task = await createTask(root, { title: 'Pick' }, 'user');
  // Trimmed, without case, and in either Unicode form: each would hide Reject and approve instead.
  for (const label of [words('en').reject, words('vi').reject, ' reject ', 'REJECT', 'TỪ CHỐI', ' từ chối '.normalize('NFD')]) {
    await assert.rejects(addGate(root, task.id, { kind: 'human', note: 'Which?', options: ['Ship', label] }, 'main'), /Reject/, JSON.stringify(label));
  }
  assert.equal((await getTask(root, task.id)).gates.length, 0);
  const { main } = await start(t, root);
  assert.match((await main().call('alp_task', { action: 'gate', id: task.id, kind: 'human', note: 'Which?', options: ['Ship', 'Từ chối'] })).error ?? '', /Reject/);
  // A word that only contains it is an ordinary option.
  await main().call('alp_task', { action: 'gate', id: task.id, kind: 'human', note: 'Which?', options: ['Ship', 'Reject the beta'] });
  assert.deepEqual((await getTask(root, task.id)).gates.map(gate => gate.options), [['Ship', 'Reject the beta']]);
});

test('a decision main never took is mailed again after a restart, and is not mailed twice while it waits (t-595d)', async t => {
  const root = await project(t);
  const task = await createTask(root, { title: 'Crash' }, 'user');
  await addGate(root, task.id, { kind: 'human', note: 'Go?' }, 'main');
  const first = await start(t, root);
  await until(() => card(first.runtime, task.id), 'gate card');
  await first.runtime.answer(`gate-${task.id}-g1`, { text: 'Duyệt', channel: 'web' });
  await until(() => decisions(first.main()) === 1, 'decision steered into the running turn');
  // The timer syncs many times while main's turn runs: the mail on its way is not sent again.
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(decisions(first.main()), 1, 'one mail while it waits');
  // alpd stops before main's turn completes: main never acknowledged the mail.
  await first.stop();
  assert.equal((await getTask(root, task.id)).gates[0].resolved.notified, undefined, 'not marked before main took it');

  const second = await start(t, root, { prompt: false });
  await until(() => decisions(second.main()) === 1, 'the decision, mailed to the next main');
  second.main().finish();
  await until(async () => (await getTask(root, task.id)).gates[0].resolved?.notified, 'marked once main took it');
  await second.runtime.syncGates(root);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(decisions(second.main()), 1, 'mailed once to this main');
});

test('a decision written outside alpd reaches main at once, not on the next timer sync (t-595d)', async t => {
  const root = await project(t);
  const task = await createTask(root, { title: 'Prompt' }, 'user');
  await addGate(root, task.id, { kind: 'human', note: 'Go?' }, 'main');
  const { runtime, main } = await start(t, root, { gateSyncMs: 60_000 });
  await until(() => card(runtime, task.id), 'gate card');
  // The CLI (or Paseo's local Tasks panel) writes the task file without alpd.
  await resolveGate(root, task.id, 'g1', { by: 'user', channel: 'cli', note: 'go' });
  await until(() => decisions(main()) === 1, 'the cli decision, long before the timer');
  await until(() => !card(runtime, task.id), 'card settled');
});

test('a second answer to a gate card, an answer another channel beat, and a failed write are refused to the caller (t-595d)', async t => {
  const root = await project(t);
  const task = await createTask(root, { title: 'Twice' }, 'user');
  const other = await createTask(root, { title: 'Broken' }, 'user');
  await addGate(root, task.id, { kind: 'human', note: 'Go?' }, 'main');
  await addGate(root, task.id, { kind: 'human', note: 'Also?' }, 'main');
  await addGate(root, other.id, { kind: 'human', note: 'Fix?' }, 'main');
  const { runtime } = await start(t, root, { gateSyncMs: 60_000 });
  await until(() => card(runtime, task.id) && card(runtime, task.id, 'g2') && card(runtime, other.id), 'cards');

  // Two answers to one card: the first decides, the second is refused, not dropped.
  const first = runtime.answer(`gate-${task.id}-g1`, { text: 'Duyệt', channel: 'web' });
  await assert.rejects(Promise.resolve().then(() => runtime.answer(`gate-${task.id}-g1`, { text: 'Từ chối', channel: 'paseo' })), /already/);
  await first;
  const gate = (await getTask(root, task.id)).gates[0];
  assert.deepEqual([!!gate.resolved, gate.resolved.channel, gate.rejected], [true, 'web', undefined]);

  // Another channel decided g2 first: the card's answer says so.
  await resolveGate(root, task.id, 'g2', { by: 'user', channel: 'cli' });
  await assert.rejects(Promise.resolve().then(() => runtime.answer(`gate-${task.id}-g2`, { text: 'Từ chối', channel: 'web' })), /already/);
  assert.equal((await getTask(root, task.id)).gates[1].rejected, undefined);

  // The write fails: the caller gets the error.
  await writeFile(path.join(root, '.alp', 'tasks', `${other.id}.json`), '{ not json');
  await assert.rejects(Promise.resolve().then(() => runtime.answer(`gate-${other.id}-g1`, { text: 'Duyệt', channel: 'web' })));
});
