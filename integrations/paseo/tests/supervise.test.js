import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';
import { bootTime, connect, daemonPaths, lockAlive, readLock } from '@anhlp/alp-client';
import { daemonHeld, holdDaemon, startDaemon, superviseDaemon } from '@anhlp/alp-client/supervise';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { createProvider, daemonEntry } from '@anhlp/alp-paseo';

const ENTRY = fileURLToPath(new URL('../../../packages/daemon/dist/alpd.js', import.meta.url));

async function until(check, what = 'condition', ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(`Expected ${what} did not arrive`);
}

/** alpd forces its own exit 10 s after a shutdown begins; one that has not stopped (or come up) by then is stuck. */
const STOP_MS = 20_000;
/** Longer than an alpd launched before the supervisor stopped takes to reach its lock under load (about 2 s seen). */
const QUIET_MS = 3_000;

/**
 * Stops every alpd of `home` until none has held the lock for QUIET_MS. One may still be starting:
 * the supervisor can launch an alpd while the test starts its own, and under load that one takes
 * the lock only after the test's has let go of it. An alpd is asked to stop once it listens (asked
 * again if asking failed), and killed if it has not stopped STOP_MS after it was first seen, so
 * none outlives the test (#117: a stop asked of an alpd still starting failed silently, and the
 * teardown then waited for a stop nobody had asked for, and left that alpd running).
 */
