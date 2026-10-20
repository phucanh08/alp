import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

import { createAlpRuntime } from '../../dist/runtime/index.js';
import { createDaemonServer } from '../../dist/daemon/index.js';
import { createPaseoBridge } from '../../integrations/paseo/server/dist/index.js';
import { initProject } from '../../packages/core/src/init.js';
import { seedLibrary } from '../../packages/core/src/library.js';
import { fakeTransport } from '../support/fake-agent.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const cli = path.join(root, 'packages', 'cli', 'dist', 'cli.js');
const integrationDescriptor = path.join(root, 'integrations', 'web.json');
const execFileAsync = promisify(execFile);

// The integration serves a web app only when one is built beside it; these tests exercise the process
// lifecycle, so a stand-in page keeps them independent of the large web build (ALP_WEB_APP is the override).
const standInApp = await mkdtemp(path.join(tmpdir(), 'alp-web-app-'));
await writeFile(path.join(standInApp, 'index.html'), '<!doctype html><title>ALP</title>');
process.env.ALP_WEB_APP = standInApp;
after(() => rm(standInApp, { recursive: true, force: true }));
const { connect, readLock, lockAlive } = await import('../../packages/client/dist/index.js');

/**
 * Runs the CLI in a child process and never rejects: the caller reads the exit code and output.
 * A timeout is reported as `signal: 'SIGKILL'` with a code that is not 0, so a hang fails the test.
 */
async function run(args, home, timeout = 60_000, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
      env: { ...process.env, ALP_HOME: home, ...extraEnv },
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr, signal: null };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      signal: error.signal ?? null,
    };
  }
}

async function homeJson(home, name) {
  return readFile(path.join(home, name), 'utf8').then(JSON.parse, () => undefined);
}

const webJson = home => homeJson(home, 'web.json');
const lockJson = home => homeJson(home, path.join('integrations', 'web.lock'));

async function stopPid(pid) {
  if (!Number.isSafeInteger(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 200; i++) { try { process.kill(pid, 0); } catch { return; } await sleep(25); }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 80; i++) { try { process.kill(pid, 0); } catch { return; } await sleep(25); }
}

async function waitGone(pid) {
  for (let i = 0; i < 200; i++) { try { process.kill(pid, 0); } catch { return; } await sleep(25); }
  assert.fail(`process ${pid} did not exit`);
}

/** A temporary ALP home with an ephemeral web port and no relay, cleaned up with its own PIDs. */
async function createHome(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-integration-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ web: { port: 0, relay: { enabled: false } } }));
  t.after(async () => {
    // Stop the integration before the daemon: a supervised integration would otherwise restart
    // the daemon after we stop it. Only PIDs named by this home's own metadata are touched.
    const owned = new Set();
    const info = await webJson(home);
    if (info?.pid) owned.add(info.pid);
    const lock = await lockJson(home);
    if (lock?.pid) owned.add(lock.pid);
    for (const pid of owned) await stopPid(pid);
    await run(['daemon', 'stop'], home, 20_000).catch(() => {});
    const daemon = await readLock(home).catch(() => undefined);
    if (daemon?.pid) await stopPid(daemon.pid);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { directory, home };
}

async function startDaemon(home) {
  const started = await run(['daemon', 'start'], home, 30_000);
  assert.equal(started.code, 0, started.signal ? `alp daemon start timed out (${started.signal})` : started.stderr || started.stdout);
  for (let i = 0; i < 100; i++) {
    const lock = await readLock(home).catch(() => undefined);
    if (lock?.ready) return lock;
    await sleep(100);
  }
  assert.ok((await readLock(home).catch(() => undefined))?.ready, 'alpd did not become ready');
}

async function callDaemon(socket, method, params = {}) {
  const client = await connect(socket);
  try { return await client.request(method, params); } finally { client.close(); }
}

async function waitFor(fn, what, tries = 300, gap = 50) {
  for (let i = 0; i < tries; i++) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    await sleep(gap);
  }
  assert.fail(`Expected ${what} did not arrive`);
}

