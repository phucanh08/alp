import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { fakeTransport, tree, until } from '../../../test/support/fake-agent.ts';
import { teardown } from '../../../test/support/teardown.ts';
import type { FakeAgent } from '../../../test/support/fake-agent.ts';

// Narrow pins for the pause, limit and usage branches no other test reached (t-8cd6.9, S5 domain 1).
// `any`: event envelopes are a union over every event type; the tests read the fields they filter.
type Json = any;

const codex = (...used: number[]) => ({ available: true, limits: [{ windows: used.map(usedPercent => ({ usedPercent, windowMinutes: 300, resetsAt: 1_900_000_000 })), spendControlReached: false }] });
const noticesOf = (events: Json[], sessionId = 'root') => events.filter(envelope => envelope.sessionId === sessionId && envelope.event.type === 'item' && envelope.event.item.kind === 'notice').map(envelope => envelope.event.item);

test('a Claude usage warning: its share as a fraction, once per reset, and "nearly all" without a share or reset', async t => {
  const events: Json[] = [];
  const { runtime, main } = await tree(t, { prefix: 'alp-pause-pins-', open: { model: 'claude:claude-opus-5-5' }, options: () => ({ language: 'English' }) });
  runtime.onEvent(envelope => events.push(envelope));
  const resetsAt = Math.floor(Date.now() / 1000) + 7200;
  main.notification!('account/rateLimits/updated', { claude: { status: 'allowed', utilization: 0.5, resetsAt } });
  assert.equal(noticesOf(events).length, 0);
  for (let i = 0; i < 2; i++) main.notification!('account/rateLimits/updated', { claude: { status: 'allowed_warning', utilization: 0.85, resetsAt } });
  assert.deepEqual(noticesOf(events).map(item => [item.level, item.text]), [['warning', `Claude has used 85% of a usage window that resets ${new Date(resetsAt * 1000).toISOString()}.`]]);
  main.notification!('account/rateLimits/updated', { claude: { status: 'allowed_warning' } });
  assert.equal(noticesOf(events).at(-1).text, 'Claude has used nearly all of a usage window.');
  assert.equal(noticesOf(events).length, 2);
});

test('the runtime and its pause book read one live pause state: a resume replaces it and every reader sees the new one', async t => {
  const { runtime } = await tree(t, { prefix: 'alp-pause-pins-', options: () => ({ language: 'English' }) });
  runtime.pause();
  assert.ok(runtime.pauses().all);
  assert.throws(() => runtime.resume({ runtime: 'codex' }), /All of ALP is paused/);
  runtime.resume();
  assert.equal(runtime.pauses().all, undefined);
  assert.doesNotThrow(() => runtime.resume({ runtime: 'codex' }));
  runtime.pause({ runtime: 'claude' });
  runtime.holdForDisk('disk full');
  assert.equal(runtime.diskHeld(), true);
  assert.equal(runtime.pauses().all?.cause, 'disk');
  // Lifting the disk pause replaces the state but keeps the runtime pauses.
  runtime.releaseDisk('alpd');
  assert.equal(runtime.diskHeld(), false);
  assert.equal(runtime.pauses().all, undefined);
  assert.equal(runtime.pauses().runtimes.claude?.by, 'the user');
  // A pause after the replacement lands in the new state.
  runtime.pause({ runtime: 'codex' });
  assert.deepEqual(Object.keys(runtime.pauses().runtimes).sort(), ['claude', 'codex']);
});

test('delegations to a limited runtime share one running limit check, and a check this fresh is not repeated', async t => {
  const { runtime, agents, main } = await tree(t, { prefix: 'alp-pause-pins-', open: { model: 'claude:claude-opus-5-5' }, options: () => ({ language: 'English', limitCheckMs: 3_600_000 }), profiles: { peer: ['codex:gpt-5.6-sol'], reviewer: ['codex:gpt-5.6-sol'] } });
  await main.call('alp_delegate', { agent: 'peer', task: 'Long job', mode: 'read-only', model: 'codex:gpt-5.6-sol', wait: false });
  await until(() => agents[1]?.started.length === 1);
  const peer = agents[1];
  peer.limits = codex(100);
  peer.limit(Math.floor(Date.now() / 1000) + 3600);
  await until(() => runtime.pauses().runtimes.codex, 'the limit pause');
  let asked = 0;
  let answer!: () => void;
  const answered = new Promise<void>(resolve => { answer = resolve; });
  peer.orchestrationContext = async () => { asked++; await answered; return { runtime: 'codex', usage: codex(100) }; };
  const delegate = () => main.call('alp_delegate', { agent: 'reviewer', task: 'Review it', mode: 'read-only', model: 'codex:gpt-5.6-sol', wait: false });
  const first = delegate();
  await until(() => asked === 1, 'the first check');
  const second = delegate();
  await new Promise(resolve => setTimeout(resolve, 30));
  answer();
  for (const result of await Promise.all([first, second])) assert.match(String(result.error), /Codex is paused/, JSON.stringify(result));
  assert.equal(asked, 1, 'the second delegation waited on the running check');
  const third = await delegate();
  assert.match(String(third.error), /Codex is paused/);
  assert.equal(asked, 1, 'a check within the fresh window answers the third');
});

