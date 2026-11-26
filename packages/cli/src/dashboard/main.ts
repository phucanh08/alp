#!/usr/bin/env node
/**
 * alp-dashboard (docs/alp/dashboard.md): the service behind `alp dashboard`. ONE loopback listener at
 * `--port`, else `dashboard.port` (default 7433, then the next nine ports), carries the ALP gateway and
 * the built apps/web files. It owns the `dashboard` integration lock and `<home>/dashboard.json`, which
 * names its pid, port, URL and credential id. The `alpgw1.*` token of its credential is in no file
 * (t-cee3): every start mints a fresh credential, revokes the earlier ones, keeps the token in memory
 * and hands it to `alp dashboard [--print]` over its private token socket (./token-socket.js), so the
 * CLI can open the app with the token in the address.
 * It keeps alpd running (ALP_SUPERVISE=0 opts out) and keeps the credential's workspaces in step
 * with alpd's project registry.
 *
 * Its gateway is created with `owner` (docs/alp/remote-gateway.md §5.19): its own credential, on a
 * direct loopback socket, is the host owner and may call the methods the exposure matrix marks
 * `owner`, answered by alpd or by the handlers of ./owner/. The credential is read live (grant.id),
 * so after a rotate the old token is not the owner. Standalone `alp-gateway serve` has no owner.
 *
 *   node alp-dashboard.js [--service] [--project DIR] [--port N]
 *   node alp-dashboard.js --rotate [--project DIR]
 * `--service` (how startIntegration starts it) writes the log to <home>/logs/integrations/alp-dashboard.log.
 * `--rotate` (how `alp dashboard rotate` ends the token) takes the dashboard lock, which fails with exit 3
 * while the service runs, revokes every credential, releases the lock and exits; the next start mints
 * a new one. It ignores dashboard.enabled: turning alp dashboard off must not keep an old token alive.
 * ALP_DASHBOARD_APP names another directory of built app files (tests); ALP_WEB_APP, its name before
 * the rename, is read when it is not set.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, watch, writeSync } from 'node:fs';
import { chmod, link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { alpHome, assertPrivateDirectory, connectSocket, daemonPaths } from '@anhlp/alp-client/index';
import { createIntegrationLock } from '@anhlp/alp-client/integration-lock';
import { superviseDaemon } from '@anhlp/alp-client/supervise';
import { validateUserSettings } from '@anhlp/alp-core/validation';
import { dashboardSettings } from '@anhlp/alp-core/user-settings';
import { CredentialStore, createGateway, createGatewayLogger, renameWithRetry, resolveConfig } from '@anhlp/alp-gateway';
import { TERMINAL_EXEC_WARNING } from '@anhlp/alp-gateway/policy';
import { createGrant, grantPermissions, dashboardGatewayHome } from './grant.ts';
import { serveToken } from './token-socket.ts';
import { createStaticServer } from './serve.ts';
import { ownerMethods } from './owner/index.ts';
import { daemonEntry as bundledDaemonEntry } from '@anhlp/alp-core/packaged';
import type { Logger } from '@anhlp/alp-core/log';

// __ALP_VERSION__ is replaced at build time (esbuild define); a run from source reports a placeholder.
declare const __ALP_VERSION__: string;
const VERSION = typeof __ALP_VERSION__ === 'string' ? __ALP_VERSION__ : '0.0.0-source';

export const DEFAULT_WEB_PORT = 7433;
/** Ports tried from the port asked for: it and the next nine. */
const PORT_TRIES = 10;
/** How often the workspace grant follows alpd's registry. */
/**
 * An ALP_DASHBOARD_* variable, else the ALP_WEB_* one it was called before the rename (t-81b0.5): an
 * old export keeps working, and the new name wins when both are set.
 * @param name the part after ALP_DASHBOARD_ / ALP_WEB_
 */
