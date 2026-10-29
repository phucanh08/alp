import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '@anhlp/alp-core/init';
import { addGate, createTask, getTask, resolveGate } from '@anhlp/alp-core/tasks';
import { createAlpRuntime } from '@anhlp/alp-runtime';
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

async function start(t, root, { prompt = true } = {}) {
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), supervisor: false, gateSyncMs: 20, libraryDir: homes.get(root) });
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
  assert.deepEqual(question.options, ['Ship it', 'Ship to staging']);
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

  runtime.answer(question.id, { text: 'Ship to staging', channel: 'paseo' });
  await until(async () => (await getTask(root, task.id)).gates[0].resolved?.notified, 'decision reported');
  const gate = (await getTask(root, task.id)).gates[0];
  assert.equal(gate.resolved.choice, 'Ship to staging');
  assert.equal(gate.resolved.channel, 'paseo');
  assert.equal(gate.resolved.by, 'user');
  await until(() => decisions(main()) === 1, 'decision mail');
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
  runtime.answer(`gate-${task.id}-g1`, { dismiss: true, reason: 'Wait for QA', channel: 'web' });
  await until(async () => (await getTask(root, task.id)).gates[0].rejected?.notified, 'rejection reported');
  const gate = (await getTask(root, task.id)).gates[0];
  assert.equal(gate.resolved, undefined);
  assert.deepEqual([gate.rejected.reason, gate.rejected.channel], ['Wait for QA', 'web']);
  await until(() => decisions(main()) === 1, 'rejection mail');
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
  runtime.answer(`gate-${task.id}-g2`, { text: 'Từ chối' });
  // The web panel (task.gate.resolve) clears g1 while the card answer for it is in flight.
  const before = (await getTask(root, task.id)).rev;
  const panel = resolveGate(root, task.id, 'g1', { by: 'user', channel: 'web', ifRev: before });
  runtime.answer(`gate-${task.id}-g1`, { text: 'Duyệt', channel: 'paseo' });
  const outcomes = await Promise.allSettled([panel, runtime.syncGates(root)]);
  assert.ok(outcomes.length === 2);
  await until(async () => { const gates = (await getTask(root, task.id)).gates; return gates[0].resolved?.notified && gates[1].rejected?.notified; }, 'both reported');
  await until(() => decisions(main()) === 2, 'two decision mails');
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
  await until(async () => (await getTask(root, task.id)).gates[1].resolved?.notified, 'reported to the next main');
  await second.runtime.prompt('root', { clientMessageId: 'm2', delivery: 'auto', content: [{ type: 'text', text: 'Hi' }] });
  await until(() => decisions(second.main()) === 1, 'mail to the next main');
  assert.match(said(second.main()), /approved human gate g2 .* in cli: fine/);
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
  await resolveGate(root, id, gateId, { by: 'user', channel: 'cli', choice: 'B' });
  await until(() => !card(runtime, id), 'card settled by the timer');
  await until(() => decisions(main()) === 1, 'cli decision mail');
});
