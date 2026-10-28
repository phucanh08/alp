import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';
import { bootTime, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { createAlpProvider } from '../server/dist/provider-core.js';
import { createProvider } from '../server/dist/provider.js';

function fakeClient(capabilities = PROVIDER_CAPABILITIES) {
  let onClose;
  const client = {
    closed: false,
    capabilities,
    onEvent: () => () => {},
    onClose: listener => { onClose = listener; return () => {}; },
    request: async () => ({}),
    close() { client.closed = true; },
    drop(error = new Error('daemon connection closed')) {
      client.closed = true;
      onClose?.(error);
    },
  };
  return client;
}

test('close() awaits in-flight relink and stops background loop', async () => {
  let relinkStarted = false;
  let relinkSettled = false;
  let resolveRelink;
  const relinkGate = new Promise(resolve => { resolveRelink = resolve; });

  const client = fakeClient();
  const nextClient = fakeClient();

  const provider = createAlpProvider({
    description: 'test',
    open: async () => ({
      client,
      async shutdown() { client.close(); },
      relink: async () => {
        relinkStarted = true;
        await relinkGate;
        relinkSettled = true;
        return nextClient;
      },
    }),
    teams: async () => [],
    spec: () => ({ spec: { cwd: '/w' } }),
    projectRoot: cwd => cwd,
    modes: () => ({ modes: [], defaultMode: 'read-only' }),
    cursors: false,
    repeatAfterRelink: false,
  });

  const connection = await provider.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });

  // Simulate connection drop
  client.drop();

  // Wait until relink is in-flight
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(relinkStarted, true, 'relink should have started');
  assert.equal(relinkSettled, false, 'relink should be in-flight');

  // Call close() while relink is in-flight
  let closeFinished = false;
  const closePromise = connection.close().then(() => { closeFinished = true; });

  // Give microtasks and timers a tick: close() must still be awaiting relink
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(closeFinished, false, 'close() must await in-flight relinking');

  // Now resolve relink
  resolveRelink();
  await closePromise;
  assert.equal(closeFinished, true);
  assert.equal(relinkSettled, true);
  assert.equal(nextClient.closed, true, 'defensive: nextClient must be closed if resolved after close()');
});

test('in-flight relink receives abort signal when close() is called', async () => {
  let receivedSignal;
  let resolveRelink;
  const relinkGate = new Promise(resolve => { resolveRelink = resolve; });

  const client = fakeClient();
  const nextClient = fakeClient();

  const provider = createAlpProvider({
    description: 'test',
    open: async () => ({
      client,
      async shutdown() { client.close(); },
      relink: async (_demand, signal) => {
        receivedSignal = signal;
        await relinkGate;
        return nextClient;
      },
    }),
    teams: async () => [],
    spec: () => ({ spec: { cwd: '/w' } }),
    projectRoot: cwd => cwd,
    modes: () => ({ modes: [], defaultMode: 'read-only' }),
    cursors: false,
    repeatAfterRelink: false,
  });

  const connection = await provider.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  client.drop();

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(receivedSignal, 'signal should be passed to relink');
  assert.equal(receivedSignal.aborted, false, 'signal must not be aborted initially');

  const closePromise = connection.close();
  assert.equal(receivedSignal.aborted, true, 'signal must be aborted when close() is called');

  resolveRelink();
  await closePromise;
  assert.equal(nextClient.closed, true);
});

test('close() wakes backoff immediately and exits cleanly without waiting full backoff timer', async () => {
  let relinkAttempts = 0;
  const client = fakeClient();

  const provider = createAlpProvider({
    description: 'test',
    open: async () => ({
      client,
      async shutdown() { client.close(); },
      relink: async () => {
        relinkAttempts++;
        throw new Error('transient relink failure to enter backoff');
      },
    }),
    teams: async () => [],
    spec: () => ({ spec: { cwd: '/w' } }),
    projectRoot: cwd => cwd,
    modes: () => ({ modes: [], defaultMode: 'read-only' }),
    cursors: false,
    repeatAfterRelink: false,
  });

  const connection = await provider.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  client.drop();

  // Wait for the first attempt to fail and enter backoff
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(relinkAttempts, 1, 'relink should have attempted once and entered backoff');

  const start = Date.now();
  await connection.close();
  const elapsed = Date.now() - start;

  // Backoff attempt 0 is 250ms, but wakeBackoff should resolve it immediately (<150ms)
  assert.ok(elapsed < 200, `close() should wake backoff promptly, took ${elapsed}ms`);
});

