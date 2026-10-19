import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAlpRuntime, usageAllows } from '@anhlp/alp-runtime';
import { fakeTransport, tree, until } from '../../../test/support/fake-agent.js';

const codex = (...used) => ({ available: true, limits: [{ windows: used.map(usedPercent => ({ usedPercent, windowMinutes: 300, resetsAt: 1_900_000_000 })), spendControlReached: false }] });
const noticesOf = (events, sessionId = 'root') => events.filter(envelope => envelope.sessionId === sessionId && envelope.event.type === 'item' && envelope.event.item.kind === 'notice').map(envelope => envelope.event.item.text);

test('a usage report says whether the runtime may work again, or nothing when it cannot tell', () => {
  assert.equal(usageAllows(codex(0, 55)), true);
  assert.equal(usageAllows(codex(100, 55)), false);
  assert.equal(usageAllows({ ...codex(10), limits: [{ windows: [{ usedPercent: 10 }], spendControlReached: true }] }), false);
  assert.equal(usageAllows({ available: true, plan: 'max', windows: [{ name: 'five_hour', usedPercent: 7 }, { name: 'seven_day', usedPercent: 48 }] }), true);
  assert.equal(usageAllows({ available: true, windows: [{ name: 'seven_day', usedPercent: 100 }] }), false);
  assert.equal(usageAllows({ available: false }), undefined);
  assert.equal(usageAllows({ available: true, windows: [] }), undefined);
  assert.equal(usageAllows(undefined), undefined);
});

test('while a limit pauses Codex, alpd asks it every interval and resumes it once the limit lifts', async t => {
  const events = [];
  const { runtime, main } = await tree(t, { prefix: 'alp-limit-', open: { model: 'codex:gpt-5.6-sol' }, options: () => ({ language: 'English', limitCheckMs: 20 }) });
  runtime.onEvent(envelope => events.push(envelope));
  main.limits = codex(100);
  main.limit(Math.floor(Date.now() / 1000) + 3600);
  await until(() => runtime.pauses().runtimes.codex, 'the limit pause');
  assert.match(noticesOf(events).join('\n'), /ALP asks Codex every minute and resumes it as soon as the limit lifts/);
  // Still used up: it stays paused, and alp ps can say when it last asked.
  await until(() => runtime.pauses().runtimes.codex?.checkedAt, 'a check');
  assert.ok(runtime.pauses().runtimes.codex);
  // The limit lifts, early or on time: the next check resumes it.
  main.limits = codex(0, 55);
  await until(() => !runtime.pauses().runtimes.codex, 'the resume');
  await until(() => main.started.length === 2, 'the root continuation');
  assert.equal(main.started[1].params.threadId, main.threadId);
  assert.match(main.started[1].params.input.at(-1).text, /Continue the user's request/);
  assert.doesNotMatch(main.started[1].params.input.at(-1).text, /alp_handoff/);
  runtime.resume();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(main.started.length, 2);
  assert.ok(noticesOf(events).some(text => /Codex resumed by alpd, after the limit lifted/.test(text)));
});

test('a delegation to a paused runtime asks it first, and goes ahead when the limit lifted', async t => {
  // Main on Claude; its Codex peer hits the limit. The interval check is an hour off.
  const { runtime, agents, main } = await tree(t, { prefix: 'alp-limit-', open: { model: 'claude:claude-opus-5-5' }, options: () => ({ language: 'English', limitCheckMs: 3_600_000 }) });
  await main.call('alp_delegate', { agent: 'peer', task: 'Long job', mode: 'read-only', model: 'codex:gpt-5.6-sol', wait: false });
  await until(() => agents[1]?.started.length === 1);
  const peer = agents[1];
  peer.limits = codex(100);
  peer.limit(Math.floor(Date.now() / 1000) + 3600);
  await until(() => runtime.pauses().runtimes.codex, 'the limit pause');
  // Reset early: the next delegation asks Codex at once instead of refusing.
  peer.limits = codex(0);
  const started = await main.call('alp_delegate', { agent: 'reviewer', task: 'Review it', mode: 'read-only', model: 'codex:gpt-5.6-sol', wait: false });
  assert.equal(started.status, 'running', JSON.stringify(started));
  assert.equal(runtime.pauses().runtimes.codex, undefined);
  // The parked peer continues.
  await until(() => peer.started.length === 2, 'the parked peer continuing');
});

test('with autoResume off, alpd tells the user once that the limit lifted and leaves the resume to them', async t => {
  const events = [];
  const { runtime, main } = await tree(t, { prefix: 'alp-limit-', open: { model: 'codex:gpt-5.6-sol' }, options: () => ({ language: 'English', limitCheckMs: 20, autoResume: false }) });
  runtime.onEvent(envelope => events.push(envelope));
  main.limits = codex(100);
  main.limit(Math.floor(Date.now() / 1000) + 3600);
  await until(() => runtime.pauses().runtimes.codex, 'the limit pause');
  assert.match(noticesOf(events).join('\n'), /tells you when the limit lifts; then run alp resume codex/);
  main.limits = codex(0);
  await until(() => noticesOf(events).some(text => /Codex says its usage limit has lifted\. Run alp resume codex/.test(text)), 'the lift notice');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(noticesOf(events).filter(text => /has lifted/.test(text)).length, 1);
  assert.ok(runtime.pauses().runtimes.codex);
  assert.equal(main.started.length, 1);
  runtime.resume();
  await until(() => main.started.length === 2, 'explicit root resume');
});

test('a limit pause an earlier alpd left is checked at start, by a runtime process of its own when no session is open', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-limit-file-'));
  const file = path.join(directory, 'pause.json');
  const future = new Date(Date.now() + 3_600_000).toISOString();
  await writeFile(file, JSON.stringify({ runtimes: { codex: { since: new Date().toISOString(), by: 'alpd', reason: 'Codex usage limit reached', resetsAt: future } } }));

  // The runtime cannot tell, and the reset is ahead: it stays paused.
  const silent = [];
  const kept = createAlpRuntime({ language: 'English', transport: fakeTransport(silent), supervisor: false, pauseFile: file });
  await until(() => kept.pauses().runtimes.codex?.checkedAt, 'the start check');
  assert.equal(kept.pauses().runtimes.codex.reason, 'Codex usage limit reached');
  assert.ok(silent.length >= 1 && silent.every(agent => agent.closed), 'the probe process is closed');
  await kept.shutdown();

  // The runtime says the limit lifted before the reset time: resumed at start.
  const probes = [];
  const factory = fakeTransport(probes);
  const lifted = createAlpRuntime({ language: 'English', transport: (...args) => Object.assign(factory(...args), { limits: codex(0) }), supervisor: false, pauseFile: file });
  t.after(() => lifted.shutdown());
  // After hooks run in the order they are added: remove the files only once that has stopped.
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await until(() => !lifted.pauses().runtimes.codex, 'the resume at start');
  await until(async () => JSON.parse(await readFile(file, 'utf8')).runtimes.codex === undefined, 'the pause file');

  // A user's pause is theirs: never checked or lifted.
  await lifted.pause({ runtime: 'claude' });
  const before = probes.length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(probes.length, before);
  assert.ok(lifted.pauses().runtimes.claude);
  // Stop pause-file writes before the directory is removed.
  await lifted.shutdown();
});

