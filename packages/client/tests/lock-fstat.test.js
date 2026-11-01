// acquireDaemonLock when the fstat right after its exclusive create fails (t-6147): the empty
// file it created is removed, so it cannot stop every later start.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
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
