// alpd's liveness and readiness (ALPD §67): alive means it answers; ready means it accepts
// connections and can read and write its state now. Not ready is reported with the same codes
// the log carries, and clears when the disk does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-health-'));
  const state = path.join(directory, 'state');
  const runtime = createAlpRuntime({ runLogDir: path.join(directory, 'runs') });
  const store = createStore(state);
  const socketPath = path.join(directory, 'd.sock');
  const server = createDaemonServer({ runtime, socketPath, version: 'test', store });
  await server.listen();
  const client = await connect(socketPath, { name: 'test', version: '0' });
  t.after(async () => { client.close(); await server.close().catch(() => {}); await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });
  /** Replaces the state directory with a file, as a broken mount or a full disk would stop it being used; returns the undo. */
  const breakState = async () => {
    await rename(state, `${state}.away`);
    await writeFile(state, 'not a directory');
    return async () => { await rm(state); await rename(`${state}.away`, state); };
  };
  return { client, store, state, breakState, directory, status: () => client.request('daemon.status') };
}

/** Collects the log lines alpd writes while `work` runs. */
async function logged(t, work) {
  const lines = [];
  t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true; });
  try { await work(); } finally { t.mock.restoreAll(); }
  return lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

test('a fresh alpd is live and ready, with each check reported', async t => {
  const { status } = await setup(t);
  const { health, persistence } = await status();
  assert.equal(health.live, true);
  assert.equal(health.ready, true);
  assert.deepEqual(health.checks.map(check => [check.id, check.ok]), [['accepting', true], ['state', true], ['persistence', true]]);
  assert.equal(persistence.ok, true);
});

test('an unusable state directory makes alpd live but not ready, and ready again once it is back', async t => {
  const { status, breakState } = await setup(t);
  const undo = await breakState();
  const broken = (await status()).health;
  assert.equal(broken.live, true);
  assert.equal(broken.ready, false);
  const state = broken.checks.find(check => check.id === 'state');
  assert.equal(state.ok, false);
  assert.equal(state.code, 'ALP_STATE_NOT_WRITABLE');
  assert.match(state.message, /ENOTDIR|ENOENT/);
  await undo();
  assert.equal((await status()).health.ready, true);
});

test('a failed write marks alpd not ready until a later write succeeds, and is logged with its code and ids', async t => {
  const { status, store, state } = await setup(t);
  const record = { version: 1, id: 's1', rootId: 'r1', status: 'idle', createdAt: 't', updatedAt: 't' };
  await store.put(record);
  const sessions = path.join(state, 'sessions');
  await rename(sessions, `${sessions}.away`);
  await writeFile(sessions, 'not a directory');
  const records = await logged(t, async () => { await assert.rejects(store.put(record)); await store.flush(); });
  const failure = records.find(entry => entry.code === 'ALP_PERSISTENCE_WRITE_FAILED');
  assert.ok(failure, JSON.stringify(records));
  assert.deepEqual([failure.component, failure.level, failure.sessionId, failure.rootId], ['store', 'error', 's1', 'r1']);
  const failing = (await status()).health;
  assert.equal(failing.ready, false);
  assert.equal(failing.checks.find(check => check.id === 'persistence').code, 'ALP_PERSISTENCE_FAILING');
  await rm(sessions);
  await rename(`${sessions}.away`, sessions);
  await store.put(record);
  assert.equal((await status()).health.ready, true);
  // The history stays: alpd did fail to write once.
  assert.equal((await status()).persistence.failures, 1);
});

test('a daemon without a store is ready when it accepts connections', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-health-'));
  await mkdir(directory, { recursive: true });
  const runtime = createAlpRuntime({ runLogDir: path.join(directory, 'runs') });
  const socketPath = path.join(directory, 'd.sock');
  const server = createDaemonServer({ runtime, socketPath, version: 'test' });
  await server.listen();
  const client = await connect(socketPath, { name: 'test', version: '0' });
  t.after(async () => { client.close(); await server.close(); await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const { health } = await client.request('daemon.status');
  assert.deepEqual([health.live, health.ready, health.checks.map(check => check.id)], [true, true, ['accepting']]);
});
