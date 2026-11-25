// @ts-check
// Only for the acceptance runner's newly-created fake home. Live Paseo owns its lifecycle.
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A loopback port free right now, within the range the user settings accept for web.port (1024–65535).
 * @returns {Promise<number>}
 */
export async function freeWebPort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    // A TCP server listening on a port has an AddressInfo address; the cast states that.
    const port = await /** @type {Promise<number>} */ (new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const { port } = /** @type {net.AddressInfo} */ (server.address()); server.close(() => resolve(port)); });
    }));
    if (port >= 1024 && port <= 65535) return port;
  }
  throw new Error('no free loopback port from 1024 to 65535');
}

/**
 * A lock or metadata file of `home`, or undefined when there is none.
 * @param {string} home
 * @param {string} file
 * @returns {Promise<{ pid?: number } | undefined>}
 */
async function metadata(home, file) {
  try { return JSON.parse(await readFile(path.join(home, file), 'utf8')); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined; throw error; }
}

/** @param {number | undefined} pid */
async function stop(pid) {
  // Number.isSafeInteger does not narrow for the checker; past it, pid is a number (the casts below).
  if (!Number.isSafeInteger(pid) || /** @type {number} */ (pid) <= 1 || pid === process.pid) return;
  const signal = /** @param {NodeJS.Signals | 0} value */ value => {
    // The integer check above returned unless pid is a number; the cast states that.
    try { process.kill(/** @type {number} */ (pid), value); return true; }
    catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') return false; throw error; }
  };
  if (!signal('SIGTERM')) return;
  for (const [attempts, next] of /** @type {[number, NodeJS.Signals | null][]} */ ([[200, 'SIGKILL'], [80, null]])) {
    for (let i = 0; i < attempts; i++) {
      if (!signal(0)) return;
      await sleep(25);
    }
    if (next) signal(next);
  }
  throw new Error(`owned acceptance process ${pid} did not exit`);
}

/** Stop the reconnecting web integration first, then alpd, and await both before reporting success. */
/** @param {string} home @param {() => unknown} stopDaemon */
export async function cleanupFakeWeb(home, stopDaemon) {
  /** @type {Set<number>} */
  const web = new Set();
  for (const file of ['paseo.json', 'integrations/paseo.lock', 'dashboard.json', 'integrations/dashboard.lock', 'web.json', 'integrations/web.lock']) {
    const info = await metadata(home, file);
    if (info?.pid) web.add(info.pid);
  }
  for (const pid of web) await stop(pid);
  // Capture the owned daemon before the CLI removes its lock, including a partially-started daemon.
  const daemon = await metadata(home, 'alpd.lock');
  try { await stopDaemon(); }
  finally { await stop(daemon?.pid); }
}