const env = (name: string): string | undefined => process.env[`ALP_DASHBOARD_${name}`] || process.env[`ALP_WEB_${name}`] || undefined;
const REFRESH_MS = Number(env('GRANT_REFRESH_MS')) > 0 ? Number(env('GRANT_REFRESH_MS')) : 5_000;
/** 3: no `token` (t-cee3); 2 carried it. */
const WEB_FILE_VERSION = 3;

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = () => path.resolve(env('APP') || path.join(here, 'alp-dashboard'));
// The bundle's native alpd when it ships one (t-81b0.9), else alpd.js beside this script.
const daemonEntry = () => process.env.ALP_DAEMON_ENTRY ?? bundledDaemonEntry(path.join(here, 'alpd.js'));
const webFile = (home: string): string => path.join(home, 'dashboard.json');
/** Where the Paseo integration kept its identity before its own rename (and alp web, before t-81b0.5, its address). */
const legacyWebFile = (home: string): string => path.join(home, 'web.json');

/** The service's output goes to its own log: startIntegration starts it detached with stdio ignored. */
function serviceLog(home: string): void {
  const file = path.join(home, 'logs', 'integrations', 'alp-dashboard.log');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, 'a', 0o600);
  for (const stream of [process.stdout, process.stderr]) {
    // any: replaces the overloaded stream.write with a sink that takes any chunk the process writes
    stream.write = ((chunk: any) => { try { if (typeof chunk === 'string') writeSync(fd, chunk); else writeSync(fd, Buffer.from(chunk)); } catch {} return true; }) as any;
  }
}

async function userSettings(home: string, log: Logger): Promise<Record<string, any>> { // any: settings.json, validated, read loosely by dashboardSettings
  const file = path.join(home, 'settings.json');
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return {}; }
  try { return validateUserSettings(JSON.parse(text), file) as any; } // any: as above
  catch (error) { log.warn(`ignoring ${file}: ${(error as Error | undefined)?.message ?? error}`, { code: 'ALP_SETTINGS_INVALID' }); return {}; }
}

/**
 * Removes a `token` that dashboard.json still holds (written by a version before t-cee3, which kept the
 * token in the file); the rest of the file stays. The credential of that token is revoked by the
 * same start, so the copy would be dead anyway; this keeps it off the disk.
 */
async function dropPublishedToken(home: string): Promise<void> {
  let kept;
  try { kept = JSON.parse(await readFile(webFile(home), 'utf8')); } catch { return; }
  if (!kept || typeof kept !== 'object' || !('token' in kept)) return;
  const { token: _token, ...rest } = kept;
  await publish(home, rest);
}

