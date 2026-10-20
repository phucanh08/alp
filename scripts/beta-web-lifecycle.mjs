// Only for the acceptance runner's newly-created fake home. Live Paseo owns its lifecycle.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

async function metadata(home, file) {
  try { return JSON.parse(await readFile(path.join(home, file), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function stop(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  const signal = value => {
    try { process.kill(pid, value); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  if (!signal('SIGTERM')) return;
  for (const [attempts, next] of [[200, 'SIGKILL'], [80, null]]) {
    for (let i = 0; i < attempts; i++) {
      if (!signal(0)) return;
      await sleep(25);
    }
    if (next) signal(next);
  }
  throw new Error(`owned acceptance process ${pid} did not exit`);
}

/** Stop the reconnecting web integration first, then alpd, and await both before reporting success. */
export async function cleanupFakeWeb(home, stopDaemon) {
  const web = new Set();
  for (const file of ['web.json', 'integrations/web.lock']) {
    const info = await metadata(home, file);
    if (info?.pid) web.add(info.pid);
  }
  for (const pid of web) await stop(pid);
  // Capture the owned daemon before the CLI removes its lock, including a partially-started daemon.
  const daemon = await metadata(home, 'alpd.lock');
  try { await stopDaemon(); }
  finally { await stop(daemon?.pid); }
}
