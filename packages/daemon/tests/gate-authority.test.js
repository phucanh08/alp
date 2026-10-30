// t-ca1f: a connection an ALP agent opened (it says so in daemon.hello) may not clear a human
// gate or answer a question for the user; the user's own connection still may.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { addGate, createTask, loadTasks } from '@anhlp/alp-core/tasks';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';

function fakeTransport() {
  return () => ({
    async initialize() {}, onNotification() {}, onFailure() {}, onRequest() {}, async close() {},
    async request(method) { return method.startsWith('thread/') ? { thread: { id: 'thread-1' } } : {}; },
  });
}

async function connectAs(socket, agent) {
  const saved = process.env.ALP_AGENT_SESSION;
  if (agent) process.env.ALP_AGENT_SESSION = '1'; else delete process.env.ALP_AGENT_SESSION;
  try { return await connect(socket, { name: 'gate-test', version: '0' }); }
  finally { if (saved === undefined) delete process.env.ALP_AGENT_SESSION; else process.env.ALP_AGENT_SESSION = saved; }
}

test('an agent connection cannot clear a human gate or answer a question; the user can', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const savedHome = process.env.ALP_HOME;
  process.env.ALP_HOME = path.join(directory, 'alp-home');
  t.after(() => { if (savedHome === undefined) delete process.env.ALP_HOME; else process.env.ALP_HOME = savedHome; });
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const project = path.join(directory, 'project');
  await initProject(project);
  const runtime = createAlpRuntime({ transport: fakeTransport(), libraryDir: home });
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(directory).socket, version: 'test', home });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); });

  const task = await createTask(project, { title: 'Release' }, 'main');
  await addGate(project, task.id, { kind: 'human', note: 'Ship it?' }, 'main');
  await addGate(project, task.id, { kind: 'timer', until: '+3d' }, 'main');

  const agent = await connectAs(daemonPaths(directory).socket, true);
  t.after(() => agent.close());
  const refused = error => { assert.equal(error.code, 1003, error.message + JSON.stringify(error.data)); assert.equal(error.data?.reason, 'user_only'); return true; };
  await assert.rejects(agent.request('task.gate.resolve', { projectRoot: project, id: task.id, gate: 'g1' }), refused);
  await assert.rejects(agent.request('task.gate.resolve', { projectRoot: project, id: task.id, gate: 'g1', reject: true, note: 'no' }), refused);
  await assert.rejects(agent.request('question.answer', { questionId: 'q-any', text: 'yes' }), refused);
  // A daemon shell carries no mark: an agent may not open, attach to or type into one.
  await assert.rejects(agent.request('terminal.create', { workspaceId: 'w', cols: 80, rows: 24, requestId: 'r1' }), refused);
  await assert.rejects(agent.request('terminal.attach', { terminalId: 'term_' + '0'.repeat(32) }), refused);
  await assert.rejects(agent.request('terminal.input', { terminalId: 'term_' + '0'.repeat(32), data: 'alp answer q yes\n' }), refused);
  // A second hello does not shed the mark.
  await agent.request('daemon.hello', { protocolVersion: 1 });
  await assert.rejects(agent.request('task.gate.resolve', { projectRoot: project, id: task.id, gate: 'g1' }), refused);
  // A gate that is not human stays the agent's to clear.
  await agent.request('task.gate.resolve', { projectRoot: project, id: task.id, gate: 'g2' });
  assert.ok(!(await loadTasks(project)).tasks[0].gates[0].resolved);

  const user = await connectAs(daemonPaths(directory).socket, false);
  t.after(() => user.close());
  await user.request('task.gate.resolve', { projectRoot: project, id: task.id, gate: 'g1', note: 'OK' });
  const gate = (await loadTasks(project)).tasks[0].gates[0];
  assert.deepEqual([gate.resolved.by, gate.resolved.channel], ['user', 'web']);
  // The user's answer reaches the lookup (no such question), not the refusal.
  await assert.rejects(user.request('question.answer', { questionId: 'q-any', text: 'yes' }), error => error.code === 1001);
});

test('an agent connection cannot close a task with an open human gate; the user closes it, overriding the gate (t-f438)', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-close-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const savedHome = process.env.ALP_HOME;
  process.env.ALP_HOME = path.join(directory, 'alp-home');
  t.after(() => { if (savedHome === undefined) delete process.env.ALP_HOME; else process.env.ALP_HOME = savedHome; });
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const project = path.join(directory, 'project');
  await initProject(project);
  const runtime = createAlpRuntime({ transport: fakeTransport(), libraryDir: home });
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(directory).socket, version: 'test', home });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); });

  const task = await createTask(project, { title: 'Release' }, 'main');
  await addGate(project, task.id, { kind: 'human', note: 'Ship it?' }, 'main');
  const agent = await connectAs(daemonPaths(directory).socket, true);
  t.after(() => agent.close());
  await assert.rejects(agent.request('task.update', { projectRoot: project, id: task.id, action: 'close' }), error => error.code === 1003 && error.data?.reason === 'user_only');
  assert.equal((await loadTasks(project)).tasks[0].status, 'open');

  const user = await connectAs(daemonPaths(directory).socket, false);
  t.after(() => user.close());
  await user.request('task.update', { projectRoot: project, id: task.id, action: 'close' });
  const closed = (await loadTasks(project)).tasks[0];
  assert.equal(closed.status, 'closed');
  assert.deepEqual([closed.gates[0].resolved.overridden, closed.gates[0].resolved.channel, !!closed.gates[0].tampered], [true, 'web', false]);
});