/** Writes dashboard.json whole, private, in one rename. */
async function publish(home: string, info: object): Promise<void> {
  const file = webFile(home);
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(info)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await renameWithRetry(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/** Exit code of `--rotate` when the service holds the dashboard lock. */
const LOCK_HELD = 3;

/**
 * Writes `text` to `file` private (0600) and whole, through a fresh temporary file: linked into place
 * when `create` (an existing file is kept; returns false then), else renamed over it.
 */
async function writePrivate(file: string, text: string, { create = false }: { create?: boolean } = {}): Promise<boolean> {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    if (!create) { await renameWithRetry(temporary, file); return true; }
    try { await link(temporary, file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') return false; throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
}

/**
 * Before the rename, the Paseo integration ran as integration `web` and kept its identity (the token
 * paired devices sign in with, and its server id) in web.json, without `app`. When such a file is
 * still there, and only when the Paseo integration has no paseo.json yet, that identity is carried
 * where the integration looks for it, so paired devices stay paired: the server id to paseo.json and
 * the token to the integration's credential directory `<home>/paseo/token.json` (t-cde5; mode 0700
 * and 0600, never paseo.json, which agents may read). Files appear whole (written aside, then linked
 * into place) and an existing one is never replaced. The token then leaves web.json, carried or not
 * (with a paseo.json, the integration's own token wins and web.json's is dead). Returns whether it
 * carried anything.
 */
async function carryPaseoIdentity(home: string, log: Logger): Promise<boolean> {
  let legacy;
  try { legacy = JSON.parse(await readFile(legacyWebFile(home), 'utf8')); } catch { return false; }
  if (!legacy || typeof legacy !== 'object' || legacy.app !== undefined) return false;
  const token = typeof legacy.token === 'string' && /^[a-f0-9]{64}$/.test(legacy.token) ? legacy.token : undefined;
  const serverId = typeof legacy.serverId === 'string' && /^alp-[a-f0-9]{16}$/.test(legacy.serverId) ? legacy.serverId : undefined;
  const target = path.join(home, 'paseo.json');
  const credentials = path.join(home, 'paseo');
  let carried = false;
  try {
    const hasPaseoJson = await lstat(target).then(() => true, () => false);
    if (!hasPaseoJson && token) {
      await assertPrivateDirectory(credentials, { create: true });
      carried = await writePrivate(path.join(credentials, 'token.json'), `${JSON.stringify({ v: 1, token })}\n`, { create: true }) || carried;
    }
    if (!hasPaseoJson && serverId) carried = await writePrivate(target, `${JSON.stringify({ serverId })}\n`, { create: true }) || carried;
    if ('token' in legacy) {
      const { token: _token, ...rest } = legacy;
      await writePrivate(legacyWebFile(home), `${JSON.stringify(rest)}\n`);
    }
  } catch (error) {
    throw new Error(`the Paseo integration's identity in ${legacyWebFile(home)} could not be kept in ${credentials} and ${target}, so alp dashboard does not start: ${(error as Error | undefined)?.message ?? error}`, { cause: error });
  }
  if (carried) log.info(`kept the Paseo integration's identity from web.json (its password in ${credentials}), so paired devices stay paired`, { code: 'ALP_DASHBOARD_PASEO_IDENTITY' });
  return carried;
}

/**
 * `--rotate`: every credential revoked, under the dashboard lock; the next start mints a new one.
 */
async function rotate(home: string, dashboard: { permissions?: string[] }, log: Logger): Promise<void> {
  const lock = createIntegrationLock(home, 'dashboard');
  const { acquired, lock: held } = await lock.acquire();
  if (!acquired) {
    process.stderr.write(`alp dashboard runs (pid ${held.pid}); it must stop before its token is rotated\n`);
    process.exit(LOCK_HELD);
  }
  let code = 0;
  try {
    await carryPaseoIdentity(home, log);
    await dropPublishedToken(home);
    const permissions = grantPermissions(dashboard.permissions, message => log.warn(message, { code: 'ALP_DASHBOARD_PERMISSIONS_IGNORED' }));
    const store = new CredentialStore({ home: dashboardGatewayHome(home), logger: log });
    try {
      const grant = createGrant({ home, store, permissions, socket: () => undefined, log: message => log.info(message, { code: 'ALP_DASHBOARD_GRANT' }) });
      await grant.revokeAll();
      await grant.settled();
      log.info('rotated the token: every credential is revoked; the next start mints a new one', { code: 'ALP_DASHBOARD_ROTATED' });
    } finally { store.close(); }
  } catch (error) {
    log.error('alp dashboard could not rotate its token', { code: 'ALP_DASHBOARD_ROTATE_FAILED', error });
    code = 1;
  }
  // A failed release leaves the lock (fail closed); the next acquire reclaims it once this pid is gone.
  await lock.release().catch(error => { log.error('dashboard lock not released', { code: 'ALP_LOCK_RELEASE_FAILED', error }); code = 1; });
  process.exit(code);
}

/** The page's Content-Security-Policy on `port`: its own origin only, the socket included. */
const policy = (port: number): string => {
  const origins = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
    `connect-src 'self' ${origins.map(origin => `http://${origin} ws://${origin}`).join(' ')}`,
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
};

async function run(): Promise<void> {
  const { values } = parseArgs({ options: { service: { type: 'boolean' }, rotate: { type: 'boolean' }, project: { type: 'string' }, port: { type: 'string' } }, strict: true });
  // `alp dashboard --port N`: this start only; it does not change dashboard.port.
  const portOption = values.port === undefined ? undefined : Number(values.port);
  if (portOption !== undefined && !(Number.isInteger(portOption) && portOption >= 1024 && portOption <= 65535)) throw new Error(`--port must be a port from 1024 to 65535, not ${values.port}`);
  const home = alpHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (values.service) serviceLog(home);
  const log = createGatewayLogger();
  const dashboard = dashboardSettings(await userSettings(home, log));
  if (values.rotate) return rotate(home, dashboard, log);
  if (dashboard.enabled === false) {
    log.info('alp dashboard is disabled by settings ("dashboard.enabled": false)', { code: 'ALP_DASHBOARD_DISABLED' });
    process.exit(0);
  }
  const project = values.project ? path.resolve(values.project) : undefined;

  const lock = createIntegrationLock(home, 'dashboard');
  const { acquired, lock: held } = await lock.acquire();
  if (!acquired) {
    log.info(`alp dashboard already runs (pid ${held.pid})`, { code: 'ALP_LOCK_HELD' });
    process.exit(0);
  }
  // A failed release leaves the lock and its guard in place (fail closed); report it and stop anyway.
  const releaseLock = () => lock.release().catch(error => log.error('dashboard lock not released; alp dashboard stops anyway', { code: 'ALP_LOCK_RELEASE_FAILED', error }));

  const cleanups: Array<() => Promise<unknown>> = [];
  let shuttingDown = false;
  /** Startup, once it began; shutdown waits for it, so nothing it does lands after the lock is released. */
  let startup: Promise<unknown> = Promise.resolve();
  const shutdown = async (code: number = 0): Promise<void> => {
    // A later signal or uncaught exception starts no second shutdown; the first always reaches exit.
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // Startup stops at its next step once shuttingDown is set (each step is bounded).
      await startup.catch(() => {});
      for (const cleanup of cleanups.reverse()) await cleanup().catch(error => log.warn('a shutdown step failed', { code: 'ALP_DASHBOARD_SHUTDOWN_STEP', error }));
      await releaseLock();
    } finally { process.exit(code); }
  };
  for (const signal of (['SIGINT', 'SIGTERM'] as const)) process.on(signal, () => void shutdown());
  process.on('uncaughtException', error => { log.error('uncaught exception; alp dashboard stops', { code: 'ALP_FATAL', error }); void shutdown(1); });

  startup = (async () => {
    const stopDaemon = process.env.ALP_SUPERVISE === '0'
      ? async () => {}
      : superviseDaemon({ home, entry: daemonEntry, by: 'alp dashboard', log: (message: string) => log.warn(message, { code: 'ALP_DAEMON_SUPERVISION' }) });
    cleanups.push(() => stopDaemon());

    const permissions = grantPermissions(dashboard.permissions, message => log.warn(message, { code: 'ALP_DASHBOARD_PERMISSIONS_IGNORED' }));
    if (permissions.includes('terminal.exec')) log.warn(TERMINAL_EXEC_WARNING, { code: 'ALP_DASHBOARD_TERMINAL_EXEC' });
    const store = new CredentialStore({ home: dashboardGatewayHome(home), logger: log });
    cleanups.push(async () => store.close());
    const socket = daemonPaths(home).socket;
    const grant = createGrant({
      home, store, permissions, project,
      socket: () => socket,
      log: message => log.info(message, { code: 'ALP_DASHBOARD_GRANT' }),
    });
    // A credentials write under way finishes before the process exits (no half-done temporary file).
    cleanups.push(() => grant.settled());
    // Paired devices of the Paseo integration from before its rename stay paired.
    await carryPaseoIdentity(home, log);
    if (shuttingDown) return;
    // A token an earlier version left in dashboard.json leaves the disk; ensure revokes its credential.
    await dropPublishedToken(home);
    if (shuttingDown) return;
    // A fresh credential on every start (t-cee3); its token lives in this process only.
    const token = await grant.ensure();
    if (shuttingDown) return;
    // The registry, if alpd answers already, before the first page asks for it.
    await grant.refresh();
    if (shuttingDown) return;

    // The host owner's methods; a name defined twice stops the start here.
    const methods = ownerMethods({ home, socket });
    const owner = { credentialId: () => grant.id, methods };
    const dir = appDir();
    let bound = 0;
    const serveStatic = createStaticServer({ dir, csp: () => policy(bound), log: message => log.warn(message, { code: 'ALP_DASHBOARD_STATIC' }) });
    const base = portOption ?? dashboard.port ?? DEFAULT_WEB_PORT;
    for (let attempt = 0; ; attempt++) {
      if (shuttingDown) return;
      const port = base + attempt;
      const config = resolveConfig({
        host: '127.0.0.1',
        port,
        socketPath: socket,
        // The page's own origin, by every loopback name the gateway accepts as Host.
        origins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`],
        // One local user's browser: a stale token in an open tab must not lock that user out.
        // (DEFAULT_LIMITS is frozen, so its type has the literal defaults; any positive number is valid.)
        limits: ({ authFailures: 1_000 }) as any, // any: see the comment above
      });
      const candidate = createGateway({ config, store, logger: log, version: VERSION, openTransport: () => connectSocket(socket), serveStatic, owner });
      try {
        await candidate.listen();
        bound = port;
        cleanups.push(() => candidate.close());
        break;
      }
      catch (error) {
        await candidate.close().catch(() => {});
        // Windows answers EACCES for a port in an excluded range (Hyper-V, WinNAT) or held exclusively by
        // another socket: as unusable as a busy one, so the next port is tried for both.
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if ((code !== 'EADDRINUSE' && code !== 'EACCES') || attempt + 1 >= PORT_TRIES) throw error;
        log.info(`port ${port} is ${code === 'EACCES' ? 'not available' : 'in use'}; trying ${port + 1}`, { code: 'ALP_DASHBOARD_PORT_BUSY' });
      }
    }
    if (shuttingDown) return;
    // The token goes to `alp dashboard [--print]` over a 0600 socket in a 0700 directory, never to a
    // file; a socket that is not private stops the start.
    const tokenSocket = await serveToken({ home, token: () => token, credentialId: () => grant.id });
    cleanups.push(() => tokenSocket.close());
    if (shuttingDown) return;
    const url = `http://127.0.0.1:${bound}/`;
    await publish(home, { version: WEB_FILE_VERSION, app: 'alp-dashboard', pid: process.pid, port: bound, url, credentialId: grant.id });
    if (shuttingDown) return;
    const timer = setInterval(() => { if (!shuttingDown) void grant.refresh(); }, REFRESH_MS);
    timer.unref();
    cleanups.push(async () => clearInterval(timer));

    const stateDir = path.join(home, 'state');
    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      let debounce: NodeJS.Timeout | undefined;
      const watcher = watch(stateDir, (_eventType, filename) => {
        const name = typeof filename === 'string' ? filename : undefined;
        if (!name || name === 'web-workspaces.json' || name.startsWith('web-workspaces.json')) {
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            if (!shuttingDown) void grant.refresh();
          }, 20);
          debounce?.unref?.();
        }
      });
      watcher.unref();
      cleanups.push(async () => {
        clearTimeout(debounce);
        watcher.close();
      });
    } catch {}
    // A lock that is no longer ours means another process may own the credentials file: stop writing it.
    if (!(await lock.setReady(true))) throw new Error('the dashboard lock is no longer held by this process');
    log.info(`alp dashboard on ${url}`, { code: 'ALP_DASHBOARD_LISTENING' });
  })();
  // A failed start stops the service; shutdown waits for startup, which has settled by now.
  await startup.catch(error => {
    log.error('alp dashboard did not start', { code: 'ALP_DASHBOARD_START_FAILED', error });
    void shutdown(1);
  });
}

// Top-level bootstrap (including lock acquisition) precedes startup's cleanup handler.
// Catch it explicitly: Node's native unhandled-rejection output bypasses serviceLog's JS sink.
await run().catch(error => {
  createGatewayLogger().error('alp dashboard did not start', { code: 'ALP_DASHBOARD_START_FAILED', error });
  process.exitCode = 1;
});