test('an assignment whose continuation fails to start stays parked, and its requester sees it parked again', async t => {
  const events: Json[] = [];
  const { runtime, agents, main } = await tree(t, { prefix: 'alp-pause-pins-', open: { model: 'claude:claude-opus-5-5' }, options: () => ({ language: 'English', limitCheckMs: 3_600_000 }), profiles: { peer: ['codex:gpt-5.6-sol'] } });
  runtime.onEvent(envelope => events.push(envelope));
  await main.call('alp_delegate', { agent: 'peer', task: 'Long job', mode: 'read-only', model: 'codex:gpt-5.6-sol', wait: false });
  await until(() => agents[1]?.started.length === 1);
  const peer = agents[1];
  const peerId = runtime.list().find(session => session.parentId === 'root')!.id;
  peer.limit();
  await until(() => runtime.snapshot(peerId)?.parked, 'the parked peer');
  const request = peer.request.bind(peer);
  peer.request = async (method, params) => {
    if (method === 'turn/start') throw new Error('start failed');
    return request(method, params);
  };
  const before = events.length;
  runtime.resume();
  await until(() => noticesOf(events).some(item => /^Could not resume peer: start failed/.test(item.text)), 'the failure notice');
  assert.ok(runtime.snapshot(peerId)?.parked);
  const statuses = events.slice(before).filter(envelope => envelope.sessionId === 'root' && envelope.event.type === 'assignment').map(envelope => envelope.event.assignment.status);
  assert.deepEqual(statuses, ['running', 'parked']);
  assert.equal(peer.started.length, 1);
});

test('a pause of all ALP that arrives while a continuation waits in the queue keeps the work parked until the next resume', async t => {
  const { runtime, main } = await tree(t, { prefix: 'alp-pause-pins-', open: { model: 'codex:gpt-5.6-sol' }, options: () => ({ language: 'English', limitCheckMs: 3_600_000 }) });
  main.limit();
  await until(() => runtime.snapshot('root')!.parked, 'the parked root');
  // The continuation is queued by resume and runs after this synchronous pause.
  runtime.resume({ runtime: 'codex' });
  runtime.pause();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(runtime.snapshot('root')!.parked);
  assert.equal(main.started.length, 1);
  runtime.resume();
  await until(() => main.started.length === 2, 'the continuation after the resume');
  assert.equal(runtime.snapshot('root')!.parked, undefined);
});

test('a limit pause without a reset time stays when the runtime cannot be asked: no provider, a probe that fails, a close that fails', async t => {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-pause-pins-'));
  // Undone last: the runtimes below stop writing the pause file first.
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const file = path.join(directory, 'pause.json');
  await writeFile(file, JSON.stringify({ runtimes: { codex: { since: new Date().toISOString(), by: 'alpd', reason: 'Codex usage limit reached' } } }));
  // The provider cannot be made at all.
  let made = 0;
  const missing = createAlpRuntime({ language: 'English', supervisor: false, pauseFile: file, transport: () => { made++; throw new Error('codex is not installed'); } });
  defer(() => missing.shutdown());
  await until(() => missing.pauses().runtimes.codex?.checkedAt, 'the start check');
  assert.ok(made >= 1);
  assert.equal(missing.pauses().runtimes.codex!.by, 'alpd');
  await missing.shutdown();
  // The probe reports a failure while it starts, and its close fails.
  const probes: FakeAgent[] = [];
  const factory = fakeTransport(probes);
  const failing = createAlpRuntime({ language: 'English', supervisor: false, pauseFile: file, transport: (...args) => {
    const agent = (factory as (...passed: unknown[]) => FakeAgent)(...args);
    agent.initialize = async () => { agent.failure?.(new Error('probe stopped')); throw new Error('probe stopped'); };
    agent.close = async () => { throw new Error('close failed'); };
    return agent;
  } });
  defer(() => failing.shutdown());
  await until(() => failing.pauses().runtimes.codex?.checkedAt, 'the start check');
  assert.ok(probes.length >= 1);
  assert.equal(failing.pauses().runtimes.codex!.by, 'alpd');
  assert.equal(failing.pauses().runtimes.codex!.resetsAt, undefined);
  await failing.shutdown();
  // A report the limit check cannot read (windows that are not a list) counts as no answer.
  const readers: FakeAgent[] = [];
  const reader = fakeTransport(readers);
  const garbled = createAlpRuntime({ language: 'English', supervisor: false, pauseFile: file, transport: (...args) => Object.assign((reader as (...passed: unknown[]) => FakeAgent)(...args), { limits: { available: true, windows: 5 } }) });
  defer(() => garbled.shutdown());
  await until(() => garbled.pauses().runtimes.codex?.checkedAt, 'the start check');
  assert.ok(readers.length >= 1);
  assert.equal(garbled.pauses().runtimes.codex!.by, 'alpd');
});

