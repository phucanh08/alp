#!/usr/bin/env node
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { alpHome, readLock, lockAlive, bootTime } from '@anhlp/alp-client/index';
import { superviseDaemon } from '@anhlp/alp-client/supervise';
import { validateUserSettings } from '@anhlp/alp-core/validation';
import { createWebServer } from './web.js';
import { createPaseoBridge, webAppDir } from './paseo/index.js';

declare const __ALP_DAEMON_ENTRY__: string | undefined;

const VERSION = '0.9.5';

function serviceLog(home: string) {
  const log = path.join(home, 'logs', 'integrations', 'paseo.log');
  // ensure parent synchronously
  const parent = path.dirname(log);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const fd = openSync(log, 'a', 0o600);
  for (const stream of [process.stdout, process.stderr]) {
    stream.write = ((chunk: any) => { try { writeSync(fd, chunk); } catch {} return true; }) as any;
  }
}

async function userSettings(home: string): Promise<any> {
  const file = path.join(home, 'settings.json');
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return {}; }
  try { return validateUserSettings(JSON.parse(text), file); }
  catch (error: any) {
    console.error(`${new Date().toISOString()} ignoring ${file}: ${error?.message ?? error}`);
    return {};
  }
}

function integrationLockPath(home: string) {
  return path.join(home, 'integrations', 'web.lock');
}

async function readIntegrationLock(home: string) {
  try { return JSON.parse(await readFile(integrationLockPath(home), 'utf8')); } catch { return undefined; }
}

function integrationAlive(lock: any) {
  if (!lock || !Number.isSafeInteger(lock.pid)) return false;
  try { process.kill(lock.pid, 0); } catch (error: any) { return error?.code === 'EPERM'; }
  const currentBoot = bootTime();
  if (typeof lock.bootTime === 'number' && Math.abs(lock.bootTime - currentBoot) > 30) return false;
  return true;
}

async function acquireIntegrationLock(home: string) {
  await mkdir(path.dirname(integrationLockPath(home)), { recursive: true, mode: 0o700 });
  const file = integrationLockPath(home);
  const current = await readIntegrationLock(home);
  if (current && integrationAlive(current)) {
    return { acquired: false, lock: current };
  }
  // Stale lock reclaim race-safe: exclusive create. Never unlink a live, fresh, or malformed
  // lock that another contender is still writing; a reclaim is serialized through a marker file.
  const reclaim = `${file}.reclaim`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = { pid: process.pid, bootTime: bootTime(), startedAt: new Date().toISOString(), ready: false };
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(value));
      await handle.close();
      return { acquired: true, lock: value };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const again = await readIntegrationLock(home);
      if (again && integrationAlive(again)) return { acquired: false, lock: again };
      const info = await stat(file).catch(() => undefined);
      // Grace: an empty or malformed file may be mid-creation; reclaim only after it is old enough.
      const ageMs = info ? Date.now() - info.mtimeMs : Number.POSITIVE_INFINITY;
      if (ageMs < 1_500) { await new Promise(resolve => setTimeout(resolve, 150)); continue; }
      const raw = await readFile(file, 'utf8').catch(() => undefined);
      if (raw === undefined) continue;
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      if (parsed && integrationAlive(parsed)) return { acquired: false, lock: parsed };
      if (raw && again && JSON.stringify(again) !== raw) continue;
      // Serialize stale reclaim so two contenders cannot delete each other's lock.
      try {
        const marker = await open(reclaim, 'wx', 0o600);
        await marker.close();
      } catch (markerError: any) {
        if (markerError?.code !== 'EEXIST') throw markerError;
        // A reclaimer that crashed may leave its marker behind; drop it once it is clearly stale.
        const markerInfo = await stat(reclaim).catch(() => undefined);
        if (markerInfo && Date.now() - markerInfo.mtimeMs > 2_000) await unlink(reclaim).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 150));
        continue;
      }
      try {
        const latest = await readFile(file, 'utf8').catch(() => undefined);
        if (latest !== undefined && latest === raw) await unlink(file).catch(() => {});
      } finally {
        await unlink(reclaim).catch(() => {});
      }
      continue;
    }
  }
  throw new Error('Could not acquire the integration lock');
}

async function markReady(home: string) {
  const lock = await readIntegrationLock(home);
  if (!lock || lock.pid !== process.pid) return;
  lock.ready = true;
  const file = integrationLockPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(lock), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * The inverse of markReady, for the moment the daemon connection drops: publish our own lock as
 * not-ready atomically, so a caller waiting for the ready lock stops relying on a registration that
 * no longer exists (the connection is re-registered below).
 */
async function clearReady(home: string) {
  const lock = await readIntegrationLock(home);
  if (!lock || lock.pid !== process.pid || lock.ready !== true) return;
  lock.ready = false;
  const file = integrationLockPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(lock), { mode: 0o600 });
  await rename(tmp, file);
}

async function releaseIntegrationLock(home: string) {
  const lock = await readIntegrationLock(home);
  if (lock?.pid === process.pid) {
    await unlink(integrationLockPath(home)).catch(() => {});
  }
}