test('cold alp web starts one integration on an ephemeral port and reuses it', async t => {
  const { home } = await createHome(t);
  const daemon = await startDaemon(home);

  const first = await run(['web', '--print'], home);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const info1 = await webJson(home);
  assert.ok(info1?.pid && info1.pid !== daemon.pid, 'the integration is its own process');
  assert.ok(info1.port > 0, 'an ephemeral port was assigned');
  assert.match(first.stdout, /^http:\/\/127\.0\.0\.1:\d+\/#token=/m);
  assert.ok(first.stdout.includes(`127.0.0.1:${info1.port}/#token=${info1.token}`), 'the printed URL names the assigned port and token');

  const second = await run(['web', '--print'], home);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  const info2 = await webJson(home);
  assert.equal(info2.pid, info1.pid, 'a repeated invocation reuses the running integration');
  assert.equal(info2.token, info1.token);
});

test('two concurrent cold alp web invocations converge on one integration', async t => {
  const { home } = await createHome(t);
  const daemon = await startDaemon(home);

  const [a, b] = await Promise.all([run(['web', '--print'], home), run(['web', '--print'], home)]);
  assert.equal(a.code, 0, a.stderr || a.stdout);
  assert.equal(b.code, 0, b.stderr || b.stdout);

  const info = await webJson(home);
  assert.ok(info?.pid && info.pid !== daemon.pid, 'one integration owns the web');
  assert.ok(a.stdout.includes(`127.0.0.1:${info.port}/#token=${info.token}`), 'the first caller names the winner');
  assert.ok(b.stdout.includes(`127.0.0.1:${info.port}/#token=${info.token}`), 'the second caller converges on the winner');

  // The web lock and web.json agree on the single winning process.
  const lock = await lockJson(home);
  assert.equal(lock.pid, info.pid);
});

test('cold alp web pair --off starts the integration and reports the relay off', async t => {
  const { home } = await createHome(t);
  const daemon = await startDaemon(home);

  // No precondition: the CLI only returns from starting the integration once web.pairing is
  // registered, so a cold `pair` cannot race the RPC. Readiness itself guarantees the extension.
  const paired = await run(['web', 'pair', '--off'], home);
  assert.equal(paired.code, 0, paired.stderr || paired.stdout);
  assert.match(paired.stdout, /relay is off/i);

  const info = await webJson(home);
  assert.ok(info?.pid && info.pid !== daemon.pid, 'pair starts the integration too');
});

test('a killed integration keeps its token and server id when restarted', async t => {
  const { home } = await createHome(t);
  const daemon = await startDaemon(home);

  const first = await run(['web', '--print'], home);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const info1 = await webJson(home);

  process.kill(info1.pid, 'SIGKILL');
  await waitGone(info1.pid);

  const daemonAfterKill = await readLock(home);
  assert.ok(lockAlive(daemonAfterKill), 'the core daemon survives the integration dying');

  const restarted = await run(['web', '--print'], home);
  assert.equal(restarted.code, 0, restarted.stderr || restarted.stdout);
  const info2 = await webJson(home);
  assert.notEqual(info2.pid, info1.pid, 'a fresh integration process');
  assert.equal(info2.token, info1.token, 'the token is kept, so open pages survive');
  assert.equal(info2.serverId, info1.serverId, 'the server id is kept');
});

test('a restarted daemon is re-registered by the surviving integration', async t => {
  const { home } = await createHome(t);
  const daemon1 = await startDaemon(home);

  const first = await run(['web', '--print'], home);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const info = await webJson(home);
  await waitFor(async () => (await callDaemon(daemon1.socket, 'web.pairing', {})) && true, 'web.pairing on the first daemon');

  const stopped = await run(['daemon', 'stop'], home, 20_000);
  assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout);
  await waitGone(daemon1.pid);
  assert.ok(!lockAlive(await readLock(home)), 'the old daemon is gone');

  const daemon2 = await startDaemon(home);
  assert.notEqual(daemon2.pid, daemon1.pid, 'a new daemon process');
  const pairing = await waitFor(async () => await callDaemon(daemon2.socket, 'web.pairing', {}), 'web.pairing after the daemon restarted');
  assert.equal(typeof pairing.relayEnabled, 'boolean');

  const after = await webJson(home);
  assert.equal(after.pid, info.pid, 'the integration survives the daemon restart');
});

