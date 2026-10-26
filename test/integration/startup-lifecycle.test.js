import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as clientApi from '@anhlp/alp-client';
const { bootTime, connect, daemonPaths, lockAlive, readLock, readDaemonLifecycle, withDaemonLifecycle } = clientApi;
import { serviceFor, serviceDefinition } from '@anhlp/alp-client/service';
import { daemonHeld, holdDaemon, startDaemon, superviseDaemon } from '@anhlp/alp-client/supervise';

const entry = fileURLToPath(new URL('../../packages/daemon/dist/alpd.js', import.meta.url));
const cli = fileURLToPath(new URL('../../packages/cli/dist/cli.js', import.meta.url));
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail('controlled startup checkpoint was not reached');
}
async function fixture(t, phase, armed = true) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-start-'));
  const gate = path.join(home, 'release');
  const arm = path.join(home, 'arm');
  if (armed) await writeFile(arm, 'armed');
  const arrivals = path.join(home, 'arrivals');
  const preload = path.join(home, 'gate.mjs');
  // Only the actual detached child is gated. Patch a filesystem boundary, leaving
  // launch, lock acquisition, readiness, and cross-process coordination real.
  await writeFile(preload, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.${phase === 'pre-lock' ? 'open' : 'writeFile'};
    fs.${phase === 'pre-lock' ? 'open' : 'writeFile'} = async function(file, ...args) {
      if (!process.argv.includes('--detach') && await fs.access(${JSON.stringify(arm)}).then(() => true, () => false) && String(file) === ${JSON.stringify(phase === 'pre-lock' ? daemonPaths(home).lock : path.join(home, 'state', 'alpd.running'))}) {
        await fs.appendFile(${JSON.stringify(arrivals)}, process.pid + '\\n');
        while (!await fs.access(${JSON.stringify(gate)}).then(() => true, () => false)) await new Promise(r => setTimeout(r, 10));
      }
      return original.call(this, file, ...args);
    };
    syncBuiltinESMExports();
  `);
  const env = { ...process.env, ALP_HOME: home, NODE_OPTIONS: `--import=${preload}` };
  const pids = async () => [...new Set((await readFile(arrivals, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number))];
  const release = () => writeFile(gate, 'go');
  t.after(async () => {
    await release();
    // Kill only children whose identity this fixture recorded at its own gate.
    for (const pid of await pids()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(home, { recursive: true, force: true });
  });
  return { home, env, pids, release, arm: () => writeFile(arm, 'armed'), arrived: () => until(async () => (await pids()).length > 0) };
}

for (const phase of ['pre-lock', 'post-lock']) {
  test(`supervisor stop drains its own ${phase} child even if another ready lock appears`, async t => {
    const f = await fixture(t, phase);
    const stop = superviseDaemon({ ...f, entry, intervalMs: 10 });
    t.after(stop);
    await f.arrived();
    const own = await readLock(f.home);
    await writeFile(daemonPaths(f.home).lock, JSON.stringify({ pid: process.pid, bootTime: bootTime(), ready: true, socket: 'unrelated' }));
    let settled = false;
    const stopping = stop().then(() => { settled = true; });
    // Await the precise old ready-poll boundary, rather than daemon boot speed.
    await delay(300);
    assert.equal(settled, false, 'an unrelated ready lock must not settle the owned child');
    if (own) await writeFile(daemonPaths(f.home).lock, JSON.stringify(own));
    else await rm(daemonPaths(f.home).lock);
    await f.release();
    await stopping;
    assert.ok(lockAlive(await readLock(f.home)));
  });
}

test('manual pre-lock startup and periodic supervisor recovery share one launch', async t => {
  const f = await fixture(t, 'pre-lock', false);
  let recovery = false;
  let looked = false;
  const stop = superviseDaemon({ ...f, entry: () => { if (recovery) looked = true; return entry; }, intervalMs: 25, misses: 2 });
  t.after(stop);
  await stop.started;
  const first = await readLock(f.home);
  await holdDaemon(f.home);
  process.kill(first.pid, 'SIGKILL');
  await until(async () => !lockAlive(await readLock(f.home)));
  await f.arm();
  recovery = true;
  const manual = startDaemon({ ...f, entry });
  await f.arrived();
  let contended = false;
  const originalRename = fs.rename;
  fs.rename = async function(file, destination, ...args) {
    if (String(destination) === path.join(f.home, 'state', 'alpd.starting')) contended = true;
    return originalRename.call(this, file, destination, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.rename = originalRename; syncBuiltinESMExports(); });
  await until(() => looked);
  await until(async () => contended || (await f.pids()).length === 2);
  const stopping = stop();
  await f.release();
  await Promise.all([manual, stopping]);
  assert.equal((await f.pids()).length, 1, 'only one detached child may be created');
});

for (const phase of ['pre-lock', 'post-lock']) {
  test(`startup preserves a stop hold published at ${phase}`, async t => {
    const f = await fixture(t, phase);
    const starting = startDaemon({ ...f, entry });
    await f.arrived();
    await holdDaemon(f.home);
    await f.release();
    await starting;
    assert.equal(await daemonHeld(f.home), true);
    const lock = await readLock(f.home);
    const client = await connect(lock.socket);
    await client.request('daemon.shutdown').finally(() => client.close());
    await until(async () => !lockAlive(await readLock(f.home)));
    assert.equal(await daemonHeld(f.home), true);
  });
}

for (const phase of ['pre-lock', 'post-lock']) {
  test(`CLI stop drains a ${phase} startup and leaves it held`, async t => {
    const f = await fixture(t, phase);
    const starting = startDaemon({ ...f, entry });
    await f.arrived();
    let stopped = false;
    const stopping = exec(process.execPath, [cli, 'daemon', 'stop'], { env: f.env }).then(result => { stopped = true; return result; });
    await until(() => daemonHeld(f.home));
    assert.equal(stopped, false);
    await f.release();
    await Promise.all([starting, stopping]);
    assert.equal(lockAlive(await readLock(f.home)), false);
    assert.equal(await daemonHeld(f.home), true);
    assert.equal((await f.pids()).length, 1);
  });
}

test('registered service retains admission after requesting client times out; CLI stop drains it', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t, 'pre-lock');
  const manager = path.join(f.home, 'launchctl');
  const serviceDir = path.join(f.home, 'services');
  f.env.ALP_SERVICE_DIR = serviceDir;
  f.env.ALP_LAUNCHCTL = manager;
  await mkdir(serviceDir);
  // Replace only the OS manager command. It launches the real --service entry,
  // and waits for the service's admission checkpoint before returning to the client.
  await writeFile(manager, `#!${process.execPath}
` + `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, [${JSON.stringify(entry)}, '--service'], { detached: true, stdio: 'ignore', env: ${JSON.stringify(f.env)} });
    child.unref();
    const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(path.join(f.home, 'arrivals'))})) { clearInterval(timer); } }, 10);
  `);
  await chmod(manager, 0o700);
  const service = serviceFor({ home: f.home, env: f.env });
  await writeFile(service.file, serviceDefinition(service, { home: f.home, entry, env: f.env }));
  await assert.rejects(startDaemon({ ...f, entry, timeoutMs: 100 }), /did not become ready/);
  await f.arrived();
  const [pid] = await f.pids();
  assert.equal((await readDaemonLifecycle(f.home)).pid, pid, 'service retains its own admission after requester leaves');
  let stopped = false;
  const stopping = exec(process.execPath, [cli, 'daemon', 'stop'], { env: f.env }).then(result => { stopped = true; return result; });
  await until(() => daemonHeld(f.home));
  assert.equal(stopped, false);
  await f.release();
  await stopping;
  assert.equal(lockAlive(await readLock(f.home)), false);
  assert.equal(await daemonHeld(f.home), true);
});

test('automatic restart rechecks a hold published while waiting for admission', async t => {
  const f = await fixture(t, 'pre-lock', false);
  let recovering = false;
  let entered = false;
  const logs = [];
  const stop = superviseDaemon({ ...f, entry: () => { if (recovering) entered = true; return entry; }, intervalMs: 10, misses: 1, log: message => logs.push(message) });
  t.after(stop);
  await stop.started;
  const first = await readLock(f.home);
  await withDaemonLifecycle(f.home, 'stop', async () => {
    recovering = true;
    process.kill(first.pid, 'SIGKILL');
    await until(() => entered);
    await holdDaemon(f.home);
  });
  await stop();
  assert.equal(await daemonHeld(f.home), true);
  assert.equal(lockAlive(await readLock(f.home)), false);
  assert.deepEqual(logs, ['alpd started']);
});

test('direct service login lifts the existing hold and preserves a newer stop', async t => {
  const f = await fixture(t, 'pre-lock');
  await holdDaemon(f.home);
  const service = spawn(process.execPath, [entry, '--service'], { env: f.env, stdio: 'ignore' });
  const exited = new Promise(resolve => service.once('exit', resolve));
  await f.arrived();
  assert.equal(await daemonHeld(f.home), false);
  const stopping = exec(process.execPath, [cli, 'daemon', 'stop'], { env: f.env });
  await until(() => daemonHeld(f.home));
  await f.release();
  await stopping;
  await exited;
  assert.equal(await daemonHeld(f.home), true);
  assert.equal(lockAlive(await readLock(f.home)), false);
});

test('startup timeout kills only its own unresponsive child and waits for its exit', async t => {
  const f = await fixture(t, 'pre-lock');
  const preload = path.join(f.home, 'gate.mjs');
  await fs.appendFile(preload, `