test('the reset time of a limit: Claude\'s from its last report; Codex\'s unknown when its context cannot say', async t => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const claude = await tree(t, { prefix: 'alp-pause-pins-', open: { model: 'claude:claude-opus-5-5' }, options: () => ({ language: 'English', limitCheckMs: 3_600_000 }) });
  claude.main.notification!('account/rateLimits/updated', { claude: { status: 'rejected', resetsAt } });
  claude.main.notification!('turn/completed', { threadId: claude.main.threadId, turn: { id: claude.main.turnId, status: 'failed', error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' } } });
  await until(() => claude.runtime.pauses().runtimes.claude, 'the Claude pause');
  assert.equal(claude.runtime.pauses().runtimes.claude!.resetsAt, new Date(resetsAt * 1000).toISOString());
  for (const context of ['throws', 'says nothing'] as const) {
    const codex = await tree(t, { prefix: 'alp-pause-pins-', open: { model: 'codex:gpt-5.6-sol' }, options: () => ({ language: 'English', limitCheckMs: 3_600_000 }) });
    codex.main.orchestrationContext = async () => { if (context === 'throws') throw new Error('no context'); return { usage: { limits: [{}] } }; };
    codex.main.notification!('turn/completed', { threadId: codex.main.threadId, turn: { id: codex.main.turnId, status: 'failed', error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' } } });
    await until(() => codex.runtime.pauses().runtimes.codex, `the Codex pause (context ${context})`);
    assert.equal(codex.runtime.pauses().runtimes.codex!.resetsAt, undefined);
  }
});

test('pause --now parks a running assignment even when its runtime refuses the interrupt', async t => {
  const { runtime, agents, main } = await tree(t, { prefix: 'alp-pause-pins-', open: { model: 'claude:claude-opus-5-5' }, options: () => ({ language: 'English', limitCheckMs: 3_600_000 }), profiles: { peer: ['codex:gpt-5.6-sol'] } });
  await main.call('alp_delegate', { agent: 'peer', task: 'Long job', mode: 'read-only', model: 'codex:gpt-5.6-sol', wait: false });
  await until(() => agents[1]?.started.length === 1);
  const peer = agents[1];
  const peerId = runtime.list().find(session => session.parentId === 'root')!.id;
  const request = peer.request.bind(peer);
  let refused = 0;
  peer.request = async (method, params) => {
    if (method === 'turn/interrupt') { refused++; throw new Error('interrupt refused'); }
    return request(method, params);
  };
  runtime.pause({ runtime: 'codex', now: true });
  await until(() => refused === 1, 'the interrupt');
  assert.equal(runtime.snapshot(peerId)?.parked, 'paused by the user');
  // The turn ends interrupted all the same; the assignment parks instead of ending.
  peer.notification!('turn/completed', { threadId: peer.threadId, turn: { id: peer.turnId, status: 'interrupted' } });
  await until(() => runtime.pauses().parked.some(entry => entry.assignmentId === peerId), 'the parked assignment');
});

test('daemon.usage answers a provider it could not read as unavailable, even when its probe fails to close', async t => {
  const made: FakeAgent[] = [];
  const factory = fakeTransport(made);
  let throwing = 0;
  // Main is open on Claude, so Codex is read by a probe of its own; that probe's close throws at once.
  const transport = (...args: unknown[]) => {
    const agent = (factory as (...passed: unknown[]) => FakeAgent)(...args);
    if (args[2] === 'codex') agent.close = (() => { throwing++; throw new Error('close failed'); }) as unknown as FakeAgent['close'];
    return agent;
  };
  const { runtime } = await tree(t, { prefix: 'alp-pause-pins-', open: { model: 'claude:claude-opus-5-5' }, options: () => ({ language: 'English', transport: transport as never }) });
  const { providers } = await runtime.usage(true);
  assert.equal(throwing, 1);
  const codex = providers.find(provider => provider.runtime === 'codex')!;
  assert.equal(codex.available, false);
  assert.equal(codex.account, null);
});
