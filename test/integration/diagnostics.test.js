// What an operator can learn about alpd from its log and from alp doctor (ALPD §67): a failed start,
// an alpd that runs but is not reachable or not ready, and a log that never lands in the ACP stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { bootTime, daemonPaths, ensureDaemon } from '../../packages/client/src/index.js';
import { diagnose, diskCheck } from '../../packages/client/src/doctor.js';
import { createAlpRuntime } from '../../dist/runtime/index.js';
import { createDaemonServer, createStore } from '../../dist/daemon/index.js';

const ALPD = fileURLToPath(new URL('../../dist/alpd.js', import.meta.url));
const CLI = fileURLToPath(new URL('../../packages/cli/src/cli.js', import.meta.url));
const run = promisify(execFile);
const skip = process.platform === 'win32' && 'POSIX modes and sockets only';
const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

async function privateHome(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-diag-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'home');
  await mkdir(path.join(home, 'logs'), { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  return { directory, home };
}

/** Runs alpd the way its detached launcher leaves it: output to its log file. Resolves with its exit. */
async function alpd(home, args = []) {
  const log = openSync(daemonPaths(home).log, 'a', 0o600);
  const child = spawn(process.execPath, [ALPD, ...args], { stdio: ['ignore', log, log], env: { ...process.env, ALP_HOME: home, ANTHROPIC_API_KEY: SECRET } });
  closeSync(log);
  const [code] = await once(child, 'exit');
  return code;
}

const records = async home => (await readFile(daemonPaths(home).log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));

test('a start that cannot open its IPC endpoint says so in the log and doctor reads it', { skip }, async t => {
  const { home, directory } = await privateHome(t);
  // Something that is not a socket sits where alpd's endpoint goes.
  const { socket } = daemonPaths(home);
  await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
  await writeFile(socket, 'in the way', { mode: 0o600 });
  assert.equal(await alpd(home), 1);
  const failure = (await records(home)).find(record => record.level === 'error');
  assert.deepEqual([failure.component, failure.code, failure.phase], ['alpd', 'ALP_IPC_LISTEN_FAILED', 'listen']);
  assert.match(failure.error.message, /socket/i);
  assert.match(failure.time, /^\d{4}-\d\d-\d\dT/);
  assert.ok(!(await readFile(daemonPaths(home).log, 'utf8')).includes(SECRET));

  const checks = await diagnose({ home, env: { PATH: path.join(directory, 'empty') } });
  const startup = checks.find(check => check.id === 'startup');
  assert.equal(startup.status, 'fail');
  assert.match(startup.summary, /ALP_IPC_LISTEN_FAILED/);
});

test('a launcher that fails at once reports why, in its error and not only in a log', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  // Admission accepts the home; the real launcher fails while preparing its log directory.
  await chmod(path.join(home, 'logs'), 0o755);
  await assert.rejects(ensureDaemon({ home, entry: ALPD, timeoutMs: 2000 }), error => /launcher exited \(1\): ALP_HOME_UNUSABLE, alpd failed to start while preparing its home/.test(error.message) && !error.message.includes(SECRET));
});

test('startup admission reports an unusable home before launching a child', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  await chmod(home, 0o755);
  await assert.rejects(ensureDaemon({ home, entry: path.join(directory, 'must-not-launch.js'), env: { ...process.env, ALP_HOME: home } }), error => {
    assert.equal(error.code, 'ALP_HOME_UNUSABLE');
    assert.match(error.message, /ALP_HOME_UNUSABLE.*preparing its home/);
    assert.match(error.cause.message, /private permissions/);
    return true;
  });
});

