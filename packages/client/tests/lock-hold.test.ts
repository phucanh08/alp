// On Windows alpd's lock is held by an open handle on alpd.lock.held (t-a5d8). Windows gives the
// pid of a killed alpd to another process within seconds while processes are being created, so a
// live pid alone does not prove a live alpd: the lock counts as held only while its hold is open.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { acquireDaemonLock, bootTime, daemonPaths, holdOps, lockAlive, readLock, releaseDaemonLock } from '../dist/index.js';

const windows = process.platform === 'win32';
const contents = { version: 't', protocolVersion: 1, socket: 's' };
const moduleUrl = new URL('../dist/index.js', import.meta.url).href;

/**
 * Teardown in reverse order of setup: node:test runs t.after hooks FIFO and stops at the first that
 * throws, so every step runs here and the first error is rethrown (ALP.md, node:test teardown order).
 */
function teardown(t: TestContext) {
  const steps: Array<() => unknown> = [];
  t.after(async () => {
    let failure;
    for (const step of steps.reverse()) try { await step(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  });
  return (step: () => unknown) => { steps.push(step); };
}
type Defer = ReturnType<typeof teardown>;

async function scratch(defer: Defer, prefix: string) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  defer(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return home;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

/** A process that is not alpd and holds nothing: the stand-in for a pid Windows reused. */
async function unrelated(defer: Defer) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  defer(() => stop(child));
  await once(child, 'spawn');
  return child.pid!;
}

const sameBoot = () => ({ bootTime: bootTime() });

test('lockAlive on Windows: a live pid whose hold is free is no live alpd', async t => {
  const defer = teardown(t);
  const pid = await unrelated(defer);
  const lock = { pid, ...sameBoot(), hold: path.join(os.tmpdir(), 'alpd.lock.held') };
  assert.equal(lockAlive(lock, { platform: 'win32', taken: () => false }), false, 'a reused pid does not keep the lock');
  assert.equal(lockAlive(lock, { platform: 'win32', taken: () => true }), true);
  const { hold, ...unmarked } = lock;
  assert.equal(lockAlive(unmarked, { platform: 'win32', taken: () => { throw new Error('an unmarked lock is never probed'); } }), true, 'a lock of an older alpd is judged by its pid');
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const [code] = await once(dead, 'exit');
  assert.equal(code, 0);
  assert.equal(lockAlive({ ...lock, pid: dead.pid! }, { platform: 'win32', taken: () => true }), false, 'a dead pid is gone whatever the hold says');
  assert.equal(lockAlive(lock, { platform: 'linux', taken: () => false }), true, 'other systems ignore the hold');
});

/** Hold operations that touch nothing: `take` gives a fake descriptor and `close` records it. */
function fakeOps({ take = () => 7, taken = (): boolean => true }: { take?: () => number, taken?: () => boolean } = {}) {
  const closed: unknown[] = [];
  return { closed, ops: { take, taken, close: (fd: number) => { closed.push(fd); } } };
}

test('acquire on Windows replaces a marked lock whose pid was reused', async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lock-hold-stale-');
  const { lock: file, hold } = daemonPaths(home);
  const pid = await unrelated(defer);
  await writeFile(file, JSON.stringify({ pid, ...sameBoot(), hold, ...contents }));
  const { closed, ops } = fakeOps();
  // We took the hold the lock names, so its owner is gone; its live pid is someone else.
  const lock = await acquireDaemonLock(home, contents, { platform: 'win32', ops });
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.hold, hold);
  assert.equal((await readLock(home))!.hold, hold);
  assert.deepEqual(closed, [], 'the hold stays open while the lock is ours');
  await releaseDaemonLock(home);
  assert.equal(await readLock(home), undefined);
  assert.deepEqual(closed, [7], 'release closes the hold after the lock is gone');
});

test('acquire on Windows still refuses an unmarked lock of a live pid and closes its hold', async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lock-hold-live-');
  const pid = await unrelated(defer);
  await writeFile(daemonPaths(home).lock, JSON.stringify({ pid, ...sameBoot(), ...contents }));
  const { closed, ops } = fakeOps();
  await assert.rejects(acquireDaemonLock(home, contents, { platform: 'win32', ops }), /already running/);
  assert.deepEqual(closed, [7]);
  assert.equal((await readLock(home))!.pid, pid, 'the other lock stays');
});

