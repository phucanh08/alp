// t-ca1f: only the user clears a human gate. A process an ALP agent started carries
// ALP_AGENT_SESSION; the CLI refuses it, and a clear made by editing the task file is detected
// and undone. (The daemon's refusal is in packages/daemon/tests/gate-authority.test.js.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../../packages/core/src/init.js';
import { addGate, closeTask, compactTasks, createTask, gateOpen, loadTasks, resolveGate, updateTask } from '../../packages/core/src/tasks.js';
import { pourFormula } from '../../packages/core/src/formulas.js';
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

test('a formula human step and an older human gate are ledgered too; an unreadable ledger blocks clears, never reads', async t => {
  const { root, home, run } = await setup(t);
  const formula = { formula: 'ship', description: '', vars: {}, steps: [{ id: 'build', title: 'Build', type: 'task', needs: [] }, { id: 'approve', title: 'Approve the release', type: 'human', needs: ['build'] }] };
  const poured = await pourFormula(root, formula, {}, 'main');
  const step = (await loadTasks(root)).tasks.find(task => task.step?.human);
  assert.ok(step, JSON.stringify(poured));
  let data = JSON.parse(await readFile(taskFile(root, step.id), 'utf8'));
  data.gates[0].resolved = { at: new Date().toISOString(), by: 'user' };
  data.status = 'closed';
  data.closed = { at: new Date().toISOString(), by: 'user', reason: 'done', summary: 'forged' };
  await writeFile(taskFile(root, step.id), JSON.stringify(data));
  const reopened = (await loadTasks(root)).tasks.find(task => task.id === step.id);
  assert.ok(gateOpen(reopened.gates[0]) && reopened.gates[0].tampered);
  assert.equal(reopened.status, 'open');

  // A human gate written before the ledger existed enters it the next time ALP writes its task.
  const old = await createTask(root, { title: 'Old' }, 'main');
  data = JSON.parse(await readFile(taskFile(root, old.id), 'utf8'));
  data.gates = [{ id: 'g1', kind: 'human', note: 'Old approval', at: new Date().toISOString(), by: 'main' }];
  await writeFile(taskFile(root, old.id), JSON.stringify(data));
  await updateTask(root, old.id, { note: 'touch' }, 'main');
  data = JSON.parse(await readFile(taskFile(root, old.id), 'utf8'));
  data.gates[0].resolved = { at: new Date().toISOString(), by: 'user' };
  await writeFile(taskFile(root, old.id), JSON.stringify(data));
  assert.ok((await loadTasks(root)).tasks.find(task => task.id === old.id).gates[0].tampered);

  // Compaction keeps what names a gate in the ledger: a compacted closed task is not taken for tampering.
  const shelved = await createTask(root, { title: 'Shelved' }, 'main');
  await addGate(root, shelved.id, { kind: 'human', note: 'Never asked' }, 'main');
  await closeTask(root, shelved.id, { reason: 'wontfix' }, 'user');
  await compactTasks(root, { days: 0 }, 'user');
  const compacted = (await loadTasks(root)).tasks.find(task => task.id === shelved.id);
  assert.ok(compacted.compacted && !compacted.gates[0].tampered, JSON.stringify(compacted.gates));
  assert.equal(compacted.status, 'closed');

  // A corrupt ledger: reads go on (detecting nothing), a clear refuses rather than overwrite it.
  const fresh = await createTask(root, { title: 'Fresh' }, 'main');
  await addGate(root, fresh.id, { kind: 'human', note: 'Fresh approval' }, 'main');
  const [ledger] = await readdir(path.join(home, 'gates'));
  await writeFile(path.join(home, 'gates', ledger), '{not json');
  assert.ok((await loadTasks(root)).tasks.length >= 3);
  const refused = run({}, 'task', 'gate', 'clear', fresh.id, 'g1');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /gate ledger .* unreadable/);
  assert.equal(await readFile(path.join(home, 'gates', ledger), 'utf8'), '{not json');
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

// t-f438: closing a task is no way around its human gate.
test('the CLI under an ALP agent refuses to close a task with an open human gate or a human step; the user closes it, overriding the gate', async t => {
  const { root, home, run } = await setup(t);
  const task = await createTask(root, { title: 'Release' }, 'main');
  await addGate(root, task.id, { kind: 'human', note: 'Ship it?' }, 'main');
  for (const reason of ['done', 'wontfix', 'superseded', 'duplicate']) {
    const refused = run({ ALP_AGENT_SESSION: '1' }, 'task', 'close', task.id, '--reason', reason);
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.match(refused.stderr, /Only the user closes/);
  }
  // Core refuses any closer that is not the user, whatever the caller says.
  await assert.rejects(closeTask(root, task.id, { reason: 'wontfix' }, 'main'), error => error.code === 'GATE_USER_ONLY');
  await assert.rejects(closeTask(root, task.id, { reason: 'wontfix', agent: true }, 'user'), error => error.code === 'GATE_USER_ONLY');
  assert.equal((await loadTasks(root)).tasks[0].status, 'open');

  const formula = { formula: 'ship', description: '', vars: {}, steps: [{ id: 'approve', title: 'Approve', type: 'human', needs: [] }] };
  await pourFormula(root, formula, {}, 'main');
  const step = (await loadTasks(root)).tasks.find(entry => entry.step?.human);
  const stepRefused = run({ ALP_AGENT_SESSION: '1' }, 'task', 'close', step.id);
  assert.notEqual(stepRefused.status, 0);
  assert.match(stepRefused.stderr, /Only the user closes/);

  // The user's CLI closes: the gate is recorded overridden, in the ledger too, so it is no tampering.
  const closed = run({}, 'task', 'close', task.id, '--reason', 'wontfix');
  assert.equal(closed.status, 0, closed.stderr);
  const after = (await loadTasks(root)).tasks.find(entry => entry.id === task.id);
  assert.equal(after.status, 'closed');
  assert.deepEqual([after.gates[0].resolved.by, after.gates[0].resolved.overridden, after.gates[0].resolved.channel, !!after.gates[0].tampered], ['user', true, 'cli', false]);
  assert.ok(after.log.some(entry => entry.event === 'gate overridden'));
  const [ledgerName] = await readdir(path.join(home, 'gates'));
  const ledger = JSON.parse(await readFile(path.join(home, 'gates', ledgerName), 'utf8'));
  assert.equal(ledger.gates[`${task.id}/g1@${after.gates[0].at}`].resolved.channel, 'cli');
  assert.equal(run({}, 'task', 'close', step.id).status, 0);
  assert.equal((await loadTasks(root)).tasks.find(entry => entry.id === step.id).status, 'closed');
});

test('compaction drops cleared gate ledger entries and keeps every open one, even of a closed or missing task', async t => {
  const { root, home } = await setup(t);
  const open = await createTask(root, { title: 'Still waiting' }, 'main');
  await addGate(root, open.id, { kind: 'human', note: 'Wait' }, 'main');
  const cleared = await createTask(root, { title: 'Cleared' }, 'main');
  await addGate(root, cleared.id, { kind: 'human', note: 'OK?' }, 'main');
  await resolveGate(root, cleared.id, 'g1', { by: 'user', channel: 'cli' });
  const forced = await createTask(root, { title: 'Forced' }, 'main');
  await addGate(root, forced.id, { kind: 'human', note: 'Sure?' }, 'main');
  await closeTask(root, forced.id, { reason: 'wontfix' }, 'user');
  // An agent edits a task to closed, and deletes another, hoping compaction forgets their gates.
  const edited = await createTask(root, { title: 'Edited closed' }, 'main');
  await addGate(root, edited.id, { kind: 'human', note: 'Edited' }, 'main');
  const editedFile = await readFile(taskFile(root, edited.id), 'utf8');
  await writeFile(taskFile(root, edited.id), JSON.stringify({ ...JSON.parse(editedFile), status: 'closed', closed: { at: new Date().toISOString(), by: 'user', reason: 'wontfix' } }));
  const gone = await createTask(root, { title: 'Gone' }, 'main');
  await addGate(root, gone.id, { kind: 'human', note: 'Gone?' }, 'main');
  const goneFile = await readFile(taskFile(root, gone.id), 'utf8');
  await rm(taskFile(root, gone.id));

  const [name] = await readdir(path.join(home, 'gates'));
  const entries = async () => Object.keys(JSON.parse(await readFile(path.join(home, 'gates', name), 'utf8')).gates).map(key => key.split('/')[0]).sort();
  assert.equal((await entries()).length, 5);
  await compactTasks(root, { days: 30 }, 'user');
  assert.deepEqual(await entries(), [open.id, edited.id, gone.id].sort());
  // Each open gate still detects a forged clear afterwards.
  const forge = async (id, text) => { const data = JSON.parse(text); data.status = 'open'; data.closed = null; data.gates[0].resolved = { at: new Date().toISOString(), by: 'user' }; await writeFile(taskFile(root, id), JSON.stringify(data)); };
  await forge(open.id, await readFile(taskFile(root, open.id), 'utf8'));
  await forge(edited.id, editedFile);
  await forge(gone.id, goneFile);
  const { tasks } = await loadTasks(root);
  for (const id of [open.id, edited.id, gone.id]) assert.ok(tasks.find(entry => entry.id === id).gates[0].tampered, id);
});