test('doctor and alp daemon status tell a ready alpd, one that is not ready, and one that is gone', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  const state = path.join(home, 'state');
  const runtime = createAlpRuntime({ runLogDir: path.join(directory, 'runs'), libraryDir: home });
  const store = createStore(state);
  const { socket } = daemonPaths(home);
  const server = createDaemonServer({ runtime, socketPath: socket, version: 'test', store });
  await server.listen();
  t.after(async () => { await server.close().catch(() => {}); await runtime.shutdown(); });
  const env = { ...process.env, ALP_HOME: home, PATH: path.join(directory, 'empty') };
  const status = async () => {
    try { const { stdout } = await run(process.execPath, [CLI, 'daemon', 'status', '--json'], { env }); return { code: 0, report: JSON.parse(stdout) }; }
    catch (error) { return { code: error.code, report: JSON.parse(error.stdout) }; }
  };
  const lockFile = path.join(home, 'alpd.lock');

  // Not running: no lock.
  assert.deepEqual(await status(), { code: 3, report: { running: false, live: false, ready: false } });

  await writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), bootTime: bootTime(), socket, ready: true, version: 'test', protocolVersion: 1 }), { mode: 0o600 });
  const ready = await status();
  assert.equal(ready.code, 0);
  assert.deepEqual([ready.report.running, ready.report.health.live, ready.report.health.ready], [true, true, true]);
  const good = await diagnose({ home, env: { PATH: path.join(directory, 'empty') } });
  assert.equal(good.find(check => check.id === 'ipc').status, 'ok');
  assert.equal(good.find(check => check.id === 'readiness').status, 'ok');
  assert.equal(good.find(check => check.id === 'state').status, 'ok');

  // Alive, answering, and not ready: its state directory cannot be written.
  await store.list();
  await rename(state, `${state}.away`);
  await writeFile(state, 'not a directory');
  const broken = await status();
  assert.equal(broken.code, 4);
  assert.equal(broken.report.health.live, true);
  assert.equal(broken.report.health.ready, false);
  const bad = await diagnose({ home, env: { PATH: path.join(directory, 'empty') } });
  const readiness = bad.find(check => check.id === 'readiness');
  assert.equal(readiness.status, 'fail');
  assert.match(readiness.summary, /alive but not ready: ALP_STATE_NOT_WRITABLE/);
  assert.equal(bad.find(check => check.id === 'ipc').status, 'ok');
  const { stdout } = await run(process.execPath, [CLI, 'daemon', 'status'], { env }).catch(error => error);
  assert.match(stdout, /not ready: ALP_STATE_NOT_WRITABLE/);
  await rm(state);
  await rename(`${state}.away`, state);
  assert.equal((await status()).code, 0);

  // Alive by its lock, but nothing listens: the IPC check fails with its code.
  await server.close();
  const gone = await status();
  assert.equal(gone.code, 4);
  assert.equal(gone.report.checks[0].code, 'ALP_IPC_FAILED');
  const unreachable = (await diagnose({ home, env: { PATH: path.join(directory, 'empty') }, timeoutMs: 500 })).find(check => check.id === 'ipc');
  assert.equal(unreachable.status, 'fail');
  assert.match(unreachable.summary, /cannot be reached.*ALP_IPC_(SOCKET_MISSING|REFUSED)/);
});

test('alp acp keeps stdout to protocol frames and puts structured, scrubbed diagnostics on stderr', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  // alpd cannot start in a home others can read, so the editor's request fails.
  await chmod(home, 0o755);
  const child = spawn(process.execPath, [CLI, 'acp'], { env: { ...process.env, ALP_HOME: home, ANTHROPIC_API_KEY: SECRET, ALP_DAEMON_ENTRY: ALPD }, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  child.stdout.on('data', chunk => out.push(chunk));
  child.stderr.on('data', chunk => err.push(chunk));
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: directory, mcpServers: [] } },
  ];
  for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`);
  const deadline = Date.now() + 15_000;
  while (!Buffer.concat(out).toString().includes('"id":2') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  child.stdin.end();
  await once(child, 'exit');

  const stdout = Buffer.concat(out).toString().split('\n').filter(Boolean);
  assert.ok(stdout.length >= 2);
  for (const line of stdout) assert.equal(JSON.parse(line).jsonrpc, '2.0', `stdout carried a line that is not a protocol frame: ${line}`);
  assert.ok(JSON.parse(stdout.find(line => line.includes('"id":2'))).error);
  const stderr = Buffer.concat(err).toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const failure = stderr.find(record => record.code === 'ALP_IPC_CONNECT_FAILED');
  assert.deepEqual([failure.component, failure.level], ['acp', 'warn']);
  assert.match(failure.error.message, /ALP_HOME_UNUSABLE/);
  assert.ok(!stdout.join('\n').includes(SECRET) && !JSON.stringify(stderr).includes(SECRET));
});

test('alp doctor reports free disk space and the worktrees earlier runs left, deleting none (t-2831)', { skip }, async t => {
  const { directory, home } = await privateHome(t);
  const temp = path.join(directory, 'tmp');
  await mkdir(path.join(home, 'worktrees', 'alp-child-1'), { recursive: true });
  await writeFile(path.join(home, 'worktrees', 'alp-child-1', 'big'), 'x'.repeat(64 * 1024));
  await mkdir(path.join(temp, 'alp-group14'), { recursive: true });
  await mkdir(path.join(temp, 'other'), { recursive: true });
  const low = await diskCheck(home, { free: 1.2 * 1024 ** 3, tempDirs: [temp] });
  assert.equal(low.status, 'warn');
  assert.match(low.summary, /^1\.2 GB free where ALP_HOME lives; when the disk is full, alpd pauses all work until space returns$/);
  assert.equal(low.details.length, 2);
  assert.match(low.details[0], /^1 left in .*worktrees, \d+ (MB|GB)$/);
  assert.match(low.details[1], /^1 left in .*alp-\*/);
  assert.match(low.hint, /ALP deletes none of these/);
  const plenty = await diskCheck(home, { free: 50 * 1024 ** 3, tempDirs: [temp] });
  assert.equal(plenty.status, 'info');
  assert.equal(plenty.summary, '50.0 GB free where ALP_HOME lives');
  assert.equal((await diskCheck(path.join(directory, 'empty-home'), { free: 50 * 1024 ** 3, tempDirs: [] })).status, 'ok');
  // Nothing was removed.
  await readFile(path.join(home, 'worktrees', 'alp-child-1', 'big'));
  const checks = await diagnose({ home, env: { PATH: path.join(directory, 'empty') } });
  assert.equal(checks.find(check => check.id === 'disk').id, 'disk');
});