test('a disabled web setting fails fast with a clear message', async t => {
  const { home } = await createHome(t);
  await startDaemon(home);
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ web: { enabled: false } }));

  const refused = await run(['web', '--print'], home);
  assert.notEqual(refused.code, 0);
  assert.match((refused.stderr || '') + (refused.stdout || ''), /disabled/i);
});

test('a missing integration descriptor names the optional package', async t => {
  // Discovery always searches these system bin directories, whatever PATH and HOME say; an
  // integration installed there cannot be hidden from the CLI, so the refusal cannot be observed.
  const installed = ['/opt/homebrew/bin', '/usr/local/bin'].map(directory => path.join(directory, 'alp-web-integration')).find(file => existsSync(file));
  if (installed) { t.skip(`alp-web-integration is installed at ${installed}, which discovery always searches`); return; }
  const { home } = await createHome(t);
  await startDaemon(home);

  // Hide the distribution descriptor so discovery finds no web integration, then restore it.
  const hidden = `${integrationDescriptor}.hidden`;
  await rename(integrationDescriptor, hidden);
  t.after(async () => { await rename(hidden, integrationDescriptor).catch(() => {}); });
  try {
    // Discovery also searches PATH (the workspace links `alp-web-integration` into node_modules/.bin,
    // and a developer may have it installed globally, possibly beside node itself) and the well-known
    // bin directories under HOME (~/.npm-global/bin, ~/.local/bin). The CLI is launched through
    // process.execPath and the refusal path spawns nothing, so give it an empty PATH and HOME, and
    // clear the explicit overrides, so no installed integration is reachable.
    const empty = await mkdtemp(path.join(tmpdir(), 'alp-no-home-'));
    t.after(() => rm(empty, { recursive: true, force: true }));
    const refused = await run(['web', '--print'], home, 60_000, {
      PATH: empty,
      HOME: empty,
      USERPROFILE: empty,
      ALP_WEB_INTEGRATION: '',
      ALP_INTEGRATION_ENTRY: '',
    });
    assert.notEqual(refused.code, 0);
    assert.match((refused.stderr || '') + (refused.stdout || ''), /optional integration package/i);
  } finally {
    await rename(hidden, integrationDescriptor).catch(() => {});
  }
});