test('close() bounds join wait by relinkCloseTimeoutMs if backend.relink hangs indefinitely', async () => {
  let relinkStarted = false;
  const client = fakeClient();

  const provider = createAlpProvider({
    description: 'test',
    open: async () => ({
      client,
      async shutdown() { client.close(); },
      // Hangs forever
      relink: () => {
        relinkStarted = true;
        return new Promise(() => {});
      },
    }),
    teams: async () => [],
    spec: () => ({ spec: { cwd: '/w' } }),
    projectRoot: cwd => cwd,
    modes: () => ({ modes: [], defaultMode: 'read-only' }),
    cursors: false,
    repeatAfterRelink: false,
    relinkCloseTimeoutMs: 80,
  });

  const connection = await provider.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  client.drop();

  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(relinkStarted, true);

  const start = Date.now();
  await connection.close();
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 70 && elapsed < 300, `close() should bound wait to ~80ms timeout, took ${elapsed}ms`);
});

test('defensive: if backend.relink resolves after close timeout, connection is closed and not leaked', async () => {
  let resolveRelink;
  const client = fakeClient();
  const lateClient = fakeClient();

  const provider = createAlpProvider({
    description: 'test',
    open: async () => ({
      client,
      async shutdown() { client.close(); },
      relink: () => new Promise(resolve => { resolveRelink = resolve; }),
    }),
    teams: async () => [],
    spec: () => ({ spec: { cwd: '/w' } }),
    projectRoot: cwd => cwd,
    modes: () => ({ modes: [], defaultMode: 'read-only' }),
    cursors: false,
    repeatAfterRelink: false,
    relinkCloseTimeoutMs: 50,
  });

  const connection = await provider.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  client.drop();

  await new Promise(resolve => setTimeout(resolve, 20));
  await connection.close(); // Times out and finishes

  // Late resolution occurs after close() has settled
  resolveRelink(lateClient);
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(lateClient.closed, true, 'lateClient must be defensively closed upon late resolution');
  assert.rejects(async () => {
    await connection.send({ type: 'session.open', requestId: 'req-1', sessionId: 's1', config: { cwd: '/w' } });
  }, /closed/);
});

test('real createProvider: close() settles relink and never starts daemon or leaks after home deletion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-relink-close-home-'));
  const home = path.join(directory, 'home');
  const record = await mkdtemp(path.join(tmpdir(), 'alp-relink-close-record-'));
  const launches = path.join(record, 'launches.log');
  const entry = path.join(record, 'alpd-stub.mjs');
  await writeFile(entry, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(launches)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(1);\n`);
  const launched = () => readFile(launches, 'utf8').then(text => text.split('\n').filter(Boolean), error => { if (error.code === 'ENOENT') return []; throw error; });

  const { socket } = daemonPaths(home);
  const runtime = createAlpRuntime({ transport: { async init() {}, async list() { return []; }, async open() { throw new Error('noop'); } } });
  const store = createStore(path.join(home, 'state'));
  const server = createDaemonServer({ runtime, socketPath: socket, version: 'test', store });
  await server.listen();
  await writeFile(daemonPaths(home).lock, JSON.stringify({ pid: process.pid, bootTime: bootTime(), uid: process.getuid?.() ?? -1, version: 'test', protocolVersion: 1, socket, ready: true, startedAt: new Date().toISOString() }));

  const events = [];
  const conn = await createProvider({ home, daemonEntry: entry }).connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  conn.onEvent(e => events.push(e));

  // Crash daemon to trigger relink
  await store.flush();
  await server.close();
  await runtime.shutdown();

  // Wait for provider to detect connection loss and start relinking
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !events.some(e => e.type === 'timeline.item' && /lost its connection to alpd/.test(e.item?.message ?? ''))) {
    await new Promise(r => setTimeout(r, 20));
  }

  // Close provider while relink is attempting to reconnect
  await conn.close();

  // Clean up home directory
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

  // Give any background starts a chance to run if not stopped
  await new Promise(r => setTimeout(r, 300));

  // Assert NO daemon was started by the provider
  assert.deepEqual(await launched(), [], 'no alpd was started by provider after close');

  await rm(record, { recursive: true, force: true });
});
