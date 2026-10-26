#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { alpHome, readLock } from '@anhlp/alp-client/index';
import { superviseDaemon } from '@anhlp/alp-client/supervise';
import { validateUserSettings } from '@anhlp/alp-core/validation';
import { createLogger } from '@anhlp/alp-core/log';
import { createWebServer } from './web.js';
import { createIntegrationLock } from '@anhlp/alp-client/integration-lock';
import { createPaseoBridge, webAppDir } from './paseo/index.js';

const log = createLogger({ component: 'alp-integration' });

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
    log.warn(`ignoring ${file}: ${error?.message ?? error}`, { code: 'ALP_SETTINGS_INVALID' });
    return {};
  }
}

async function run(home: string) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const settings = await userSettings(home);
  if (settings?.web?.enabled === false) {
    log.info('web app disabled by settings', { event: 'web.disabled' });
    process.exit(0);
  }

  const integrationLock = createIntegrationLock(home, 'paseo');
  const { acquired, lock } = await integrationLock.acquire();
  if (!acquired) {
    log.info(`integration already running (pid ${lock.pid})`, { code: 'ALP_LOCK_HELD' });
    process.exit(0);
  }
  // A failed release leaves the lock and guard in place (fail closed); report it and stop anyway.
  const releaseLock = () => integrationLock.release().catch(error => {
    log.error('integration lock not released; the integration stops anyway', { code: 'ALP_LOCK_RELEASE_FAILED', error });
  });

  const webLog = (message: string) => log.info(`web: ${message}`);
  const appDir = webAppDir(fileURLToPath(import.meta.url));
  if (!appDir) webLog('the web app is not built beside the integration; the page says how to build it');
  let listening: string | null = null;
  const gateway = appDir ? createPaseoBridge({ version: VERSION, home, token: () => web?.token ?? '', serverId: () => web?.serverId ?? '', relay: settings?.web?.relay, listen: () => listening, log: webLog }) : undefined;
  // Port 0: `web.port` belongs to alp-web; this listener serves only daemon.get_status and Paseo sockets with the token.
  const web = createWebServer({ app: appDir && gateway ? { dir: appDir, gateway } : undefined, home, port: 0, log: webLog });
  // Ready is published only after web.pairing is registered (below), so a caller that waits for the
  // ready lock can rely on the RPC being served; marking ready here would race callers of web.pairing.
  await web.listen().then(info => { listening = `127.0.0.1:${info.port}`; log.info(`web app on ${info.url}`, { event: 'web.listening' }); })
    .catch(async error => { log.error('web app not started', { code: 'ALP_WEB_START_FAILED', error }); await releaseLock(); process.exit(1); });
  const relay = web.token && gateway ? gateway.relay : undefined;
  await relay?.start().catch(error => webLog(`relay not started: ${error?.message ?? error}`));

  // Keep daemon available.
  const stopDaemon = process.env.ALP_SUPERVISE === '0'
    ? async () => {}
    : superviseDaemon({ home, entry: () => process.env.ALP_DAEMON_ENTRY ?? fileURLToPath(new URL('./alpd.js', import.meta.url)), by: 'Paseo', log: message => log.warn(message, { code: 'ALP_DAEMON_SUPERVISION' }) });

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
              void integrationLock.setReady(false).catch(error => log.warn('integration ready flag not cleared', { code: 'ALP_LOCK_READY_FAILED', error }));
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
          await integrationLock.setReady(true);
          // The socket may have dropped while ready was being published; the ready flag would then
          // describe a dead registration, so re-check and let the retry loop reconnect.
          if (closed) { await integrationLock.setReady(false); registrationPending = true; continue; }
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
    // A later signal or uncaught exception must not start a second shutdown and release; the
    // first one always reaches exit, even if a step throws.
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (extensionClient) { try { await extensionClient.request('extension.unregister', { method: 'web.pairing' }); } catch {} extensionClient.close(); extensionClient = null; }
      await web.close().catch(() => {});
      await relay?.stop?.().catch(() => {});
      await (gateway as any)?.close?.().catch(() => {});
      await stopDaemon().catch(() => {});
      await releaseLock();
    } finally { process.exit(code); }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown());
  process.on('uncaughtException', error => { log.error('uncaught exception; the integration stops', { code: 'ALP_FATAL', error }); void shutdown(1); });

  const beat = setInterval(() => {}, 60_000);
  beat.unref();
}

const home = alpHome();
if (process.argv.includes('--register')) {
  await mkdir(path.join(home, 'integrations'), { recursive: true, mode: 0o700 });
  const entry = fileURLToPath(import.meta.url);
  const file = path.join(home, 'integrations', 'paseo.json');
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
