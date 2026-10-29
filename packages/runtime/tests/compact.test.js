import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { seedLibrary, librarySkills } from '@anhlp/alp-core/library';
import { ClaudeTransport, createAlpRuntime, checkpointPrompt, compactDue, compactSettings, contextFill, seedPrompt } from '@anhlp/alp-runtime';
import { fakeTransport, until } from '../../../test/support/fake-agent.js';

const CHECKPOINT = '**Assignment đang chạy:** none\n**Bước tiếp theo:** review PR #9';

async function project(t, settings) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-compact-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  if (settings) {
    const file = path.join(root, '.alp', 'settings.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ...settings }));
  }
  return { directory, root, runs: path.join(directory, 'runs') };
}

const logOf = runs => async event => (await readFile(path.join(runs, 'root.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.event === event);
const promptText = call => call.params.input.map(part => part.text ?? '').join('\n');
const settle = () => new Promise(resolve => setTimeout(resolve, 40));

async function open(t, { settings, model, transport } = {}) {
  const { directory, root, runs } = await project(t, settings);
  const runtimes = [];
  const events = [];
  const factory = fakeTransport(runtimes);
  const runtime = createAlpRuntime({ transport: transport ? (...args) => transport(factory(...args), runtimes.length - 1) : factory, supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: runs });
  t.after(() => runtime.shutdown());
  runtime.onEvent(envelope => events.push(envelope.event));
  await runtime.open('root', { cwd: root, ...(model ? { model } : {}) });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Ship the parser' }] });
  return { runtime, runtimes, events, log: logOf(runs), main: runtimes[0] };
}

const notices = events => events.filter(event => event.type === 'item' && event.item.kind === 'notice').map(event => event.item.text);

test('compact settings, fill and the decision', () => {
  assert.deepEqual(compactSettings(undefined), { auto: true, threshold: 0.7 });
  assert.deepEqual(compactSettings({ auto: false, threshold: 0.5 }), { auto: false, threshold: 0.5 });
  assert.deepEqual(compactSettings({ threshold: 1.5 }), { auto: true, threshold: 0.7 });
  assert.equal(contextFill({ last: { totalTokens: 70_000 }, modelContextWindow: 100_000 }), 0.7);
  assert.equal(contextFill({ last: { totalTokens: 70_000 } }), undefined);
  assert.equal(compactDue({ auto: true, threshold: 0.7 }, 0.69, false), undefined);
  assert.equal(compactDue({ auto: true, threshold: 0.7 }, 0.7, false), 'auto');
  assert.equal(compactDue({ auto: false, threshold: 0.7 }, 0.95, false), undefined);
  assert.equal(compactDue({ auto: false, threshold: 0.7 }, undefined, true), 'manual');
  assert.match(checkpointPrompt('auto', 0.72), /about 72% full[\s\S]*skill compact/);
  const seeded = seedPrompt(CHECKPOINT, 'Ship the parser');
  assert.ok(seeded.includes(CHECKPOINT) && seeded.includes("The user's last message before the compaction, verbatim:\nShip the parser"));
});

test('the bundled compact skill is installed and given to main', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-compact-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { created } = await seedLibrary(home);
  assert.ok(created.includes('skills/compact/SKILL.md'));
  assert.match(await readFile(path.join(home, 'skills/compact/SKILL.md'), 'utf8'), /^---\nname: compact\n/);
  assert.ok((await librarySkills(home, 'main')).some(skill => skill.name === 'compact'));
  assert.ok(!(await librarySkills(home, 'peer')).some(skill => skill.name === 'compact'));
});

test('auto compaction: deferred while main holds its turn, checkpoint at the boundary, Codex native, notice and run log', async t => {
  const { events, log, main } = await open(t, { model: 'codex:gpt-5.6-sol' });
  // Mid-turn: the fill crosses the threshold while main waits on alp_wait; nothing starts.
  main.usage(75_000);
  const waiting = main.call('alp_wait', { timeoutMs: 50 });
  await settle();
  assert.equal(main.started.length, 1);
  assert.ok(!main.calls.some(call => call.method === 'thread/compact/start'));
  await waiting;
  main.finish('turn done');

  await until(() => main.started.length === 2, 'the checkpoint turn');
  assert.match(promptText(main.started[1]), /ALP compact checkpoint: Your context is about 75% full\.[\s\S]*skill compact/);
  main.finish(CHECKPOINT);
  await until(() => main.calls.some(call => call.method === 'thread/compact/start'), 'the native compaction');
  // Codex takes the thread alone.
  assert.deepEqual(main.calls.find(call => call.method === 'thread/compact/start').params, { threadId: main.threadId });
  main.compact(75_000, 9_000);
  await until(async () => (await log('compact')).length === 1, 'the compact run-log entry');
  const [entry] = await log('compact');
  assert.equal(entry.trigger, 'auto');
  assert.equal(entry.via, 'native');
  assert.deepEqual((await log('compact.started')).map(started => [started.trigger, started.fill]), [['auto', 0.75]]);
  assert.equal(notices(events).filter(text => /compact/.test(text)).length, 1);
  // What ALP holds after it carries the checkpoint.
  await until(() => main.calls.some(call => (call.method === 'turn/start' || call.method === 'turn/steer') && promptText(call).includes(CHECKPOINT)) || events.some(event => event.type === 'mail' && String(event.mail.body ?? '').includes(CHECKPOINT)), 'the checkpoint after the compaction');
});

test('auto compaction can be turned off, and a lower threshold is honoured', async t => {
  const off = await open(t, { settings: { compact: { auto: false } } });
  off.main.usage(80_000);
  off.main.finish('ok');
  await settle();
  assert.equal(off.main.started.length, 1);

  const low = await open(t, { settings: { compact: { threshold: 0.5 } } });
  low.main.usage(55_000);
  low.main.finish('ok');
  await until(() => low.main.started.length === 2, 'the checkpoint at 50%');
});

test('Claude compacts with /compact keeping the checkpoint', async t => {
  const { main, log } = await open(t, { model: 'claude:claude-opus-5-5' });
  main.usage(80_000);
  main.finish('ok');
  await until(() => main.started.length === 2, 'the checkpoint turn');
  main.finish(CHECKPOINT);
  await until(() => main.calls.some(call => call.method === 'thread/compact/start'), 'the native compaction');
  const { params } = main.calls.find(call => call.method === 'thread/compact/start');
  assert.ok(params.instructions.includes(CHECKPOINT));
  main.compact(80_000, 10_000);
  await until(async () => (await log('compact')).length === 1);
});

test('the Claude transport turns thread/compact/start into a /compact turn', async () => {
  const transport = new ClaudeTransport(process.execPath, tmpdir(), process.env);
  const pushed = [];
  const seen = [];
  transport.query = {};
  transport.threadId = 'claude-thread';
  transport.input = { push: message => pushed.push(message) };
  transport.onNotification((method, params) => seen.push({ method, ...params }));
  await transport.request('thread/compact/start', { threadId: 'claude-thread', instructions: `Keep:\n${CHECKPOINT}` });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].message.content, `/compact Keep:\n${CHECKPOINT}`);
  assert.ok(seen.some(event => event.method === 'turn/started'));
  await assert.rejects(transport.request('thread/compact/start', { threadId: 'claude-thread' }), /A turn is running/);
});

