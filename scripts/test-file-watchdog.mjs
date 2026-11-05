// Internal coordinator for test-lib: each file gets a hard wall-clock limit, including
// time after its tests finish when leaked handles can keep Node's test child alive.
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

const { files, extra, fileTimeoutMs } = JSON.parse(process.argv[2]);
let next = 0;
let failed = false;
const active = new Set();
function stop(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  child.kill('SIGKILL');
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  for (const child of active) stop(child);
  process.exit(signal === 'SIGINT' ? 130 : 143);
});
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    const started = Date.now();
    console.error(`[test-file] START ${file}`);
    const child = spawn(process.execPath, ['--test', '--test-timeout=300000', ...extra, file], {
      stdio: 'inherit', detached: process.platform !== 'win32',
    });
    active.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[test-file] TIMEOUT ${file} after ${fileTimeoutMs} ms; killing its process tree`);
      stop(child);
    }, fileTimeoutMs);
    const status = await new Promise(resolve => {
      child.once('error', error => { console.error(`[test-file] ${file}: ${error.message}`); resolve(1); });
      child.once('close', code => resolve(code ?? 1));
    });
    clearTimeout(timer);
    active.delete(child);
    const ok = status === 0 && !timedOut;
    if (!ok) failed = true;
    console.error(`[test-file] ${ok ? 'PASS' : 'FAIL'} ${file} (${Date.now() - started} ms)`);
  }
}
await Promise.all(Array.from({ length: Math.min(files.length, Math.max(1, availableParallelism() - 1)) }, worker));
process.exitCode = failed ? 1 : 0;
