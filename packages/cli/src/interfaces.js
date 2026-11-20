import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { alpHome, connect, daemonPaths, discoverIntegration, startIntegration } from '@anhlp/alp-client/index';
import { UsageError } from './usage.js';
import { built, start, running } from './daemon.js';
import { DAEMON_ENTRY, distributionEntry } from './paths.js';
import { entryCommand } from '@anhlp/alp-core/packaged';
import { isAgentProcess } from '@anhlp/alp-core/tasks';
import { runRole } from './roles.js';
import { DASHBOARD, LEGACY_WEB, dashboardEntry, dashboardScript, isDashboardReady, isServiceClaimed, refusal, serviceOwner, stopService } from './dashboard-service.js';
import { legacyLeftovers, migrateDashboard } from './dashboard-migrate.js';
import { dashboardSettings } from '@anhlp/alp-core/user-settings';

/** The Paseo integration (its web app, bridge and relay) runs as integration `paseo`. */
const PASEO = 'paseo';

/**
 * Starts the Paseo integration. For one release, a home that still has only the descriptor
 * registered before the rename (`integrations/web.json`) keeps working, with a hint to re-register.
 * Exported for tests.
 * @param {string} home
 */
export async function startPaseoIntegration(home) {
  const entry = await discoverIntegration(PASEO, { home });
  if (!entry) {
    const legacy = path.join(home, 'integrations', 'web.json');
    const legacyEntry = await legacyDescriptorEntry(legacy, home);
    if (legacyEntry) {
      console.error(`Using the Paseo integration registered before its rename (${legacy}); run \`alp-paseo-integration --register\` to register it again.`);
      return startIntegration({ name: PASEO, entry: legacyEntry, home });
    }
  }
  return startIntegration({ name: PASEO, home });
}

/**
 * The entry named by the pre-rename descriptor `<home>/integrations/web.json`, and nothing else: no
 * environment, distribution or PATH lookup, since the name `web` belonged to alp web after that. A relative
 * `main` resolves against the descriptor's directory, then the home, as discovery does.
 * @param {string} file
 * @param {string} home
 */
