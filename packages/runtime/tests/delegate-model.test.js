// t-3aad: which model and effort a delegated agent runs on when the requester passes none.
// Order: the requester's model within the target's profiles; the target's single profile; the
// current team's team.json member; the target's agent.json; only then the requester's own,
// which the answer's modelNote says, with where to configure one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { fakeTransport, until } from '../../../test/support/fake-agent.js';
import { createAlpRuntime } from '@anhlp/alp-runtime';

const TEAM = {
  label: 'Lab',
  main: 'main',
  members: {
    main: { model: 'codex:gpt-6.1-sol', thinking: 'high' },
    // The team's choice for helper beats helper's agent.json.
    helper: { role: 'peer', model: 'claude:claude-sonnet-5', thinking: 'low' },
    scout: { role: 'peer' },
    plain: { role: 'peer' },
    peer: { role: 'peer' },
    oracle: { role: 'advisor' },
  },
  delegation: { main: ['helper', 'scout', 'plain', 'peer', 'oracle'] },
  maxPeers: 6,
};

async function agentDir(root, name, config) {
  const directory = path.join(root, '.alp', 'agents', name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'AGENT.md'), `You are ${name}.\n`);
  if (config) await writeFile(path.join(directory, 'agent.json'), JSON.stringify(config));
}

async function lab(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-delegate-model-'));
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), libraryDir: root, supervisor: false });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  await initProject(root, { library: root });
  await mkdir(path.join(root, '.alp/teams/lab'), { recursive: true });
  await writeFile(path.join(root, '.alp/teams/lab/team.json'), JSON.stringify(TEAM));
  await agentDir(root, 'scout', { model: 'claude:claude-haiku-4-5-20251001' });
  await agentDir(root, 'helper', { model: 'codex:gpt-5.6-terra', thinking: 'xhigh' });
  await agentDir(root, 'plain');
  const file = path.join(root, '.alp/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  settings.workflow = { ...settings.workflow, mode: 'lab' };
  // Only peer has profiles: one of each provider, so the requester chooses per assignment.
  settings.team = { ...settings.team, lab: { peer: { profiles: ['claude:*', 'codex:*'] } } };
  await writeFile(file, JSON.stringify(settings));
  await runtime.open('root', { cwd: root });
  const main = agents[0];
  await runtime.prompt('root', { clientMessageId: 'm1', content: [{ type: 'text', text: 'Go' }] });
  return { root, agents, runtime, main };
}

/** A custom delegation graph: no team, so no target has a model profile. */
async function graph(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-delegate-graph-'));
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), libraryDir: root, supervisor: false });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  await agentDir(root, 'scout', { model: 'claude:claude-haiku-4-5-20251001' });
  await agentDir(root, 'helper', { provider: 'claude', model: 'claude-sonnet-5', thinking: 'low' });
  await agentDir(root, 'plain');
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['scout', 'helper', 'plain'] } }));
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol', thinking: 'high' });
  const main = agents[0];
  await runtime.prompt('root', { clientMessageId: 'm1', content: [{ type: 'text', text: 'Go' }] });
  return { root, agents, runtime, main };
}

/** Starts an assignment and returns the answer and the child's thread/start params. */
async function start(agents, main, args) {
  const before = agents.length;
  const answer = await main.call('alp_delegate', { mode: 'read-only', task: 'Inspect A', ...args });
  assert.ok(answer.assignmentId, JSON.stringify(answer));
  await until(() => agents[before]?.started.length, `${args.agent} to start`);
  return { answer, child: agents[before].config };
}

test('a target without profiles runs on its agent.json model, not the requester\'s (t-3aad repro)', async t => {
  const { agents, main } = await graph(t);
  assert.equal(main.config.model, 'gpt-6.1-sol');
  const { answer, child } = await start(agents, main, { agent: 'scout' });
  assert.equal(child.runtime, 'claude', JSON.stringify(answer));
  assert.equal(child.model, 'claude-haiku-4-5-20251001');
  assert.equal(answer.modelNote, undefined);
});

test('the team\'s member model and effort beat agent.json', async t => {
  const { agents, main } = await lab(t);
  const { answer, child } = await start(agents, main, { agent: 'helper' });
  assert.equal(child.runtime, 'claude', JSON.stringify(answer));
  assert.equal(child.model, 'claude-sonnet-5');
  assert.equal(child.thinking, 'low');
});

test('agent.json\'s provider, model and effort apply together', async t => {
  const { agents, main } = await graph(t);
  const { answer, child } = await start(agents, main, { agent: 'helper' });
  assert.deepEqual([child.runtime, child.model, child.thinking], ['claude', 'claude-sonnet-5', 'low'], JSON.stringify(answer));
});

test('with no source the target inherits the requester\'s model and effort, and modelNote says where to configure one', async t => {
  const { agents, main } = await graph(t);
  const { answer, child } = await start(agents, main, { agent: 'plain' });
  assert.equal(child.runtime, 'codex');
  assert.equal(child.model, 'gpt-6.1-sol');
  assert.equal(child.thinking, 'high');
  assert.match(answer.modelNote, /plain runs on your model codex:gpt-6\.1-sol/);
  assert.match(answer.modelNote, /\.plain\.profiles/);
});

test('a passed model still wins for a target without profiles', async t => {
  const { agents, main } = await graph(t);
  const { answer, child } = await start(agents, main, { agent: 'scout', model: 'codex:gpt-5.6-terra', thinking: 'low' });
  assert.equal(child.model, 'gpt-5.6-terra', JSON.stringify(answer));
  assert.equal(child.thinking, 'low');
  assert.equal(answer.modelNote, undefined);
});

test('two peers on different providers each run on the model and effort chosen for them; main keeps its own', async t => {
  const { agents, main, runtime } = await lab(t);
  const a = await start(agents, main, { agent: 'peer', model: 'claude:claude-sonnet-5', thinking: 'medium', modelReason: 'a careful read' });
  const b = await start(agents, main, { agent: 'peer', model: 'codex:gpt-5.6-terra', thinking: 'xhigh', modelReason: 'a plain read' });
  assert.deepEqual([a.child.runtime, a.child.model, a.child.thinking], ['claude', 'claude-sonnet-5', 'medium']);
  assert.deepEqual([b.child.runtime, b.child.model, b.child.thinking], ['codex', 'gpt-5.6-terra', 'xhigh']);
  const snapshot = runtime.snapshot('root');
  assert.equal(snapshot.model, 'gpt-6.1-sol');
  assert.equal(snapshot.thinking, 'high');
});

test('oracle takes a thinking its model offers, refuses another with the list, and keeps high when none is passed', async t => {
  const { agents, main, runtime } = await lab(t);
  const lens = 'claude:claude-fable-5-1';
  const refused = await main.call('alp_delegate', { agent: 'oracle', task: 'Advise', model: lens, thinking: 'huge' });
  assert.match(refused.error, /claude:claude-fable-5-1 takes effort low, medium, high/, JSON.stringify(refused));
  assert.ok(refused.efforts.includes('high') && !refused.efforts.includes('huge'), JSON.stringify(refused));
  const low = await start(agents, main, { agent: 'oracle', task: 'Advise', model: lens, thinking: 'low' });
  assert.equal(low.child.thinking, 'low');
  assert.equal(low.answer.thinkingNote, undefined);
  const fallback = await start(agents, main, { agent: 'oracle', task: 'Advise', model: lens });
  assert.equal(fallback.child.thinking, 'high');
  const snapshot = runtime.snapshot('root');
  assert.equal(snapshot.model, 'gpt-6.1-sol');
  assert.equal(snapshot.thinking, 'high');
});
