// acquireDaemonLock when the fstat right after its exclusive create fails (t-6147): the empty
// file it created is removed, so it cannot stop every later start.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, lstat, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

test('a failed fstat after the exclusive create leaves no lock behind', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-lock-fstat-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { acquireDaemonLock, daemonPaths } = await import('../src/index.js');
  const lockFile = daemonPaths(home).lock;
  await fs.promises.mkdir(path.dirname(lockFile), { recursive: true });
  const open = fs.promises.open;
  fs.promises.open = async function (file, ...rest) {
    const handle = await open.call(this, file, ...rest);
    if (file === lockFile) handle.stat = async () => { throw Object.assign(new Error('EIO: i/o error, fstat'), { code: 'EIO' }); };
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.open = open; syncBuiltinESMExports(); });
  await assert.rejects(acquireDaemonLock(home, { version: 't', protocolVersion: 1, socket: path.join(home, 's') }), { code: 'EIO' });
  await assert.rejects(lstat(lockFile), { code: 'ENOENT' });
  // The next start takes the lock.
  fs.promises.open = open; syncBuiltinESMExports();
  const lock = await acquireDaemonLock(home, { version: 't', protocolVersion: 1, socket: path.join(home, 's') });
  assert.equal(lock.pid, process.pid);
});

test('fstat failure must not unlink a successor lock (t-50af)', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-lock-successor-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { acquireDaemonLock, daemonPaths } = await import('../src/index.js');
  const file = daemonPaths(home).lock;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const open = fs.promises.open;
  fs.promises.open = async function (name, ...args) {
    const handle = await open.call(this, name, ...args);
    if (name === file) handle.stat = async () => {
      await rm(file);
      await writeFile(file, 'successor');
      throw Object.assign(new Error('fstat failed'), { code: 'EIO' });
    };
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.open = open; syncBuiltinESMExports(); });
  await assert.rejects(acquireDaemonLock(home, { version: 't', protocolVersion: 1, socket: 's' }), { code: 'EIO' });
  assert.equal(await readFile(file, 'utf8'), 'successor');
});

test('a daemon lock held by a separate live process refuses another owner (t-50af)', { timeout: 10_000 }, async t => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-lock-child-'));
  const module = new URL('../src/index.js', import.meta.url).href;
  const fixture = path.join(home, 'owner.mjs');
  await writeFile(fixture, `import { acquireDaemonLock } from ${JSON.stringify(module)};
    await acquireDaemonLock(${JSON.stringify(home)}, { version: 't', protocolVersion: 1, socket: 's' });
    process.send({ ready: true });
    setInterval(() => {}, 1000);`);
  const child = fork(fixture, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(home, { recursive: true, force: true });
  });
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(message.ready, true);
  const { acquireDaemonLock, readLock } = await import('../src/index.js');
  await assert.rejects(acquireDaemonLock(home, { version: 't', protocolVersion: 1, socket: 's' }), /daemon already running/);
  assert.equal((await readLock(home)).pid, child.pid, 'the competing owner remains intact');
});

test('when neither descriptor stat works, failure preserves the unidentified lock (t-50af)', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-lock-unidentified-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { acquireDaemonLock, daemonPaths } = await import('../src/index.js');
  const file = daemonPaths(home).lock;
  const open = fs.promises.open, fstat = fs.fstatSync;
  fs.promises.open = async function (name, ...args) {
    const handle = await open.call(this, name, ...args);
    if (name === file) handle.stat = async () => { throw Object.assign(new Error('fstat failed'), { code: 'EIO' }); };
    return handle;
  };
  fs.fstatSync = () => { throw new Error('fstatSync failed too'); };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.open = open; fs.fstatSync = fstat; syncBuiltinESMExports(); });
  await assert.rejects(acquireDaemonLock(home, { version: 't', protocolVersion: 1, socket: 's' }), { code: 'EIO' });
  assert.equal(await readFile(file, 'utf8'), '', 'leave recovery to the owner rather than guessing path identity');
});
