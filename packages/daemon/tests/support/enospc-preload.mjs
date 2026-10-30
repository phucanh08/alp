// Loaded with --import into a real alpd (t-2831): while the file named by ALP_TEST_DISK_FULL
// exists, alpd's disk takes no writes. Its log (fd 2 and fd 1, files here), its state writes
// and its disk probe fail with ENOSPC, as they did when the disk filled on 2026-10-29.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const flag = process.env.ALP_TEST_DISK_FULL;
const home = process.env.ALP_HOME;
const full = () => !!flag && fs.existsSync(flag);
const enospc = syscall => Object.assign(new Error(`ENOSPC: no space left on device, ${syscall}`), { code: 'ENOSPC', errno: -28, syscall });
const inHome = file => typeof file === 'string' && !!home && file.startsWith(home);

const writeSync = fs.writeSync;
fs.writeSync = function (fd, ...rest) {
  if ((fd === 1 || fd === 2) && full()) throw enospc('write');
  return writeSync.call(this, fd, ...rest);
};
const writeFile = fs.promises.writeFile;
fs.promises.writeFile = async function (file, ...rest) {
  if (inHome(file) && full()) throw enospc('open');
  return writeFile.call(this, file, ...rest);
};
syncBuiltinESMExports();
