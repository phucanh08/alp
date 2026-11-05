// Hard per-file wall-clock limit, including leaked handles after tests finish.
// Normal files run without process instrumentation. This is not containment:
// detached descendants may survive a timeout, so shared scratch is retained.
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { unlinkSync } from 'node:fs';

const { files, extra, fileTimeoutMs } = JSON.parse(process.argv[2]);
let next = 0;
let failed = false;
let retainScratch = false;
const active = new Set();
function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 });
    if (result.error || result.status !== 0) console.error(`[test-file] taskkill failed: ${result.error?.message || `status ${result.status}`}`);
  } else {
    // The still-held root is its own process-group leader. Never enumerate or
    // signal stored descendant PIDs after their spawning handles have gone.
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') console.error(`[test-file] process-group kill failed: ${error.message}`); }
  }
  child.kill('SIGKILL');
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  console.error('[test-file] interrupted; retaining scratch; detached descendants may survive');
  for (const child of active) stop(child);
  process.exit(signal === 'SIGINT' ? 130 : 143);
});
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    const started = Date.now();
    console.error(`[test-file] START ${file}`);
    const child = spawn(process.execPath, ['--test', '--test-timeout=300000', ...extra, file], {
      stdio: ['inherit', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    active.add(child);
    let timedOut = false;
    // A detached process may retain output after the root exits. Pipe through
    // this coordinator so the deadline can close its local read handles too.
    const status = await new Promise(resolve => {
      const timer = setTimeout(() => {
        timedOut = true;
        retainScratch = true;
        console.error(`[test-file] TIMEOUT ${file} after ${fileTimeoutMs} ms; retaining scratch; detached descendants may survive`);
        stop(child);
        // A failed kill must not defeat the deadline.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        resolve(1);
      }, fileTimeoutMs);
      child.once('error', error => {
        retainScratch = true;
        console.error(`[test-file] ${file}: ${error.message}`);
        clearTimeout(timer); resolve(1);
      });
      child.once('close', (code, signal) => {
        if (signal) retainScratch = true;
        clearTimeout(timer); resolve(code ?? 1);
      });
    });
    active.delete(child);
    const ok = status === 0 && !timedOut;
    if (!ok) failed = true;
    console.error(`[test-file] ${ok ? 'PASS' : 'FAIL'} ${file} (${Date.now() - started} ms)`);
  }
}
await Promise.all(Array.from({ length: Math.min(files.length, Math.max(1, availableParallelism() - 1)) }, worker));
if (!retainScratch && process.env.ALP_TEST_RETAIN) unlinkSync(process.env.ALP_TEST_RETAIN);
process.exitCode = failed ? 1 : 0;