test('acquire on Windows refuses while another handle has the hold', async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lock-hold-busy-');
  const { lock: file, hold } = daemonPaths(home);
  const busy = () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
  // No lock written yet: another start has the hold and is about to write it.
  await assert.rejects(acquireDaemonLock(home, contents, { platform: 'win32', ops: fakeOps({ take: busy }).ops }), /another start is in progress/);
  const pid = await unrelated(defer);
  await writeFile(file, JSON.stringify({ pid, ...sameBoot(), hold, ...contents }));
  await assert.rejects(acquireDaemonLock(home, contents, { platform: 'win32', ops: fakeOps({ take: busy }).ops }), new RegExp(`already running \\(pid ${pid}\\)`));
  await writeFile(file, JSON.stringify({ pid, ...sameBoot(), hold, ...contents, maintenance: 'backup' }));
  await assert.rejects(acquireDaemonLock(home, contents, { platform: 'win32', ops: fakeOps({ take: busy }).ops }), /ALP is busy: alp backup runs/);
});

test('acquire on Windows goes on by pid alone when the hold does not exclude a second open', async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lock-hold-weak-');
  const { closed, ops } = fakeOps({ taken: () => false });
  const lock = await acquireDaemonLock(home, contents, { platform: 'win32', ops });
  defer(() => releaseDaemonLock(home));
  assert.equal(lock.hold, undefined, 'no marker that would not prove anything');
  assert.deepEqual(closed, [7]);
});

// The real handle, on Windows only.
const onWindows = { skip: !windows && 'the hold is a Windows handle', timeout: 30_000 };

/** A process that takes the lock of `home` and reports ready; `then` runs after (in its module). */
async function holder(defer: Defer, home: string, then = '') {
  const fixture = path.join(home, `holder-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(fixture, `import { acquireDaemonLock } from ${JSON.stringify(moduleUrl)};
    import { spawn } from 'node:child_process';
    await acquireDaemonLock(${JSON.stringify(home)}, ${JSON.stringify(contents)});
    const extra = {};
    ${then}
    process.send({ ready: true, ...extra });
    setInterval(() => {}, 1000);`);
  const child = fork(fixture, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  defer(() => stop(child));
  const [message] = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(10_000) }),
    once(child, 'exit').then(([code]) => { throw new Error(`holder exited ${code}: ${stderr}`); }),
  ]);
  assert.equal(message.ready, true);
  return { child, message };
}

test('a lock held by a live process refuses; once it is killed, its reused pid does not', onWindows, async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lock-hold-win-');
  const { lock: file, hold } = daemonPaths(home);
  const { child } = await holder(defer, home);
  const held = await readLock(home);
  assert.equal(held!.pid, child.pid);
  assert.equal(held!.hold, hold);
  assert.equal(lockAlive(held), true);
  await assert.rejects(acquireDaemonLock(home, contents), /already running/);
  await stop(child);
  // Windows gave the pid to another process: the lock names a live pid that holds nothing.
  const reused = await unrelated(defer);
  await writeFile(file, JSON.stringify({ ...held, pid: reused }));
  assert.equal(lockAlive(await readLock(home)), false);
  const lock = await acquireDaemonLock(home, contents);
  defer(() => releaseDaemonLock(home));
  assert.equal(lock.pid, process.pid);
  assert.equal(lockAlive(lock), true, 'our own hold is taken');
});

test('a second open of the hold fails while it is held, even in the same process', onWindows, async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lock-hold-open-');
  const { hold } = daemonPaths(home);
  const fd = holdOps.take(hold);
  defer(() => closeSync(fd));
  assert.throws(() => openSync(hold, 'r'), { code: 'EBUSY' });
  assert.throws(() => holdOps.take(hold), { code: 'EBUSY' });
  assert.equal(holdOps.taken(hold), true);
});

test('a child of the holder does not inherit the hold', onWindows, async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lock-hold-inherit-');
  const { hold } = daemonPaths(home);
  const { child, message } = await holder(defer, home, `
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    grandchild.unref();
    extra.grandchild = grandchild.pid;`);
  defer(() => { try { process.kill(message.grandchild, 'SIGKILL'); } catch {} });
  assert.ok(Number.isSafeInteger(message.grandchild));
  assert.equal(holdOps.taken(hold), true);
  await stop(child);
  process.kill(message.grandchild, 0); // the grandchild still runs
  assert.equal(holdOps.taken(hold), false, 'the hold went with the holder');
  const lock = await acquireDaemonLock(home, contents);
  defer(() => releaseDaemonLock(home));
  assert.equal(lock.pid, process.pid);
});

test('maintenance in this process releases its hold for the next alpd', onWindows, async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lock-hold-maint-');
  const { hold } = daemonPaths(home);
  const lock = await acquireDaemonLock(home, { ...contents, maintenance: 'backup' });
  assert.equal(lock.hold, hold);
  assert.equal(holdOps.taken(hold), true);
  await releaseDaemonLock(home);
  assert.equal(holdOps.taken(hold), false);
  assert.equal(await readLock(home), undefined);
  const { child } = await holder(defer, home);
  assert.equal((await readLock(home))!.pid, child.pid);
  assert.equal(JSON.parse(await readFile(daemonPaths(home).lock, 'utf8')).maintenance, undefined);
});
