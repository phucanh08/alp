// Only for the acceptance runner's newly-created fake home. Live Paseo owns its lifecycle.
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A loopback port free right now, within the range the user settings accept for web.port (1024–65535).
 */
export async function freeWebPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    // A TCP server listening on a port has an AddressInfo address; the cast states that.
    const port = await (new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const { port } = (server.address() as net.AddressInfo); server.close(() => resolve(port)); });
    }) as Promise<number>);
    if (port >= 1024 && port <= 65535) return port;
  }
  throw new Error('no free loopback port from 1024 to 65535');
}

/**
 * A lock or metadata file of `home`, or undefined when there is none.
 */
async function metadata(home: string, file: string): Promise<{ pid?: number; }|undefined> {
  try { return JSON.parse(await readFile(path.join(home, file), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function stop(pid: number|undefined) {
  // Number.isSafeInteger does not narrow for the checker; past it, pid is a number (the casts below).
  if (!Number.isSafeInteger(pid) || (pid as number) <= 1 || pid === process.pid) return;
  const signal = (value: NodeJS.Signals|0) => {
    // The integer check above returned unless pid is a number; the cast states that.
    try { process.kill((pid as number), value); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  };
  if (!signal('SIGTERM')) return;
  for (const [attempts, next] of ([[200, 'SIGKILL'], [80, null]] as [number, NodeJS.Signals | null][])) {
    for (let i = 0; i < attempts; i++) {
      if (!signal(0)) return;
      await sleep(25);
    }
    if (next) signal(next);
  }
  throw new Error(`owned acceptance process ${pid} did not exit`);
}

/** Stop the reconnecting web integration first, then alpd, and await both before reporting success. */
export async function cleanupFakeWeb(home: string, stopDaemon: () => unknown) {
  const web: Set<number> = new Set();
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
