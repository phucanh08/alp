// DO NOT MERGE (t-840a0 evidence only): hangs on purpose so the watchdog's 300 s deadline fires and
// prints its dump, with this file's child process in the process section.
import test from 'node:test';
import { spawn } from 'node:child_process';

test('hangs until the watchdog deadline (t-840a0 hang-dump evidence)', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  console.log(`hang-evidence child pid ${child.pid}, own pid ${process.pid}`);
  await new Promise(() => {});
});
