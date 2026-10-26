#!/usr/bin/env node
// @ts-check
/**
 * alp-web (docs/alp/web.md): the service behind `alp web`. ONE loopback listener at `web.port`
 * (default 7433, then the next nine ports) carries the ALP gateway and the built apps/web files.
 * It owns the `web` integration lock and `<home>/web.json`, which names its pid, port, URL and the
 * `alpgw1.*` token of its credential, so the CLI can open the app with the token in the address.
 * It keeps alpd running (ALP_SUPERVISE=0 opts out) and keeps the credential's workspaces in step
 * with alpd's project registry.
 *
 *   node alp-web.js [--service] [--project DIR]
 *   node alp-web.js --rotate [--project DIR]
 * `--service` (how startIntegration starts it) writes the log to <home>/logs/integrations/alp-web.log.
 * `--rotate` (how `alp web rotate` replaces the token) takes the web lock, which fails with exit 3
 * while the service runs, creates a new credential, revokes every other one, records the new token
 * in web.json for the next start, releases the lock and exits. It ignores web.enabled: turning alp
 * web off must not keep an old token alive.
 * ALP_WEB_APP names another directory of built app files (tests).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, writeSync } from 'node:fs';
import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { alpHome, connectSocket, daemonPaths } from '@anhlp/alp-client/index';
import { createIntegrationLock } from '@anhlp/alp-client/integration-lock';
import { superviseDaemon } from '@anhlp/alp-client/supervise';
import { validateUserSettings } from '@anhlp/alp-core/validation';
import { CredentialStore, createGateway, createGatewayLogger, parseToken, resolveConfig } from '@anhlp/alp-gateway';
import { TERMINAL_EXEC_WARNING } from '@anhlp/alp-gateway/policy';
import { createGrant, grantPermissions, webGatewayHome } from './grant.js';
import { createStaticServer } from './serve.js';

// __ALP_VERSION__ is replaced at build time (esbuild define); a run from source reports a placeholder.
// @ts-ignore -- a build-time constant, not a declared global
const VERSION = typeof __ALP_VERSION__ === 'string' ? __ALP_VERSION__ : '0.0.0-source';

export const DEFAULT_WEB_PORT = 7433;
/** Ports tried from web.port: it and the next nine. */
const PORT_TRIES = 10;
/** How often the workspace grant follows alpd's registry. */
const REFRESH_MS = Number(process.env.ALP_WEB_GRANT_REFRESH_MS) > 0 ? Number(process.env.ALP_WEB_GRANT_REFRESH_MS) : 5_000;
const WEB_FILE_VERSION = 2;

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = () => path.resolve(process.env.ALP_WEB_APP || path.join(here, 'alp-web'));
const daemonEntry = () => process.env.ALP_DAEMON_ENTRY ?? path.join(here, 'alpd.js');
const webFile = (/** @type {string} */ home) => path.join(home, 'web.json');

/** The service's output goes to its own log: startIntegration starts it detached with stdio ignored. @param {string} home */
function serviceLog(home) {
  const file = path.join(home, 'logs', 'integrations', 'alp-web.log');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, 'a', 0o600);
  for (const stream of [process.stdout, process.stderr]) {
    stream.write = /** @type {any} */ ((/** @type {any} */ chunk) => { try { if (typeof chunk === 'string') writeSync(fd, chunk); else writeSync(fd, Buffer.from(chunk)); } catch {} return true; });
  }
}

/** @param {string} home @param {import('@anhlp/alp-core/log').Logger} log */
async function userSettings(home, log) {
  const file = path.join(home, 'settings.json');
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return {}; }
  try { return /** @type {any} */ (validateUserSettings(JSON.parse(text), file)); }
  catch (error) { log.warn(`ignoring ${file}: ${/** @type {any} */ (error)?.message ?? error}`, { code: 'ALP_SETTINGS_INVALID' }); return {}; }
}

/** What the last run published, if it was alp-web's. @param {string} home */
async function previousWeb(home) {
  try {
    const kept = JSON.parse(await readFile(webFile(home), 'utf8'));
    if (kept?.app !== 'alp-web' || kept?.version !== WEB_FILE_VERSION || !parseToken(kept.token)) return {};
    return { token: kept.token, credentialId: kept.credentialId };
  } catch { return {}; }
}

