// t-ca1f: only the user clears a human gate. A process an ALP agent started carries
// ALP_AGENT_SESSION; the CLI refuses it, and a clear made by editing the task file is detected
// and undone. (The daemon's refusal is in packages/daemon/tests/gate-authority.test.js.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../../packages/core/src/init.js';
import { addGate, createTask, gateOpen, loadTasks, resolveGate } from '../../packages/core/src/tasks.js';
import { createAlpRuntime } from '../../dist/runtime/index.js';

const CLI = fileURLToPath(new URL('../../packages/cli/src/cli.js', import.meta.url));

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  await mkdir(home);
  const saved = process.env.ALP_HOME;
  process.env.ALP_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.ALP_HOME; else process.env.ALP_HOME = saved; });
  const root = path.join(directory, 'project');
  await initProject(root);
  const env = { ...process.env, ALP_HOME: home };
  delete env.ALP_AGENT_SESSION;
  const run = (extra, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...env, ...extra } });
  return { root, home, run };
}

const taskFile = (root, id) => path.join(root, '.alp/tasks', `${id}.json`);

test('the CLI refuses to clear or remove a human gate under an ALP agent; the user still can', async t => {
  const { root, run } = await setup(t);
  const task = await createTask(root, { title: 'Release' }, 'main');
  await addGate(root, task.id, { kind: 'human', note: 'Ship it?' }, 'main');
  await addGate(root, task.id, { kind: 'timer', until: '+3d' }, 'main');
  for (const change of ['clear', 'reject', 'rm']) {
    const refused = run({ ALP_AGENT_SESSION: '1' }, 'task', 'gate', change, task.id, 'g1');
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.match(refused.stderr, /Only the user clears a human gate/);
  }
  assert.ok(gateOpen((await loadTasks(root)).tasks[0].gates[0]));
  // Gates that are not human stay an agent's to clear.
  assert.equal(run({ ALP_AGENT_SESSION: '1' }, 'task', 'gate', 'clear', task.id, 'g2').status, 0);
  const answered = run({ ALP_AGENT_SESSION: '1' }, 'answer', 'q-any', 'yes');
  assert.notEqual(answered.status, 0);
  assert.match(answered.stderr, /Only the user answers a question/);

  const cleared = run({}, 'task', 'gate', 'clear', task.id, 'g1', '-m', 'OK');
  assert.equal(cleared.status, 0, cleared.stderr);
  const gate = (await loadTasks(root)).tasks[0].gates[0];
  assert.deepEqual([gate.resolved.by, gate.resolved.channel], ['user', 'cli']);
  assert.ok(!gate.tampered);
});

test('a human gate cleared or removed by editing the task file opens again, marked tampered', async t => {
  const { root, run } = await setup(t);
  const forged = await createTask(root, { title: 'Forged clear' }, 'main');
  await addGate(root, forged.id, { kind: 'human', note: 'Approve?' }, 'main');
  const removed = await createTask(root, { title: 'Forged removal' }, 'main');
  await addGate(root, removed.id, { kind: 'human', note: 'Approve too?' }, 'main');
  const legit = await createTask(root, { title: 'Real clear' }, 'user');
  await addGate(root, legit.id, { kind: 'human', note: 'Fine?' }, 'main');
  await resolveGate(root, legit.id, 'g1', { by: 'user', channel: 'cli' });

  let data = JSON.parse(await readFile(taskFile(root, forged.id), 'utf8'));
  data.gates[0].resolved = { at: new Date().toISOString(), by: 'user', channel: 'cli' };
  await writeFile(taskFile(root, forged.id), JSON.stringify(data));
  data = JSON.parse(await readFile(taskFile(root, removed.id), 'utf8'));
  data.gates = [];
  await writeFile(taskFile(root, removed.id), JSON.stringify(data));

  const { tasks } = await loadTasks(root);
  const byId = id => tasks.find(task => task.id === id);
  assert.ok(gateOpen(byId(forged.id).gates[0]));
  assert.ok(byId(forged.id).gates[0].tampered);
  assert.equal(byId(forged.id).gates[0].note, 'Approve?');
  assert.ok(gateOpen(byId(removed.id).gates[0]));
  assert.deepEqual(byId(removed.id).gates[0].tampered, { removed: true });
  assert.ok(!gateOpen(byId(legit.id).gates[0]));
  // The reopened gate still holds the task, and the user clears it the usual way.
  assert.match(run({}, 'task', 'show', forged.id).stdout, /changed outside ALP/);
  assert.equal(run({}, 'task', 'gate', 'clear', forged.id, 'g1').status, 0);
  assert.ok(!gateOpen((await loadTasks(root)).tasks.find(task => task.id === forged.id).gates[0]));
  // A user removal through ALP is not taken for tampering.
  assert.equal(run({}, 'task', 'gate', 'rm', removed.id, 'g1').status, 0);
  assert.equal((await loadTasks(root)).tasks.find(task => task.id === removed.id).gates.length, 0);
});

test('every agent process ALP starts carries ALP_AGENT_SESSION', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gate-env-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  const seen = [];
  const transport = (_cwd, env) => {
    seen.push(env);
    return {
      async initialize() {}, onNotification() {}, onFailure() {}, onRequest() {}, async close() {},
      async request(method) { return method.startsWith('thread/') ? { thread: { id: `thread-${seen.length}` } } : {}; },
    };
  };
  const runtime = createAlpRuntime({ transport, environment: { PATH: process.env.PATH }, libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'), boardDir: path.join(directory, 'boards') });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await runtime.open('root', { cwd: root });
  assert.ok(seen.length >= 1);
  for (const env of seen) assert.equal(env.ALP_AGENT_SESSION, '1');
});