async function legacyDescriptorEntry(file, home) {
  // A missing or corrupt descriptor is no registration: the caller then reports the missing package.
  const raw = await readFile(file, 'utf8').then(text => JSON.parse(text)).catch(() => undefined);
  const isFile = candidate => stat(candidate).then(info => info.isFile(), () => false);
  // The fields discovery accepts in a descriptor, in its priority order.
  for (const field of ['main', 'entry', 'path', 'command']) {
    const value = raw?.[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const candidates = path.isAbsolute(value) ? [value] : [path.resolve(path.dirname(file), value), path.resolve(home, value)];
    for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/** Whether the current working directory is an ALP project: its grant then covers it. */
async function currentProject() {
  const cwd = process.cwd();
  return await stat(path.join(cwd, '.alp')).then(info => info.isDirectory(), () => false) ? cwd : undefined;
}

/** `--project <cwd>` when the directory `alp dashboard` runs in is an ALP project: its grant then covers it. */
async function projectArgs() {
  const project = await currentProject();
  return project ? ['--project', project] : [];
}

/**
 * Registers `directory` as a project in alpd via IPC (`project.register`).
 * If alpd cannot be reached or the call fails, this is best-effort.
 * @param {string} home
 * @param {string} directory
 * @param {{ timeoutMs?: number, connectClient?: typeof connect }} [options]
 */
export async function registerProject(home, directory, { timeoutMs = 5_000, connectClient = connect } = {}) {
  const socket = daemonPaths(home).socket;
  let client;
  let expired = false;
  let timer;
  const work = (async () => {
    const connected = await connectClient(socket, { name: 'alp-cli', version: '1' }, { timeoutMs });
    if (expired) { connected.close(); return; }
    client = connected;
    for (let attempt = 0; attempt < 5 && !expired; attempt++) {
      const list = await client.request('project.list', { limit: 1 }, { timeoutMs }).catch(() => undefined);
      if (expired) return;
      const revision = typeof list?.revision === 'number' ? list.revision : 0;
      try {
        await client.request('project.register', { directory, ifRevision: revision, requestId: randomUUID() }, { timeoutMs });
        break;
      } catch (error) {
        if (error?.data?.reason === 'stale_revision' && attempt < 4) continue;
        break;
      }
    }
  })();
  try {
    // One deadline covers connection/hello and every retry; a late connection is closed above.
    await Promise.race([work.catch(() => {}), new Promise(resolve => {
      timer = setTimeout(() => {
        expired = true;
        try { client?.close(); } catch {}
        resolve(undefined);
      }, timeoutMs);
    })]);
  } finally {
    expired = true;
    clearTimeout(timer);
    try { client?.close(); } catch {}
  }
}

/**
 * Waits until the credential in `<home>/dashboard/credentials.json` contains `project`.
 * Polls for up to `timeoutMs` (default 5,000 ms).
 * @param {string} home
 * @param {string} credentialId
 * @param {string} project
 * @param {{ timeoutMs?: number }} [options]
 */
async function waitForGrant(home, credentialId, project, { timeoutMs = 5_000 } = {}) {
  const credentialsFile = path.join(home, 'dashboard', 'credentials.json');
  const canonical = await realpath(project).catch(() => project);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(await readFile(credentialsFile, 'utf8'));
      const credential = raw?.credentials?.find(c => c.id === credentialId && !c.revokedAt);
      if (credential?.workspaces?.some(w => w.canonical === canonical || w.path === project || w.path === canonical)) {
        return true;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

/** Whether settings.json turns alp dashboard off (`dashboard.enabled`, else `web.enabled` from before the rename). @param {string} home */
async function dashboardDisabled(home) {
  const settings = await readFile(path.join(home, 'settings.json'), 'utf8').then(text => JSON.parse(text), () => undefined);
  return dashboardSettings(settings).enabled === false;
}

const DISABLED = 'alp dashboard is disabled by settings ("dashboard.enabled": false).';

/** @param {string} home */
const readPublished = home => readFile(path.join(home, DASHBOARD.info), 'utf8').then(text => JSON.parse(text), () => undefined);
/** @param {string} home */
const readServiceLock = home => readFile(path.join(home, 'integrations', `${DASHBOARD.lock}.lock`), 'utf8').then(text => JSON.parse(text), () => undefined);

/**
 * The running service as its files and its listener show it, without ps (so also on Windows): the
 * lock names a live pid, dashboard.json names the same pid and is alp-dashboard's, and its address
 * answers. `held` is a live lock owner that is not (yet) that.
 * @param {string} home
 * @returns {Promise<{ pid: number, port: number, url: string } | { held: number } | undefined>}
 */
async function runningDashboard(home) {
  const lock = await readServiceLock(home);
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0) return undefined;
  try { process.kill(lock.pid, 0); } catch (error) { if (/** @type {any} */ (error)?.code !== 'EPERM') return undefined; }
  const info = await readPublished(home);
  if (info?.app === DASHBOARD.app && info.pid === lock.pid && typeof info.url === 'string' && await isDashboardReady(info.url)) return { pid: info.pid, port: info.port, url: info.url };
  return { held: lock.pid };
}

/** Loopback names `--host` accepts; the service listens on 127.0.0.1 only, which serves both. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

/**
 * Starts alp-dashboard unless it runs and returns the address to open, the token in its fragment
 * (which the browser never sends to a server).
 * @param {string} home @param {string} entry @param {{ port?: number }} [options]
 */
async function serveDashboard(home, entry, { port } = {}) {
  // A lock held by a process proven not to be alp dashboard: say so now rather than wait for it. A
  // running alp-dashboard (its dashboard.json names the lock's pid and is answering) is left to startIntegration.
  const held = await serviceOwner(home);
  const published = await readPublished(home);
  const lockPid = (await readServiceLock(home))?.pid;
  const claimed = await isServiceClaimed(published, lockPid, held);
  if ('reason' in held && held.alive && held.kind === 'foreign' && !claimed) throw new Error(`${refusal(home)} (${held.reason}). Stop it, then run alp dashboard again.`);
  // `--port` asks for a port; a service already running elsewhere is not silently reused.
  if (port !== undefined && claimed && published.port !== port) {
    throw new Error(`alp dashboard already runs on port ${published.port} (pid ${published.pid}); you asked for port ${port}. Stop it with \`alp dashboard --stop\`, or drop --port to use the running one.`);
  }
  const project = await currentProject();
  let lock;
  try { lock = await startIntegration({ name: DASHBOARD.lock, entry, home, args: [...(project ? ['--project', project] : []), ...(port !== undefined ? ['--port', String(port)] : [])] }); }
  catch (error) {
    // Still held by a live process alp cannot prove: name it, as the wait may have been for it.
    const owner = await serviceOwner(home);
    if ('reason' in owner && owner.alive) throw new Error(`${error?.message ?? error}\n${refusal(home)} (${owner.reason}). If it is not alp dashboard, stop it, then run alp dashboard again.`, { cause: error });
    throw error;
  }
  const info = await readPublished(home);
  if (info?.app !== DASHBOARD.app || info.pid !== lock.pid) {
    const owner = await serviceOwner(home);
    throw new Error(`${refusal(home)}${'reason' in owner ? ` (${owner.reason})` : ''}. Stop pid ${lock.pid}, then run alp dashboard again.`);
  }
  if (typeof info.url !== 'string' || typeof info.token !== 'string' || !(await isDashboardReady(info.url))) {
    throw new Error(`alp dashboard published no address; see ${path.join(home, 'logs', 'integrations', 'alp-dashboard.log')}`);
  }
  if (port !== undefined && info.port !== port) {
    throw new Error(`alp dashboard listens on port ${info.port}, not ${port} (port ${port} was busy or alp dashboard was starting already); stop it with \`alp dashboard --stop\` and free port ${port}, or drop --port`);
  }
  if (project) {
    await registerProject(home, project);
    await waitForGrant(home, info.credentialId, project);
  }
  return `${info.url}#token=${info.token}`;
}

/** Reports what the migration from `alp web` did, on stderr (stdout carries only the address). @param {Awaited<ReturnType<typeof migrateDashboard>>} report */
function reportMigration(report) {
  if (report.stopped) console.error(`Stopped ${LEGACY_WEB.what} (pid ${report.stopped}).`);
  if (report.moved.length) console.error(`Moved alp web's files to alp dashboard's names: ${report.moved.join('; ')}`);
  for (const warning of report.warnings) console.error(warning);
}

/**
 * alp dashboard --status, after Hermes' `hermes dashboard --status` (hermes_cli/main_dashboard.py
 * _report_dashboard_status): what runs, or that nothing does; always exit 0, and nothing is changed
 * (the move from `alp web` waits for a command that starts or stops). The address is printed
 * without its token.
 * @param {string} home
 */
async function statusCommand(home) {
  try {
    const running = await runningDashboard(home);
    if (running && 'url' in running) {
      console.log('1 alp dashboard process running:');
      console.log(`    PID ${running.pid} [dashboard]: ${running.url} (port ${running.port})`);
    } else if (running) {
      const owner = await serviceOwner(home);
      console.log(`No alp dashboard running. pid ${running.held} holds ${path.join(home, 'integrations', `${DASHBOARD.lock}.lock`)}${'reason' in owner ? ` (${owner.reason})` : ''}.`);
    } else console.log('No alp dashboard running.');
    if (await dashboardDisabled(home)) console.log(DISABLED);
    const left = await legacyLeftovers(home);
    if (left.legacy?.pid) console.log(`${LEGACY_WEB.what} still runs (pid ${left.legacy.pid}); \`alp dashboard\` or \`alp dashboard --stop\` stops it.`);
    else if (left.legacy) console.log(`${refusal(home, LEGACY_WEB)} (${left.legacy.reason}).`);
    for (const item of left.pending) console.log(`From before the rename to alp dashboard, moved by the next \`alp dashboard\`: ${item}`);
    for (const item of left.kept) console.log(`Left from before the rename to alp dashboard, not used: ${item}`);
  } catch (error) {
    console.log(`alp dashboard could not tell everything: ${error?.message ?? error}`);
  }
}

/**
 * alp dashboard --stop, after Hermes' `hermes dashboard --stop` (hermes_cli/main.py
 * _dashboard_lifecycle_flags): only this ALP home's service (and alp web from before the rename,
 * which the move stops); nothing running is not an error; a process alp cannot prove is the service
 * is left running and the command fails.
 * @param {string} home
 */
async function stopCommand(home) {
  const report = await migrateDashboard(home);
  reportMigration(report);
  // alp web from before the rename still holds its lock: not stopped, so not a success.
  if (report.held) process.exitCode = 1;
  const owner = await serviceOwner(home);
  if (!owner.alive && !('pid' in owner)) {
    if (!report.stopped) console.log('No alp dashboard running for this ALP home.');
    return;
  }
  const pid = await stopService(home);
  if (pid) console.log(`Stopped alp dashboard (pid ${pid}).`);
  else console.log('No alp dashboard running for this ALP home.');
}

async function dashboardCommand(args) {
  // alp dashboard prints, rotates and pairs with the user's own secrets (t-1c59), and stops the
  // user's service: a process an ALP agent started is refused before anything is read, stopped or printed.
  if (isAgentProcess()) throw new Error('alp dashboard is the user\'s: it prints and rotates the user\'s credential; this process was started by an ALP agent (ALP_AGENT_SESSION is set)');
  if (args[0] === 'pair') return pairCommand(args.slice(1));
  if (args[0] === 'rotate') return rotateCommand(args.slice(1));
  // alp-dashboard itself in this process; its own options (--service, --rotate, --project DIR, --port N) follow.
  if (args[0] === 'serve') return runRole('dashboard', dashboardScript(), args.slice(1));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    print: { type: 'boolean' }, 'no-open': { type: 'boolean' }, status: { type: 'boolean' }, stop: { type: 'boolean' },
    port: { type: 'string' }, host: { type: 'string' },
  } });
  if (positionals.length) throw new UsageError();
  const home = alpHome();
  // As in Hermes, the lifecycle flags win over the start flags: they report or stop, and exit.
  if (values.status && values.stop) throw new UsageError();
  if (values.status) return statusCommand(home);
  if (values.stop) return stopCommand(home);
  let port;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port < 1024 || port > 65535) throw new Error(`--port must be a port from 1024 to 65535, not ${values.port}`);
  }
  // ALP's token is the dashboard's only lock and its gateway accepts only loopback Host and Origin
  // names, so it is never bound beyond this machine (Hermes too refuses a non-loopback bind without
  // an auth provider, which ALP does not have).
  if (values.host !== undefined && !LOOPBACK_HOSTS.includes(values.host)) {
    throw new Error(`alp dashboard listens on this machine only (127.0.0.1): --host ${values.host} is refused. Reach it from another machine through an SSH tunnel to 127.0.0.1.`);
  }
  const entry = dashboardEntry();
  reportMigration(await migrateDashboard(home, { strict: true }));
  if (await dashboardDisabled(home)) throw new Error(DISABLED);
  await start();
  let url = await serveDashboard(home, entry, { port });
  if (values.host === 'localhost') url = url.replace('://127.0.0.1:', '://localhost:');
  console.log(url);
  if (values.print || values['no-open']) return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => console.error('Open the address above in your browser')).unref();
}