/** Writes web.json whole, private, in one rename. @param {string} home @param {object} info */
async function publish(home, info) {
  const file = webFile(home);
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(info)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/** Exit code of `--rotate` when the service holds the web lock. */
const LOCK_HELD = 3;

/**
 * Before the rename, the Paseo integration ran as integration `web` and kept its identity (the token
 * paired devices sign in with, and its server id) in web.json, without `app`. Before alp-web first
 * overwrites such a file, and only when the Paseo integration has no paseo.json yet, that identity
 * is written to paseo.json, where the integration looks for it, so paired devices stay paired. The
 * file appears whole (written aside, then linked into place) and an existing paseo.json is never
 * replaced. Returns whether it carried anything.
 * @param {string} home @param {import('@anhlp/alp-core/log').Logger} log
 */
async function carryPaseoIdentity(home, log) {
  let legacy;
  try { legacy = JSON.parse(await readFile(webFile(home), 'utf8')); } catch { return false; }
  if (!legacy || typeof legacy !== 'object' || legacy.app !== undefined) return false;
  const identity = {
    ...(typeof legacy.token === 'string' && /^[a-f0-9]{64}$/.test(legacy.token) ? { token: legacy.token } : {}),
    ...(typeof legacy.serverId === 'string' && /^alp-[a-f0-9]{16}$/.test(legacy.serverId) ? { serverId: legacy.serverId } : {}),
  };
  if (!Object.keys(identity).length) return false;
  const target = path.join(home, 'paseo.json');
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(identity)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await link(temporary, target);
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'EEXIST') return false;
    throw new Error(`the Paseo integration's identity in ${webFile(home)} could not be kept in ${target}, so alp web leaves web.json alone: ${/** @type {any} */ (error)?.message ?? error}`, { cause: error });
  } finally { await unlink(temporary).catch(() => {}); }
  log.info(`kept the Paseo integration's identity from web.json in ${target}, so paired devices stay paired`, { code: 'ALP_WEB_PASEO_IDENTITY' });
  return true;
}

/**
 * `--rotate`: a new credential and token, recorded in web.json, under the web lock.
 * @param {string} home @param {string | undefined} project @param {any} settings @param {import('@anhlp/alp-core/log').Logger} log
 */
async function rotate(home, project, settings, log) {
  const lock = createIntegrationLock(home, 'web');
  const { acquired, lock: held } = await lock.acquire();
  if (!acquired) {
    process.stderr.write(`alp web runs (pid ${held.pid}); it must stop before its token is rotated\n`);
    process.exit(LOCK_HELD);
  }
  let code = 0;
  try {
    await carryPaseoIdentity(home, log);
    const permissions = grantPermissions(settings?.web?.permissions, message => log.warn(message, { code: 'ALP_WEB_PERMISSIONS_IGNORED' }));
    const store = new CredentialStore({ home: webGatewayHome(home), logger: log });
    try {
      const socket = daemonPaths(home).socket;
      const grant = createGrant({ home, store, permissions, project, socket: () => socket, log: message => log.info(message, { code: 'ALP_WEB_GRANT' }) });
      // No previous token to keep: a new credential, and every other one revoked.
      const token = await grant.ensure({});
      await grant.settled();
      await publish(home, { version: WEB_FILE_VERSION, app: 'alp-web', token, credentialId: grant.id });
      log.info(`rotated the token: credential ${grant.id}`, { code: 'ALP_WEB_ROTATED' });
    } finally { store.close(); }
  } catch (error) {
    log.error('alp web could not rotate its token', { code: 'ALP_WEB_ROTATE_FAILED', error });
    code = 1;
  }
  // A failed release leaves the lock (fail closed); the next acquire reclaims it once this pid is gone.
  await lock.release().catch(error => { log.error('web lock not released', { code: 'ALP_LOCK_RELEASE_FAILED', error }); code = 1; });
  process.exit(code);
}

/** The page's Content-Security-Policy on `port`: its own origin only, the socket included. @param {number} port */
const policy = port => {
  const origins = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
    `connect-src 'self' ${origins.map(origin => `http://${origin} ws://${origin}`).join(' ')}`,
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
};