test('without native compaction, a fresh conversation is seeded with the checkpoint and the last user message', async t => {
  const transport = agent => {
    const request = agent.request.bind(agent);
    agent.request = async (method, params) => {
      if (method === 'thread/compact/start') { agent.calls.push({ method, params }); throw new Error('unsupported'); }
      return request(method, params);
    };
    return agent;
  };
  const { runtimes, log } = await open(t, { transport });
  const main = runtimes[0];
  main.usage(90_000);
  main.finish('ok');
  await until(() => main.started.length === 2, 'the checkpoint turn');
  main.finish(CHECKPOINT);
  await until(() => runtimes.length === 2 && runtimes[1].started.length === 1, 'the fresh conversation');
  const fresh = runtimes[1];
  assert.ok(main.closed);
  assert.ok(fresh.calls.some(call => call.method === 'thread/start'));
  const seeded = promptText(fresh.started[0]);
  assert.ok(seeded.includes(CHECKPOINT));
  assert.ok(seeded.includes("verbatim:\nShip the parser"));
  await until(async () => (await log('compact')).length === 1);
  assert.equal((await log('compact'))[0].via, 'fresh');
  assert.equal((await log('compact.native_failed')).length, 1);
});

test('manual trigger: now when idle, deferred while a turn runs; user words during it wait for its end', async t => {
  const { runtime, main, log } = await open(t);
  assert.deepEqual(runtime.compact('root'), { status: 'deferred' });
  main.finish('ok');
  await until(() => main.started.length === 2, 'the manual checkpoint turn');
  assert.match(promptText(main.started[1]), /The user asked to compact your context/);
  assert.deepEqual(runtime.compact('root'), { status: 'running' });

  // The user writes while main writes its checkpoint: held, not steered into it.
  await runtime.prompt('root', { clientMessageId: 'm2', delivery: 'auto', content: [{ type: 'text', text: 'Also check CI' }] });
  await settle();
  assert.equal(main.steered.length, 0);
  main.finish(CHECKPOINT);
  await until(() => main.calls.some(call => call.method === 'thread/compact/start'));
  main.compact(40_000, 5_000);
  await until(async () => (await log('compact')).length === 1);
  assert.equal((await log('compact'))[0].trigger, 'manual');
  await until(() => main.started.some(call => promptText(call).includes('Also check CI')), 'the held message after the compaction');
});