async function shutdown(home) {
  let current;
  for (let quiet = Date.now(); Date.now() - quiet < QUIET_MS;) {
    const lock = await readLock(home).catch(() => undefined);
    if (lockAlive(lock)) {
      quiet = Date.now();
      if (current?.pid !== lock.pid) current = { pid: lock.pid, since: Date.now(), asked: false };
      if (lock.ready && !current.asked) {
        current.asked = await connect(lock.socket).then(client => client.request('daemon.shutdown').finally(() => client.close())).then(() => true, () => false);
      }
      if (Date.now() - current.since > STOP_MS) { try { process.kill(lock.pid, 'SIGKILL'); } catch {} }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('the plugin keeps alpd up: started with Paseo, started again after a crash, left alone after alp daemon stop', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-keep-'));
  const logged = [];
  // Two misses must take longer than alpd takes to start, as with the real 5 s interval.
  const stop = superviseDaemon({ home, entry: ENTRY, intervalMs: 600, by: 'Paseo', log: message => logged.push(message) });
  // The home goes even if stopping failed: an alpd whose lock is gone stops at its next heartbeat.
  t.after(async () => {
    try { await stop(); } finally {
      try { await shutdown(home); } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
  });
  await stop.started;
  const first = await readLock(home);
  assert.ok(lockAlive(first) && first.ready);
  assert.deepEqual(logged, ['alpd started with Paseo']);

  // The alpd of this test's own home, killed as a crash would.
  process.kill(first.pid, 'SIGKILL');
  await until(async () => { const lock = await readLock(home); return lockAlive(lock) && lock.ready && lock.pid !== first.pid; }, 'a new alpd');
  await until(() => logged.length === 2, 'the restart to be logged');
  assert.equal(logged[1], 'alpd was down; started it again');

  // A deliberate stop holds it down.
  await holdDaemon(home);
  const { socket } = await readLock(home);
  await connect(socket).then(client => client.request('daemon.shutdown').finally(() => client.close()));
  await until(async () => !lockAlive(await readLock(home)), 'alpd to stop');
  await new Promise(resolve => setTimeout(resolve, 2_000));
  assert.equal(lockAlive(await readLock(home)), false);
  assert.equal(await daemonHeld(home), true);

  // Asking for it lifts the hold.
  await startDaemon({ home, entry: ENTRY });
  assert.equal(await daemonHeld(home), false);
  assert.ok(lockAlive(await readLock(home)));
});

function fakeRuntime(runtimes) {
  return () => {
    let notification;
    const runtime = {
      calls: [],
      initialize: async () => {},
      onNotification(fn) { notification = fn; }, onFailure() {}, onRequest() {},
      notify(method, params) { notification(method, params); },
      async close() {},
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: 'native-thread', turns: [] }, cwd: params.cwd, model: params.model, reasoningEffort: 'low' };
        if (method === 'turn/start') return { turn: { id: `turn-${runtimes.length}-${this.calls.length}` } };
        return {};
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

test('a Paseo connection survives alpd going away: it reconnects, and the next prompt reopens its session', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-relink-'));
  const home = path.join(directory, 'home');
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.alp', 'agents', 'main'), { recursive: true });
  await writeFile(path.join(root, '.alp', 'agents', 'main', 'AGENT.md'), 'Agent main');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const runtimes = [];
  const daemons = [];
  const { socket } = daemonPaths(home);
  // The provider starts alpd when its home has none. This test's alpd runs in-process, so any start
  // is a fault: the provider gets an entry that records the start and fails, never a real alpd,
  // which would outlive the test detached in this home (t-c5e7). The record outlives the home.
  const record = await mkdtemp(path.join(tmpdir(), 'alp-relink-record-'));
  const launches = path.join(record, 'launches.log');
  const entry = path.join(record, 'alpd-stub.mjs');
  await writeFile(entry, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(launches)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(1);\n`);
  const launched = () => readFile(launches, 'utf8').then(text => text.split('\n').filter(Boolean), error => { if (error.code === 'ENOENT') return []; throw error; });
  // An alpd in this process over a durable store; its lock names this process.
  async function daemon() {
    const runtime = createAlpRuntime({ libraryDir: path.join(home, 'library'), transport: fakeRuntime(runtimes) });
    const store = createStore(path.join(home, 'state'));
    const server = createDaemonServer({ runtime, socketPath: socket, version: 'test', store });
    await server.listen();
    await writeFile(daemonPaths(home).lock, JSON.stringify({ pid: process.pid, bootTime: bootTime(), uid: process.getuid?.() ?? -1, version: 'test', protocolVersion: 1, socket, ready: true, startedAt: new Date().toISOString() }));
    const handle = { runtime, store, server, async crash() { await store.flush(); await server.close(); } };
    daemons.push(handle);
    return handle;
  }
  let conn;
  // The connection closes before its alpd goes: one still open would reconnect and, once the home
  // and its lock are gone, start an alpd there.
  t.after(async () => {
    try {
      try { await conn?.close(); } finally {
        try {
          for (const handle of daemons) { await handle.server.close().catch(() => {}); await handle.runtime.shutdown(); }
        } finally {
          await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          // A start already under way when the home went would make it again, and be recorded, within this pause.
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      assert.deepEqual(await launched(), [], 'the provider started no alpd of its own');
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(record, { recursive: true, force: true });
    }
  });

  const first = await daemon();
  conn = await createProvider({ home, daemonEntry: entry }).connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  const events = [];
  conn.onEvent(event => events.push(event));
  const config = { cwd: root, env: {}, systemPrompt: '', mcpServers: {}, settings: {}, persist: true };
  const prompt = id => ({ type: 'session.prompt', sessionId: 's', prompt: { clientMessageId: id, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: id }] } } });
  const result = id => events.find(event => event.type === 'session.prompt_result' && event.clientMessageId === id)?.result;
  await conn.send({ type: 'session.open', requestId: 'open', sessionId: 's', config, history: 'skip' });
  await conn.send(prompt('m1'));
  runtimes[0].notify('turn/completed', { threadId: 'native-thread', turn: { id: result('m1').turnId, status: 'completed' } });

  // alpd dies; Paseo is told it is reconnecting, not that the session failed.
  await first.crash();
  await until(() => events.some(event => event.type === 'timeline.item' && /lost its connection to alpd/.test(event.item.message)), 'the lost notice');
  await daemon();
  await until(() => events.some(event => event.type === 'timeline.item' && event.item.message === 'ALP reconnected to alpd.'), 'the reconnect notice');
  assert.ok(!events.some(event => event.type === 'session.runtime_failed'));

  // The new alpd had not reopened the session: the next prompt does, from its thread.
  const before = runtimes.length;
  await conn.send(prompt('m2'));
  assert.equal(result('m2').type, 'turn');
  // Main's own process, beside its supervisor's.
  const resumed = runtimes.slice(before).find(runtime => runtime.calls[0]?.method === 'thread/resume');
  assert.deepEqual(resumed.calls.slice(0, 2).map(call => [call.method, call.params.threadId]), [['thread/resume', 'native-thread'], ['turn/start', 'native-thread']]);
  assert.equal(events.filter(event => event.type === 'session.opened' && event.sessionId === 's').length, 1, 'Paseo sees its session opened once');
  resumed.notify('turn/completed', { threadId: 'native-thread', turn: { id: result('m2').turnId, status: 'completed' } });

  // A prompt while alpd is away waits for it.
  await daemons.at(-1).crash();
  const sent = conn.send(prompt('m3'));
  await new Promise(resolve => setTimeout(resolve, 300));
  await daemon();
  await sent;
  assert.equal(result('m3').type, 'turn');
  // Each reconnect found this test's alpd under its lock; none started another.
  assert.deepEqual(await launched(), []);
});

test('daemonEntry resolves explicit candidate, Paseo plugin directory, or host CLI', async t => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'alp-entry-test-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  // 1. Explicit existing entry takes precedence
  const explicitPath = path.join(tempDir, 'custom-alpd.js');
  await writeFile(explicitPath, '// custom alpd');
  assert.equal(daemonEntry(explicitPath), explicitPath);

  // 2. Paseo plugin path in config.json is discovered
  const paseoHome = path.join(tempDir, 'paseo-home');
  const mockPluginDir = path.join(tempDir, 'mock-plugin');
  const bundledAlpd = path.join(mockPluginDir, 'server', 'dist', 'alpd.js');
  await mkdir(path.dirname(bundledAlpd), { recursive: true });
  await writeFile(bundledAlpd, '// bundled alpd');
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, 'config.json'), JSON.stringify({
    version: 1,
    plugins: {
      'alp-provider': {
        source: 'directory',
        path: mockPluginDir,
        enabled: true,
      },
    },
  }));

  // Resolve with explicit paseoHome
  assert.equal(daemonEntry(undefined, paseoHome), bundledAlpd);

  const unrelated = path.join(tempDir, 'unrelated');
  await mkdir(path.join(unrelated, 'server', 'dist'), { recursive: true });
  await writeFile(path.join(unrelated, 'server', 'dist', 'alpd.js'), '// other daemon');
  await writeFile(path.join(paseoHome, 'config.json'), JSON.stringify({ plugins: {
    other: { path: unrelated, enabled: true },
    'alp-provider': { path: mockPluginDir, enabled: true },
  } }));
  assert.equal(daemonEntry(undefined, paseoHome), bundledAlpd, 'unrelated-first registration is ignored');

  // Disabled and unrelated registrations cannot select a daemon binary.
  for (const plugins of [
    { 'alp-provider': { path: mockPluginDir, enabled: false } },
    { other: { path: mockPluginDir, enabled: true } },
  ]) {
    await writeFile(path.join(paseoHome, 'config.json'), JSON.stringify({ plugins }));
    assert.notEqual(daemonEntry(undefined, paseoHome), bundledAlpd);
  }

  // 3. Fallback to CLI or environment when explicit is missing/invalid
  const nonExistent = path.join(tempDir, 'missing.js');
  const entryWithoutConfig = daemonEntry(nonExistent);
  // Returns existing binary on host if installed, or undefined if no host CLI
  if (entryWithoutConfig) {
    assert.match(entryWithoutConfig, /alpd\.js$/);
  }
});