async function run() {
  const { values } = parseArgs({ options: { service: { type: 'boolean' }, rotate: { type: 'boolean' }, project: { type: 'string' } }, strict: true });
  const home = alpHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (values.service) serviceLog(home);
  const log = createGatewayLogger();
  const settings = await userSettings(home, log);
  if (values.rotate) return rotate(home, values.project ? path.resolve(values.project) : undefined, settings, log);
  if (settings?.web?.enabled === false) {
    log.info('alp web is disabled by settings ("web.enabled": false)', { code: 'ALP_WEB_DISABLED' });
    process.exit(0);
  }
  const project = values.project ? path.resolve(values.project) : undefined;

  const lock = createIntegrationLock(home, 'web');
  const { acquired, lock: held } = await lock.acquire();
  if (!acquired) {
    log.info(`alp web already runs (pid ${held.pid})`, { code: 'ALP_LOCK_HELD' });
    process.exit(0);
  }
  // A failed release leaves the lock and its guard in place (fail closed); report it and stop anyway.
  const releaseLock = () => lock.release().catch(error => log.error('web lock not released; alp web stops anyway', { code: 'ALP_LOCK_RELEASE_FAILED', error }));

  /** @type {Array<() => Promise<unknown>>} */
  const cleanups = [];
  let shuttingDown = false;
  /** Startup, once it began; shutdown waits for it, so nothing it does lands after the lock is released. @type {Promise<unknown>} */
  let startup = Promise.resolve();
  /** @param {number} [code] */
  const shutdown = async (code = 0) => {
    // A later signal or uncaught exception starts no second shutdown; the first always reaches exit.
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // Startup stops at its next step once shuttingDown is set (each step is bounded).
      await startup.catch(() => {});
      for (const cleanup of cleanups.reverse()) await cleanup().catch(error => log.warn('a shutdown step failed', { code: 'ALP_WEB_SHUTDOWN_STEP', error }));
      await releaseLock();
    } finally { process.exit(code); }
  };
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.on(signal, () => void shutdown());
  process.on('uncaughtException', error => { log.error('uncaught exception; alp web stops', { code: 'ALP_FATAL', error }); void shutdown(1); });

  startup = (async () => {
    const stopDaemon = process.env.ALP_SUPERVISE === '0'
      ? async () => {}
      : superviseDaemon({ home, entry: daemonEntry, by: 'alp web', log: (/** @type {string} */ message) => log.warn(message, { code: 'ALP_DAEMON_SUPERVISION' }) });
    cleanups.push(() => stopDaemon());

    const permissions = grantPermissions(settings?.web?.permissions, message => log.warn(message, { code: 'ALP_WEB_PERMISSIONS_IGNORED' }));
    if (permissions.includes('terminal.exec')) log.warn(TERMINAL_EXEC_WARNING, { code: 'ALP_WEB_TERMINAL_EXEC' });
    const store = new CredentialStore({ home: webGatewayHome(home), logger: log });
    cleanups.push(async () => store.close());
    const socket = daemonPaths(home).socket;
    const grant = createGrant({
      home, store, permissions, project,
      socket: () => socket,
      log: message => log.info(message, { code: 'ALP_WEB_GRANT' }),
    });
    // A credentials write under way finishes before the process exits (no half-done temporary file).
    cleanups.push(() => grant.settled());
    // Before web.json is first overwritten (publish, below).
    await carryPaseoIdentity(home, log);
    if (shuttingDown) return;
    const token = await grant.ensure(await previousWeb(home));
    if (shuttingDown) return;
    // The registry, if alpd answers already, before the first page asks for it.
    await grant.refresh();
    if (shuttingDown) return;

    const dir = appDir();
    let bound = 0;
    const serveStatic = createStaticServer({ dir, csp: () => policy(bound), log: message => log.warn(message, { code: 'ALP_WEB_STATIC' }) });
    const base = settings?.web?.port ?? DEFAULT_WEB_PORT;
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
        limits: /** @type {any} */ ({ authFailures: 1_000 }),
      });
      const candidate = createGateway({ config, store, logger: log, version: VERSION, openTransport: () => connectSocket(socket), serveStatic });
      try {
        await candidate.listen();
        bound = port;
        cleanups.push(() => candidate.close());
        break;
      }
      catch (error) {
        await candidate.close().catch(() => {});
        if (/** @type {any} */ (error)?.code !== 'EADDRINUSE' || attempt + 1 >= PORT_TRIES) throw error;
        log.info(`port ${port} is in use; trying ${port + 1}`, { code: 'ALP_WEB_PORT_BUSY' });
      }
    }
    if (shuttingDown) return;
    const url = `http://127.0.0.1:${bound}/`;
    await publish(home, { version: WEB_FILE_VERSION, app: 'alp-web', pid: process.pid, port: bound, url, token, credentialId: grant.id });
    if (shuttingDown) return;
    const timer = setInterval(() => { if (!shuttingDown) void grant.refresh(); }, REFRESH_MS);
    timer.unref();
    cleanups.push(async () => clearInterval(timer));
    // A lock that is no longer ours means another process may own the credentials file: stop writing it.
    if (!(await lock.setReady(true))) throw new Error('the web lock is no longer held by this process');
    log.info(`alp web on ${url}`, { code: 'ALP_WEB_LISTENING' });
  })();
  // A failed start stops the service; shutdown waits for startup, which has settled by now.
  await startup.catch(error => {
    log.error('alp web did not start', { code: 'ALP_WEB_START_FAILED', error });
    void shutdown(1);
  });
}

await run();