async function run(home: string) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const settings = await userSettings(home);
  if (settings?.web?.enabled === false) {
    console.log(`${new Date().toISOString()} web app disabled by settings`);
    process.exit(0);
  }

  const { acquired, lock } = await acquireIntegrationLock(home);
  if (!acquired) {
    console.log(`${new Date().toISOString()} integration already running (pid ${lock.pid})`);
    process.exit(0);
  }

  const webLog = (message: string) => console.log(`${new Date().toISOString()} web: ${message}`);
  const appDir = webAppDir(fileURLToPath(import.meta.url));
  if (!appDir) webLog('the web app is not built beside the integration; the page says how to build it');
  let listening: string | null = null;
  const gateway = appDir ? createPaseoBridge({ version: VERSION, home, token: () => web?.token ?? '', serverId: () => web?.serverId ?? '', relay: settings?.web?.relay, listen: () => listening, log: webLog }) : undefined;
  const web = createWebServer({ app: appDir && gateway ? { dir: appDir, gateway } : undefined, home, port: settings?.web?.port, log: webLog });
  // Ready is published only after web.pairing is registered (below), so a caller that waits for the
  // ready lock can rely on the RPC being served; marking ready here would race callers of web.pairing.
  await web.listen().then(info => { listening = `127.0.0.1:${info.port}`; console.log(`${new Date().toISOString()} web app on ${info.url}`); })
    .catch(async error => { console.error(`${new Date().toISOString()} web app not started`, error); await releaseIntegrationLock(home); process.exit(1); });
  const relay = web.token && gateway ? gateway.relay : undefined;
  await relay?.start().catch(error => webLog(`relay not started: ${error?.message ?? error}`));

  // Keep daemon available.
  const stopDaemon = process.env.ALP_SUPERVISE === '0'
    ? async () => {}
    : superviseDaemon({ home, entry: () => process.env.ALP_DAEMON_ENTRY ?? fileURLToPath(new URL('./alpd.js', import.meta.url)), log: message => console.error(`alp: ${message}`) });

  let shuttingDown = false;
  let extensionClient: any = null;
  const pairingHandler = async (params: any = {}) => {
    const currentRelay = (web as any)?.token && gateway ? gateway.relay : undefined;
    if (!currentRelay) throw new Error('alpd serves no web app, so it has no relay');
    if (typeof params?.enable === 'boolean') await currentRelay.setEnabled(params.enable);
    return { ...(await currentRelay.offer()), connected: currentRelay.connected, ...currentRelay.config() };
  };

  let registrationInFlight = false;
  let registrationPending = false;
  async function ensurePairingRegistration() {
    if (shuttingDown) return;
    if (registrationInFlight) { registrationPending = true; return; }
    registrationInFlight = true;
    try {
      do {
        registrationPending = false;
        try {
          const lock = await readLock(home);
          if (!lock?.ready) { await new Promise(resolve => setTimeout(resolve, 200)); registrationPending = true; continue; }
          // Remove any stale client before reconnecting after daemon restart.
          if (extensionClient) { try { extensionClient.close(); } catch {} extensionClient = null; }
          const client = await (await import('@anhlp/alp-client/index')).connect(lock.socket);
          extensionClient = client;
          let closed = false;
          client.onClose(() => {
            if (closed) return;
            closed = true;
            if (extensionClient === client) extensionClient = null;
            // Our own ready flag describes a registration that has just gone away with the socket.
            if (!shuttingDown) {
              void clearReady(home);
              void ensurePairingRegistration();
            }
          });
          client.onRequest(async (method: string, params: any) => {
            if (method !== 'extension.invoke') return undefined;
            if (params?.method !== 'web.pairing') return undefined;
            return await pairingHandler(params?.params ?? {});
          });
          try {
            await client.request('extension.register', { method: 'web.pairing' });
          } catch (error: any) {
            if (extensionClient === client) { try { client.close(); } catch {} extensionClient = null; }
            throw error;
          }
          // A close during registration is swallowed by the in-flight guard; notice it and retry
          // so the extension ends up registered on a live connection.
          if (closed) { registrationPending = true; continue; }
          webLog('registered web.pairing');
          await markReady(home);
          // The socket may have dropped while ready was being published; the ready flag would then
          // describe a dead registration, so re-check and let the retry loop reconnect.
          if (closed) { await clearReady(home); registrationPending = true; continue; }
          return;
        } catch (error: any) {
          if (extensionClient) { try { extensionClient.close(); } catch {} extensionClient = null; }
          webLog(`waiting to register web.pairing: ${error?.message ?? error}`);
          await new Promise(resolve => setTimeout(resolve, 300));
          registrationPending = true;
        }
      } while (registrationPending && !shuttingDown);
    } finally {
      registrationInFlight = false;
    }
  }
  void ensurePairingRegistration();

  const shutdown = async (code = 0) => {
    shuttingDown = true;
    if (extensionClient) { try { await extensionClient.request('extension.unregister', { method: 'web.pairing' }); } catch {} extensionClient.close(); extensionClient = null; }
    await web.close().catch(() => {});
    await relay?.stop?.().catch(() => {});
    await (gateway as any)?.close?.().catch(() => {});
    await stopDaemon().catch(() => {});
    await releaseIntegrationLock(home);
    process.exit(code);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown());
  process.on('uncaughtException', error => { console.error(`${new Date().toISOString()} fatal`, error); void shutdown(1); });

  const beat = setInterval(() => {}, 60_000);
  beat.unref();
}

const home = alpHome();
if (process.argv.includes('--register')) {
  await mkdir(path.join(home, 'integrations'), { recursive: true, mode: 0o700 });
  const entry = fileURLToPath(import.meta.url);
  const file = path.join(home, 'integrations', 'web.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ main: entry, registeredAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(tmp, file);
  console.log(`${new Date().toISOString()} registered ${entry}`);
  process.exit(0);
}
// `--register` prints the descriptor to stdout and exits above, so its output is preserved. Every
// other launch gets its own log: the CLI and the supervisor start the integration detached with its
// stdio ignored, so without this the advertised ~/.alp/logs/integrations/paseo.log never appears and
// startup errors are lost. `--service` is accepted for the service launcher and is now the default.
serviceLog(home);
await run(home);