/**
 * alp dashboard rotate: alp dashboard's token is replaced and the old one revoked, so every open
 * page loses access. Only the process holding the dashboard lock writes its credentials, so the
 * service is stopped first; `alp-dashboard.js --rotate` then takes the lock, replaces the credential,
 * records the new token in dashboard.json and releases the lock, and the service starts again with it.
 */
async function rotateCommand(args) {
  if (args.length) throw new UsageError();
  const entry = dashboardEntry();
  const home = alpHome();
  reportMigration(await migrateDashboard(home, { strict: true }));
  await start();
  const project = await projectArgs();
  for (let attempt = 1; ; attempt++) {
    await stopService(home);
    const rotated = await new Promise(resolve => {
      const rotate = entryCommand(entry, 'dashboard', ['--rotate', ...project]);
      execFile(rotate.command, rotate.args, { env: { ...process.env, ALP_HOME: home }, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGTERM' },
        (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stderr}${stdout}`.trim() }));
    });
    if (rotated.code === 0) break;
    // Exit 3: alp dashboard started again between the stop and the rotation; stop it once more.
    if (rotated.code !== 3 || attempt >= 3) throw new Error(`alp dashboard could not rotate its token${rotated.output ? `:\n${rotated.output.slice(-2000)}` : ''}`);
  }
  if (await dashboardDisabled(home)) {
    console.log(`alp dashboard has a new token; the old one no longer works. ${DISABLED.replace(/\.$/, '')}, so it was not started.`);
    return;
  }
  console.log(await serveDashboard(home, entry));
}

/**
 * alp dashboard pair: the link that pairs Paseo's app on another device with alpd through Paseo's relay
 * (ALPD §64). The device then signs in with the password this command prints (the token kept in
 * ~/.alp/paseo.json).
 */

/**
 * `web.pairing` is an extension the integration registers on its alpd connection. Right after an
 * alpd restart the old registration is gone and the new one may still be in flight, so an
 * unknown-method reply means "not yet", not "never": wait for the fresh registration.
 *
 * Exported so the wait can be pinned by a regression test without a live daemon restart.
 */
export async function requestPairing(client, params, attempts = 50) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const outcome = await client.request('web.pairing', params).then(value => ({ value }), error => ({ error }));
    if (!outcome.error) return outcome.value;
    last = outcome.error;
    const unknown = outcome.error?.code === -32601 || /unknown method|not available|not registered/i.test(outcome.error?.message ?? '');
    if (!unknown) throw outcome.error;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw last ?? new Error('alpd did not register web.pairing; run `alp dashboard pair` again to let the integration start');
}

async function pairCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { on: { type: 'boolean' }, off: { type: 'boolean' } } });
  if (positionals.length || (values.on && values.off)) throw new UsageError();
  await start();
  const home = alpHome();
  await startPaseoIntegration(home);
  const client = await running();
  try {
    const pairing = await requestPairing(client, values.on ? { enable: true } : values.off ? { enable: false } : {});
    if (!pairing.relayEnabled) {
      console.log(`The relay is off${values.off ? ' now' : ''}. Turn it on with: alp dashboard pair --on`);
      return;
    }
    console.log(`Relay ${pairing.endpoint}: ${pairing.connected ? 'connected' : 'connecting'}`);
    console.log(`Open this link on the device that runs Paseo's app:\n${pairing.url}`);
    const password = await readFile(path.join(home, `${PASEO}.json`), 'utf8').then(text => JSON.parse(text)?.token).catch(() => undefined);
    if (typeof password === 'string' && password) console.log(`When Paseo's app asks for a password, give it: ${password}`);
    else console.log(`When Paseo's app asks for a password, give it the token in ${path.join(home, `${PASEO}.json`)}.`);
  } finally {
    client.close();
  }
}

/** alp acp: ALP as an ACP agent for editors; stdout carries only the protocol (ALPD §60). */

async function acpCommand(args) {
  if (args.length) throw new UsageError();
  await built();
  const { runAcp } = /** @type {{ runAcp: (options: { daemonEntry: string }) => Promise<void> }} */ (await import(distributionEntry('acp.js').href));
  await runAcp({ daemonEntry: DAEMON_ENTRY });
}

export { dashboardCommand, pairCommand, acpCommand };
