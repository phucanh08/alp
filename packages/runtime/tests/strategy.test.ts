import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { createAlpRuntime, claudeToolShapes } from '@anhlp/alp-runtime';
import { teardown } from '../../../test/support/teardown.ts';

// alp_strategy (t-003a): main and lead record a strategy (rush, smart, deep, large). It is guidance
// only: one change per root user turn, logged, and nothing else about the session changes.

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

let calls = 0;
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get config() { return this.calls.find(call => call.method === 'thread/start')?.params; },
      get tools() { return this.config.dynamicTools.map(tool => tool.name); },
      async call(tool, args, callId = `${tool}-${index}-${++calls}`) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function setup(t, settings) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-strategy-'));
  // Removed last: teardown runs in reverse, so the runtime (still writing its run log) stops first.
  defer(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify(settings));
  const runtimes = [];
  const runLogDir = path.join(directory, 'runs');
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: path.join(directory, 'home'), runLogDir });
  defer(() => runtime.shutdown());
  const prompt = (id, text) => runtime.prompt('root', { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text }] });
  const runLog = async () => (await readFile(path.join(runLogDir, 'root.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, runtime, runtimes, prompt, runLog };
}

/** Starts one assignment from `from` and returns its fake native runtime once its turn runs. */
async function delegate(runtimes, from, agent, extra = {}) {
  const before = runtimes.length;
  const started = await from.call('alp_delegate', { agent, task: `Work as ${agent}`, wait: false, ...extra });
  assert.ok(started.assignmentId, JSON.stringify(started));
  await until(() => runtimes.length > before && runtimes.at(-1).turnId);
  return runtimes.at(-1);
}

test('alp_strategy is offered to main and lead only, never to peer, oracle, reviewer or supervisor', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t, { workflow: { mode: 'cafe', supervisor: true } });
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2 && runtimes[1].config);
  const [main, supervisor] = runtimes;
  await prompt('m1', 'Work');
  await until(() => main.turnId);
  const lead = await delegate(runtimes, main, 'lead');
  const peer = await delegate(runtimes, lead, 'peer');
  const oracle = await delegate(runtimes, lead, 'oracle', { mode: 'read-only', model: 'claude:claude-fable-5-1' });
  const reviewer = await delegate(runtimes, lead, 'reviewer', { mode: 'read-only' });
  assert.ok(main.tools.includes('alp_strategy'));
  assert.ok(lead.tools.includes('alp_strategy'));
  for (const [name, harness] of Object.entries({ peer, oracle, reviewer, supervisor })) {
    assert.equal(harness.tools.includes('alp_strategy'), false, `${name} must not get alp_strategy`);
  }
  // The Claude schema matches what the runtime offers.
  const offered = main.config.dynamicTools.find(tool => tool.name === 'alp_strategy');
  assert.deepEqual(Object.keys(claudeToolShapes.alp_strategy).sort(), Object.keys(offered.inputSchema.properties).sort());
  assert.deepEqual(offered.inputSchema.properties.strategy.enum, ['rush', 'smart', 'deep', 'large']);
  assert.doesNotMatch(offered.description, /\bmode\b/);
  // A role without the tool is refused even when it calls it by name.
  assert.match((await peer.call('alp_strategy', { strategy: 'deep', reason: 'Hard bug' })).error, /Only main and lead/);
  assert.match((await reviewer.call('alp_strategy', { strategy: 'deep', reason: 'Hard bug' })).error, /Only main and lead/);
});

test('alp_strategy in Phở: main has it, a peer does not', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t, { workflow: { mode: 'pho', supervisor: false } });
  await runtime.open('root', { cwd: root });
  await prompt('m1', 'Work');
  await until(() => runtimes[0]?.turnId);
  const [main] = runtimes;
  assert.ok(main.tools.includes('alp_strategy'));
  const peer = await delegate(runtimes, main, 'peer');
  assert.equal(peer.tools.includes('alp_strategy'), false);
});

test('alp_strategy refuses an unknown strategy and a missing or blank reason', async t => {
  const { root, runtime, runtimes, prompt, runLog } = await setup(t, { workflow: { mode: 'pho', supervisor: false } });
  await runtime.open('root', { cwd: root });
  await prompt('m1', 'Work');
  await until(() => runtimes[0]?.turnId);
  const [main] = runtimes;
  assert.match((await main.call('alp_strategy', { strategy: 'turbo', reason: 'Fast' })).error, /one of rush, smart, deep, large/);
  assert.match((await main.call('alp_strategy', { strategy: 'mode', reason: 'Fast' })).error, /one of rush, smart, deep, large/);
  assert.match((await main.call('alp_strategy', { strategy: 'deep' })).error, /reason is required/);
  assert.match((await main.call('alp_strategy', { strategy: 'deep', reason: '   ' })).error, /reason is required/);
  assert.match((await main.call('alp_strategy', { strategy: 'deep', reason: 'x'.repeat(301) })).error, /reason is required/);
  assert.match((await main.call('alp_strategy', { strategy: 'deep', reason: 'Why', model: 'claude:fable' })).error, /one of rush/);
  // None of the refusals counted as the turn's change.
  assert.deepEqual(await main.call('alp_strategy', { strategy: 'deep', reason: 'Race in the scheduler' }), { strategy: 'deep', previous: 'smart', reason: 'Race in the scheduler' });
  await until(async () => (await runLog()).some(entry => entry.event === 'strategy'));
  assert.equal((await runLog()).filter(entry => entry.event === 'strategy').length, 1);
});