if (!process.argv.includes('--detach')) process.on('SIGTERM', () => {});
`);
  const starting = startDaemon({ ...f, entry, timeoutMs: 1_000 });
  const failed = assert.rejects(starting, /startup timed out/);
  await f.arrived();
  const [pid] = await f.pids();
  await failed;
  assert.equal(lockAlive({ pid, bootTime: bootTime() }), false);
  assert.equal(await readDaemonLifecycle(f.home), undefined);
  assert.equal(lockAlive({ pid: process.pid, bootTime: bootTime() }), true);
});

test('startup admission serializes processes racing to reap a dead owner', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-admit-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'state', 'alpd.starting');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `owner-2147483647-${bootTime()}-start-00000000-0000-0000-0000-000000000000`), '');
  const script = `
    import { withDaemonLifecycle } from ${JSON.stringify(new URL('../../packages/client/src/index.js', import.meta.url).href)};
    import { mkdir, rmdir } from 'node:fs/promises';
    await withDaemonLifecycle(${JSON.stringify(home)}, 'start', async () => {
      await mkdir(${JSON.stringify(path.join(home, 'critical'))});
      await new Promise(r => setTimeout(r, 25));
      await rmdir(${JSON.stringify(path.join(home, 'critical'))});
    });
  `;
  await Promise.all(Array.from({ length: 8 }, () => exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ALP_HOME: home } })));
  assert.equal(await readDaemonLifecycle(home), undefined);
});
