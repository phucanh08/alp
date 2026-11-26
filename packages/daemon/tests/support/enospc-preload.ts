// Loaded with --import into a real alpd (t-2831): while the file named by ALP_TEST_DISK_FULL
// exists, alpd's disk takes no writes. Its log (fd 2 and fd 1, files here), its state writes
// and its disk probe fail with ENOSPC, as they did when the disk filled on 2026-10-29.
// ALP_TEST_DISK_FULL_ONLY narrows that to the files whose names contain it, and leaves the
// log and the probe alone (t-e80a): a test can then show which write reached the disk guard.
// Writes through an opened file handle fail too (the lock: exclusive create, then a write).
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const flag = process.env.ALP_TEST_DISK_FULL;
const only = process.env.ALP_TEST_DISK_FULL_ONLY;
const home = process.env.ALP_HOME;
const full = () => !!flag && fs.existsSync(flag);
const enospc = syscall => Object.assign(new Error(`ENOSPC: no space left on device, ${syscall}`), { code: 'ENOSPC', errno: -28, syscall });
const inHome = file => typeof file === 'string' && !!home && file.startsWith(home) && (!only || path.basename(file).includes(only));

const writeSync = fs.writeSync;
fs.writeSync = function (fd, ...rest) {
  if ((fd === 1 || fd === 2) && !only && full()) throw enospc('write');
  return writeSync.call(this, fd, ...rest);
};
const writeFile = fs.promises.writeFile;
fs.promises.writeFile = async function (file, ...rest) {
  if (inHome(file) && full()) throw enospc('open');
  return writeFile.call(this, file, ...rest);
};
const open = fs.promises.open;
fs.promises.open = async function (file, ...rest) {
  const handle = await open.call(this, file, ...rest);
  if (inHome(file) && full()) handle.writeFile = async () => { throw enospc('write'); };
  return handle;
};
syncBuiltinESMExports();