test('with the supervisor on, its review neither stops nor stalls the compaction, and the user\'s words reach main after', async t => {
  const { directory, root, runs } = await project(t);
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: path.join(directory, 'home'), runLogDir: runs });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'codex:gpt-5.6-sol' });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Ship the parser' }] });
  const main = runtimes[0];
  const log = logOf(runs);
  main.usage(80_000);
  main.finish('turn done');
  await until(() => main.started.some(call => promptText(call).includes('ALP compact checkpoint')), 'the checkpoint turn despite the review');
  // The supervisor's review ends while main writes its checkpoint; its mail waits.
  const supervisor = runtimes.find(agent => agent !== main && agent.started.length);
  if (supervisor?.turnId) supervisor.finish('No findings.');
  await runtime.prompt('root', { clientMessageId: 'm2', delivery: 'auto', content: [{ type: 'text', text: 'Also check CI' }] });
  main.finish(CHECKPOINT);
  await until(() => main.calls.some(call => call.method === 'thread/compact/start'), 'the native compaction after the review');
  const supervisorAgain = runtimes.find(agent => agent !== main && agent.turnId && agent.started.length > 1);
  if (supervisorAgain) supervisorAgain.finish('No findings.');
  main.compact(80_000, 9_000);
  await until(async () => (await log('compact')).length === 1, 'the compaction');
  await until(() => main.started.some(call => promptText(call).includes('Also check CI')), 'the held user message');
  assert.equal(main.steered.filter(text => text.includes('ALP compact checkpoint')).length, 0);
});

test('a runtime that takes the native request but reports nothing, or a fresh conversation refused, fails the compaction and releases main', async t => {
  const transport = agent => {
    const request = agent.request.bind(agent);
    agent.request = async (method, params) => {
      if (method === 'thread/compact/start') { agent.calls.push({ method, params }); throw new Error('unsupported'); }
      return request(method, params);
    };
    return agent;
  };
  const { runtimes, runtime, log } = await open(t, { transport });
  const main = runtimes[0];
  // An assignment runs, so a fresh conversation would lose it.
  await main.call('alp_delegate', { agent: 'peer', task: 'Long work', wait: false });
  main.usage(90_000);
  main.finish('ok');
  await until(() => main.started.length === 2, 'the checkpoint turn');
  await runtime.prompt('root', { clientMessageId: 'm2', delivery: 'auto', content: [{ type: 'text', text: 'Status?' }] });
  main.finish(CHECKPOINT);
  await until(async () => (await log('compact.failed')).length === 1, 'the refused fresh conversation');
  assert.match((await log('compact.failed'))[0].error, /Assignments are still running/);
  await until(() => main.started.some(call => promptText(call).includes('Status?')), 'the held message after the failure');
});