test('root resume coalesces with repeated resume and keeps a simultaneous user prompt', async t => {
  for (const userFirst of [true, false]) {
    const { runtime, main } = await tree(t, { options: () => ({ limitCheckMs: 3_600_000 }) });
    main.limits = codex(100);
    main.limit();
    await until(() => runtime.snapshot('root').parked);
    const input = { clientMessageId: 'concurrent', delivery: 'auto', content: [{ type: 'text', text: 'Keep this instruction' }] };
    let sent;
    if (userFirst) sent = runtime.prompt('root', input);
    main.limits = codex(0);
    runtime.resume();
    runtime.resume();
    if (!userFirst) sent = runtime.prompt('root', input);
    await sent;
    await until(() => main.started.length === 2);
    assert.equal(runtime.snapshot('root').parked, undefined);
    assert.match([...main.started, ...main.calls.filter(call => call.method === 'turn/steer')].map(call => call.params.input.at(-1).text).join('\n'), /Keep this instruction/);
    assert.equal(main.started.length, 2);
  }
});

test('a failed root continuation start stays parked for retry; interruption and close revoke it', async t => {
  const { runtime, main } = await tree(t, { options: () => ({ limitCheckMs: 3_600_000 }) });
  main.limit();
  await until(() => runtime.snapshot('root').parked);
  const request = main.request.bind(main);
  let fail = true;
  main.request = async (method, params) => {
    if (method === 'turn/start' && fail) { fail = false; throw new Error('start failed'); }
    return request(method, params);
  };
  runtime.resume();
  await until(() => !fail);
  await until(() => runtime.snapshot('root').parked);
  assert.equal(main.started.length, 1);
  runtime.resume();
  await until(() => main.started.length === 2);
  main.limit();
  await until(() => runtime.snapshot('root').parked);
  await runtime.interrupt('root');
  runtime.resume();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(main.started.length, 2);
  assert.equal(runtime.snapshot('root').parked, undefined);
  await runtime.close('root');
  runtime.resume();
  assert.equal(main.started.length, 2);
});

for (const timing of ['before failure', 'during reset lookup']) {
  test(`an explicit runtime pause survives a usage failure ${timing}`, async t => {
    const { runtime, main } = await tree(t, { open: { model: 'codex:gpt-5.6-sol' }, options: () => ({ limitCheckMs: 20 }) });
    let release;
    let looking = false;
    if (timing === 'before failure') {
      await runtime.pause({ runtime: 'codex' });
      main.limit();
    } else {
      const reset = new Promise(resolve => { release = resolve; });
      main.orchestrationContext = async () => { looking = true; await reset; return { usage: codex(0) }; };
      main.notification('turn/completed', { threadId: main.threadId, turn: { id: main.turnId, status: 'failed', error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' } } });
      await until(() => looking, 'reset lookup started');
      await runtime.pause({ runtime: 'codex' });
      release();
    }
    await until(() => runtime.snapshot('root').parked);
    main.limits = codex(0);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(runtime.pauses().runtimes.codex?.by, 'the user');
    assert.equal(main.started.length, 1);
    runtime.resume();
    await until(() => main.started.length === 2);
  });
}