test('stale web metadata from a dead process is replaced by a live integration', async t => {
  const { home } = await createHome(t);
  const daemon = await startDaemon(home);

  const dead = 2 ** 31 - 1;
  await writeFile(path.join(home, 'web.json'), JSON.stringify({ pid: dead, port: 1, token: 'a'.repeat(64), serverId: 'alp-0000000000000000', url: 'http://127.0.0.1:1/' }));

  const served = await run(['web', '--print'], home);
  assert.equal(served.code, 0, served.stderr || served.stdout);
  const info = await webJson(home);
  assert.notEqual(info.pid, dead, 'the stale pid is not reported');
  assert.ok(info.pid !== daemon.pid && info.port > 1, 'a live integration serves the web');
  assert.match(served.stdout, /^http:\/\/127\.0\.0\.1:\d+\/#token=/m);
});

// A minimal Paseo socket, so the bridge can be driven without a browser (FrameSocket in gateway.ts).
function fakeSocket() {
  const emitter = new EventEmitter();
  const frames = [];
  const socket = {
    readyState: 1,
    frames,
    send(data) { frames.push(JSON.parse(String(data))); return undefined; },
    close() { if (socket.readyState === 3) return; socket.readyState = 3; emitter.emit('close', 1000, ''); },
    on(event, listener) { emitter.on(event, listener); return socket; },
    receive(frame) { emitter.emit('message', JSON.stringify(frame), false); },
  };
  return socket;
}

async function untilValue(check, what, tries = 2000, gap = 5) {
  for (let i = 0; i < tries; i++) { const value = await check(); if (value) return value; await sleep(gap); }
  assert.fail(`Expected ${what} did not arrive`);
}

test('a reconnected bridge re-attaches roots with a fresh epoch and streams without duplicates', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-integration-reconnect-'));
  const home = path.join(directory, 'home');
  const project = path.join(directory, 'project');
  await seedLibrary(home);
  await initProject(project, { library: home });

  const agents = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(agents), supervisor: false, libraryDir: home });
  const daemon = createDaemonServer({ runtime, home, socketPath: '', version: 'test' });
  const attachCalls = [];
  const connections = [];
  let factoryCalls = 0;
  const clientFactory = async onEvent => {
    factoryCalls += 1;
    const client = daemon.local();
    client.onEvent(onEvent);
    connections.push(client);
    return {
      request: (method, params) => { if (method === 'session.attach') attachCalls.push(params); return client.request(method, params); },
      onEvent: listener => client.onEvent(listener),
      onClose: listener => client.onClose(listener),
      close: () => client.close(),
    };
  };
  const token = 'f'.repeat(64);
  const gateway = createPaseoBridge({ clientFactory, version: 'test', home, token: () => token, serverId: () => 'alp-0000000000000000' });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  const socket = fakeSocket();
  gateway.attach(socket);
  socket.receive({ type: 'hello', clientId: 'cid-test', protocolVersion: 1, auth: { kind: 'password', password: token } });
  await untilValue(() => socket.frames.some(frame => frame.message?.payload?.status === 'server_info'), 'server_info');

  const session = message => socket.receive({ type: 'session', message });
  const ask = async message => {
    session(message);
    const frame = await untilValue(() => socket.frames.find(candidate => candidate.message?.payload?.requestId === message.requestId), `reply to ${message.type}`);
    return frame.message;
  };

  const created = await ask({ type: 'create_agent_request', requestId: 'a1', config: { provider: 'alp', cwd: project, title: 'Reconnect' }, initialPrompt: 'Hello', clientMessageId: 'm1', labels: {} });
  const agentId = created.payload.agentId;
  // Keep the first turn running across the connection loss: alpd retains a busy root and its log,
  // so the reconnect must replay the history rather than start from nothing.
  await untilValue(() => agents[0]?.started.length === 1, 'the first turn');

  const before = (await ask({ type: 'fetch_agent_timeline_request', requestId: 'tl1', agentId })).payload;
  assert.equal(before.error, null);
  const epochBefore = before.epoch;
  const texts = list => list.map(entry => entry.item.text);
  assert.deepEqual(texts(before.entries).filter(text => text === 'Hello'), ['Hello']);

  // Lose the daemon connection: the bridge must reconnect through the factory and re-subscribe.
  const attachesBefore = attachCalls.length;
  connections.at(-1).close();
  await untilValue(() => factoryCalls > 1, 'a reconnect');
  await untilValue(() => attachCalls.length > attachesBefore && attachCalls.at(-1)?.replay === true, 'a replay attach on the new connection');

  const after = (await ask({ type: 'fetch_agent_timeline_request', requestId: 'tl2', agentId })).payload;
  assert.equal(after.error, null);
  assert.notEqual(after.epoch, epochBefore, 'the replayed snapshot opens a new epoch');
  assert.equal(texts(after.entries).filter(text => text === 'Hello').length, 1, 'the replayed user message is not duplicated');

  // The turn finishes on the reconnected subscription and streams to the app.
  agents[0].finish('First answer.');
  await untilValue(
    () => socket.frames.some(frame => frame.message?.type === 'agent_stream' && frame.message.payload.event.type === 'timeline' && frame.message.payload.event.item?.text === 'First answer.'),
    'the resumed stream',
  );

  const done = (await ask({ type: 'fetch_agent_timeline_request', requestId: 'tl3', agentId })).payload;
  assert.equal(texts(done.entries).filter(text => text === 'Hello').length, 1, 'the user message stays single');
  assert.equal(texts(done.entries).filter(text => text === 'First answer.').length, 1, 'the answer appears once');
});