test('one strategy change per user turn: a second is refused, a new user turn allows it; it is logged and nothing else changes', async t => {
  const { root, runtime, runtimes, prompt, runLog } = await setup(t, { workflow: { mode: 'cafe', supervisor: false } });
  await runtime.open('root', { cwd: root });
  await prompt('m1', 'Fix the flaky scheduler');
  await until(() => runtimes[0]?.turnId);
  const [main] = runtimes;
  const lead = await delegate(runtimes, main, 'lead');
  const before = runtime.status('root');
  const sessionsBefore = before.sessions.map(({ id, agent, runtime: kind, model, mode, thinking, workflow, teamLabel }) => ({ id, agent, kind, model, mode, thinking, workflow, teamLabel }));
  const harnesses = runtimes.length;

  // Choosing the current strategy is not a change.
  assert.deepEqual(await main.call('alp_strategy', { strategy: 'smart', reason: 'Default fits' }), { strategy: 'smart', unchanged: true });
  assert.equal((await main.call('alp_strategy', { strategy: 'deep', reason: 'Concurrency bug' })).strategy, 'deep');
  const second = await main.call('alp_strategy', { strategy: 'large', reason: 'Touches many modules' });
  assert.match(second.error, /already changed in this user turn \(to deep: Concurrency bug\)\. Keep deep/);
  // The lead has its own strategy and its own change in the same root turn.
  assert.equal((await lead.call('alp_strategy', { strategy: 'rush', reason: 'One small fix' })).strategy, 'rush');
  assert.match((await lead.call('alp_strategy', { strategy: 'deep', reason: 'Harder than it looked' })).error, /already changed in this user turn/);

  // Nothing but the strategy changed: no model, effort, mode, team, session or assignment.
  const after = runtime.status('root');
  assert.deepEqual(after.sessions.map(({ id, agent, runtime: kind, model, mode, thinking, workflow, teamLabel }) => ({ id, agent, kind, model, mode, thinking, workflow, teamLabel })), sessionsBefore);
  assert.equal(after.assignments.length, before.assignments.length);
  assert.equal(runtimes.length, harnesses);
  assert.equal(runtimes.some(harness => harness.calls.some(call => call.method === 'thread/start' && call !== harness.calls.find(c => c.method === 'thread/start'))), false);

  // In the run log, with its reason.
  await until(async () => (await runLog()).filter(entry => entry.event === 'strategy').length === 2);
  const logged = (await runLog()).filter(entry => entry.event === 'strategy');
  assert.deepEqual(logged.map(({ agent, strategy, previous, reason }) => ({ agent, strategy, previous, reason })), [
    { agent: 'main', strategy: 'deep', previous: 'smart', reason: 'Concurrency bug' },
    { agent: 'lead', strategy: 'rush', previous: 'smart', reason: 'One small fix' },
  ]);
  assert.deepEqual(logged.map(entry => entry.sessionId), ['root', after.sessions.find(session => session.agent === 'lead').id]);
  assert.ok(logged.every(entry => typeof entry.ts === 'string'));

  // A new user turn of the root allows one more change, for main and for lead.
  main.finish('Planned');
  await until(() => !runtime.status('root').sessions[0].activeTurnId);
  await prompt('m2', 'It touches the CLI and the daemon too');
  await until(() => main.turnId?.endsWith('-2'));
  assert.deepEqual(await main.call('alp_strategy', { strategy: 'large', reason: 'Spans CLI and daemon' }), { strategy: 'large', previous: 'deep', reason: 'Spans CLI and daemon' });
  assert.match((await main.call('alp_strategy', { strategy: 'smart', reason: 'Back' })).error, /already changed in this user turn/);
});

test('a main reopened after a restart keeps the strategy its run log recorded, and may change it in its next turn', async t => {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-strategy-'));
  defer(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ workflow: { mode: 'pho', supervisor: false } }));
  const runLogDir = path.join(directory, 'runs');
  const start = () => {
    const runtimes = [];
    const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: path.join(directory, 'home'), runLogDir });
    return { runtime, runtimes };
  };
  const first = start();
  await first.runtime.open('root', { cwd: root });
  await first.runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
  await until(() => first.runtimes[0]?.turnId);
  assert.equal((await first.runtimes[0].call('alp_strategy', { strategy: 'deep', reason: 'Security bug' })).strategy, 'deep');
  await first.runtime.shutdown();

  const second = start();
  defer(() => second.runtime.shutdown());
  await second.runtime.open('root', { cwd: root });
  await second.runtime.prompt('root', { clientMessageId: 'm2', delivery: 'auto', content: [{ type: 'text', text: 'Go on' }] });
  await until(() => second.runtimes[0]?.turnId);
  const [main] = second.runtimes;
  assert.deepEqual(await main.call('alp_strategy', { strategy: 'deep', reason: 'Still deep' }), { strategy: 'deep', unchanged: true });
  assert.deepEqual(await main.call('alp_strategy', { strategy: 'smart', reason: 'Root cause found' }), { strategy: 'smart', previous: 'deep', reason: 'Root cause found' });
});

test('a steer is a new user turn: it allows the next strategy change', async t => {
  const { root, runtime, runtimes, runLog } = await setup(t, { workflow: { mode: 'pho', supervisor: false } });
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
  await until(() => runtimes[0]?.turnId);
  const [main] = runtimes;
  assert.equal((await main.call('alp_strategy', { strategy: 'rush', reason: 'Small' })).strategy, 'rush');
  assert.match((await main.call('alp_strategy', { strategy: 'deep', reason: 'Not small' })).error, /already changed/);
  await runtime.prompt('root', { clientMessageId: 's1', delivery: 'steer', content: [{ type: 'text', text: 'It is a security issue' }] });
  assert.equal((await main.call('alp_strategy', { strategy: 'deep', reason: 'Security' }, 'after-steer')).strategy, 'deep');
  await until(async () => (await runLog()).filter(entry => entry.event === 'strategy').length === 2);
});
