import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { alpHome, assertPrivateDirectory, connect, daemonPaths, discoverIntegration, startIntegration } from '@anhlp/alp-client/index';
import type { AlpClient } from '@anhlp/alp-client/index';
import type { DashboardMigration } from './dashboard-migrate.js';
import { UsageError } from './commands/usage.js';
import { built, start, running } from './daemon.js';
import { DAEMON_ENTRY, distributionEntry } from './paths.js';
import { entryCommand } from '@anhlp/alp-core/packaged';
import { isAgentProcess } from '@anhlp/alp-core/tasks';
import { runRole } from './commands/roles.js';
import { DASHBOARD, LEGACY_WEB, dashboardEntry, dashboardScript, isDashboardReady, isServiceClaimed, readToken, refusal, serviceOwner, stopService } from './dashboard-service.js';
import { legacyLeftovers, migrateDashboard } from './dashboard-migrate.js';
import { dashboardSettings } from '@anhlp/alp-core/user-settings';
import { scrubText } from '@anhlp/alp-core/log';

/** The Paseo integration (its web app, bridge and relay) runs as integration `paseo`. */
const PASEO = 'paseo';

/**
 * Starts the Paseo integration. For one release, a home that still has only the descriptor
 * registered before the rename (`integrations/web.json`) keeps working, with a hint to re-register.
 * Exported for tests.
 */
export async function startPaseoIntegration(home: string) {
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
 */
async function legacyDescriptorEntry(file: string, home: string): Promise<string | undefined> {
  // A missing or corrupt descriptor is no registration: the caller then reports the missing package.
  const raw = await readFile(file, 'utf8').then(text => JSON.parse(text)).catch(() => undefined);
  const isFile = (candidate: string) => stat(candidate).then(info => info.isFile(), () => false);
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
 */
export async function registerProject(home: string, directory: string, { timeoutMs = 5_000, connectClient = connect }: { timeoutMs?: number; connectClient?: typeof connect } = {}): Promise<void> {
  const socket = daemonPaths(home).socket;
  let client: AlpClient | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
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
        if ((error as { data?: { reason?: string } } | undefined)?.data?.reason === 'stale_revision' && attempt < 4) continue;
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
 */
async function waitForGrant(home: string, credentialId: string | undefined, project: string, { timeoutMs = 5_000 }: { timeoutMs?: number } = {}) {
  const credentialsFile = path.join(home, 'dashboard', 'credentials.json');
  const canonical = await realpath(project).catch(() => project);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(await readFile(credentialsFile, 'utf8'));
      const credential = raw?.credentials?.find((c: { id: string; revokedAt?: string }) => c.id === credentialId && !c.revokedAt);
      if (credential?.workspaces?.some((w: { canonical?: string; path?: string }) => w.canonical === canonical || w.path === project || w.path === canonical)) {
        return true;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

/** Whether settings.json turns alp dashboard off (`dashboard.enabled`, else `web.enabled` from before the rename). */
async function dashboardDisabled(home: string) {
  const settings = await readJsonFile(path.join(home, 'settings.json'));
  return dashboardSettings(settings).enabled === false;
}

const DISABLED = 'alp dashboard is disabled by settings ("dashboard.enabled": false).';

/**
 * The contract of `alp dashboard --print --json` (docs/alp/dashboard.md §3.3). Each failure class
 * has a name (`error.code` in the JSON) and its own exit code; both are stable. `failed` (1) is
 * everything not classified, and what an alp from before the contract exits with.
 */
const PRINT_SCHEMA = 'alp.dashboard.print';
const PRINT_VERSION = 1;
const PRINT_EXIT = { failed: 1, usage: 2, disabled: 3, agent: 4, not_built: 5, conflict: 6, service: 7, daemon: 8 };

/**
 * An Error of failure class `kind` (a key of PRINT_EXIT). Without --json the class changes nothing:
 * the message is printed and alp exits 1 as before.
 */
const failure = (kind: keyof typeof PRINT_EXIT, message: string, options?: ErrorOptions) => Object.assign(new Error(message, options), { kind });

/**
 * Runs `work`; an error it throws without a class gets `kind`. The error itself is rethrown.
 */
async function classed<T>(kind: keyof typeof PRINT_EXIT, work: () => T | Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { throw classify(error, kind); }
}

/** `error`, given the class `kind` unless it has one. */
function classify(error: unknown, kind: keyof typeof PRINT_EXIT) {
  if (error instanceof Error && !('kind' in error)) Object.assign(error, { kind });
  return error;
}

/** A file's JSON, or undefined when it is missing or not JSON (as before: a broken file counts as none). */
const readJsonFile = (file: string) => readFile(file, 'utf8').then(text => { try { return JSON.parse(text); } catch { return undefined; } }, () => undefined);
const readPublished = (home: string) => readJsonFile(path.join(home, DASHBOARD.info));
const readServiceLock = (home: string) => readJsonFile(path.join(home, 'integrations', `${DASHBOARD.lock}.lock`));

/**
 * The running service as its files and its listener show it, without ps (so also on Windows): the
 * lock names a live pid, dashboard.json names the same pid and is alp-dashboard's, and its address
 * answers. `held` is a live lock owner that is not (yet) that.
 */
async function runningDashboard(home: string): Promise<{ pid: number; port: number; url: string } | { held: number } | undefined> {
  const lock = await readServiceLock(home);
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0) return undefined;
  try { process.kill(lock.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EPERM') return undefined; }
  const info = await readPublished(home);
  if (info?.app === DASHBOARD.app && info.pid === lock.pid && typeof info.url === 'string' && await isDashboardReady(info.url)) return { pid: info.pid, port: info.port, url: info.url };
  return { held: lock.pid };
}

/** Loopback names `--host` accepts; the service listens on 127.0.0.1 only, which serves both. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

/**
 * Starts alp-dashboard unless it runs and returns the address to open, the token in its fragment
 * (which the browser never sends to a server). The token comes from the running service over its
 * private token socket (t-cee3); no file holds it.
 *
 * @returns `base` is dashboard.json's url (`http://127.0.0.1:<port>/`)
 */
async function serveDashboard(home: string, entry: string, { port }: { port?: number } = {}): Promise<{ base: string; token: string; pid: number; port: number }> {
  // A lock held by a process proven not to be alp dashboard: say so now rather than wait for it. A
  // running alp-dashboard (its dashboard.json names the lock's pid and is answering) is left to startIntegration.
  const held = await serviceOwner(home);
  const published = await readPublished(home);
  const lockPid = (await readServiceLock(home))?.pid;
  const claimed = await isServiceClaimed(published, lockPid, held);
  if ('reason' in held && held.alive && held.kind === 'foreign' && !claimed) throw failure('conflict', `${refusal(home)} (${held.reason}). Stop it, then run alp dashboard again.`);
  // `--port` asks for a port; a service already running elsewhere is not silently reused.
  if (port !== undefined && claimed && published.port !== port) {
    throw failure('conflict', `alp dashboard already runs on port ${published.port} (pid ${published.pid}); you asked for port ${port}. Stop it with \`alp dashboard --stop\`, or drop --port to use the running one.`);
  }
  const project = await currentProject();
  let lock: Awaited<ReturnType<typeof startIntegration>>;
  try { lock = await startIntegration({ name: DASHBOARD.lock, entry, home, args: [...(project ? ['--project', project] : []), ...(port !== undefined ? ['--port', String(port)] : [])] }); }
  catch (error) {
    // Still held by a live process alp cannot prove: name it, as the wait may have been for it.
    const owner = await serviceOwner(home);
    if ('reason' in owner && owner.alive) throw failure('conflict', `${(error as Error | undefined)?.message ?? error}\n${refusal(home)} (${owner.reason}). If it is not alp dashboard, stop it, then run alp dashboard again.`, { cause: error });
    // startIntegration reads settings.json itself: turned off between this command's check and the start.
    throw classify(error, await dashboardDisabled(home) ? 'disabled' : 'service');
  }
  const info = await readPublished(home);
  if (info?.app !== DASHBOARD.app || info.pid !== lock.pid) {
    const owner = await serviceOwner(home);
    throw failure('conflict', `${refusal(home)}${'reason' in owner ? ` (${owner.reason})` : ''}. Stop pid ${lock.pid}, then run alp dashboard again.`);
  }
  if (typeof info.url !== 'string' || !(await isDashboardReady(info.url))) {
    throw failure('service', `alp dashboard published no address; see ${path.join(home, 'logs', 'integrations', 'alp-dashboard.log')}`);
  }
  let answer: Awaited<ReturnType<typeof readToken>>;
  try { answer = await readToken(home); }
  catch (error) { throw failure('service', `alp dashboard did not hand over its token: ${(error as Error | undefined)?.message ?? error}; see ${path.join(home, 'logs', 'integrations', 'alp-dashboard.log')}. A service started by an older alp keeps no token socket: run \`alp dashboard --stop\`, then \`alp dashboard\` again`, { cause: error }); }
  // The socket's answer must come from the process the lock and dashboard.json name.
  if (answer.pid !== lock.pid) throw failure('conflict', `the token socket of alp dashboard is held by pid ${answer.pid}, not by the service (pid ${lock.pid}); stop it, then run alp dashboard again`);
  if (port !== undefined && info.port !== port) {
    throw failure('conflict', `alp dashboard is running on port ${info.port}, not ${port} (port ${port} was busy or alp dashboard was starting already); it was left running there. Stop it with \`alp dashboard --stop\` and free port ${port}, or drop --port`);
  }
  if (project) {
    await registerProject(home, project);
    await waitForGrant(home, answer.credentialId ?? info.credentialId, project);
  }
  return { base: info.url, token: answer.token, pid: lock.pid, port: info.port };
}

/** The address to open: the token rides in the fragment, which a browser never sends to a server. */
const addressOf = (served: { base: string; token: string }) => `${served.base}#token=${served.token}`;

/** Reports what the migration from `alp web` did, on stderr (stdout carries only the address). */
function reportMigration(report: DashboardMigration) {
  if (report.stopped) console.error(`Stopped ${LEGACY_WEB.what} (pid ${report.stopped}).`);
  if (report.moved.length) console.error(`Moved alp web's files to alp dashboard's names: ${report.moved.join('; ')}`);
  for (const warning of report.warnings) console.error(warning);
}

/**
 * alp dashboard --status, after Hermes' `hermes dashboard --status` (hermes_cli/main_dashboard.py
 * _report_dashboard_status): what runs, or that nothing does; always exit 0, and nothing is changed
 * (the move from `alp web` waits for a command that starts or stops). The address is printed
 * without its token.
 */
async function statusCommand(home: string) {
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
    console.log(`alp dashboard could not tell everything: ${(error as Error | undefined)?.message ?? error}`);
  }
}

/**
 * alp dashboard --stop, after Hermes' `hermes dashboard --stop` (hermes_cli/main.py
 * _dashboard_lifecycle_flags): only this ALP home's service (and alp web from before the rename,
 * which the move stops); nothing running is not an error; a process alp cannot prove is the service
 * is left running and the command fails.
 */
async function stopCommand(home: string) {
  const report = await migrateDashboard(home);
  reportMigration(report);
  // alp web from before the rename still holds its lock: not stopped, so not a success.
  if (report.held) process.exitCode = 1;
  const owner = await serviceOwner(home);
  if (!(owner as { alive?: boolean }).alive && !('pid' in owner)) {
    if (!report.stopped) console.log('No alp dashboard running for this ALP home.');
  } else {
    const pid = await stopService(home);
    if (pid) console.log(`Stopped alp dashboard (pid ${pid}).`);
    else console.log('No alp dashboard running for this ALP home.');
  }
  await dropLeftToken(home);
}

/**
 * A token an older alp dashboard (before t-cee3) wrote into dashboard.json stays readable there, and
 * its credential live, until the service starts again. --stop clears it too: the service's own
 * `--rotate` revokes every credential and strips the token, under the dashboard lock.
 */
async function dropLeftToken(home: string) {
  let published;
  try { published = JSON.parse(await readFile(path.join(home, DASHBOARD.info), 'utf8')); } catch { return; }
  if (!published || typeof published !== 'object' || !('token' in published)) return;
  const rotate = entryCommand(dashboardEntry(), 'dashboard', ['--rotate']);
  const code = await new Promise<number>(resolve => {
    execFile(rotate.command, rotate.args, { env: { ...process.env, ALP_HOME: home }, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGTERM' },
      error => resolve(error ? (typeof error.code === 'number' ? error.code : 1) : 0));
  });
  if (code === 0) console.log(`Removed the token an older alp dashboard left in ${DASHBOARD.info} and revoked it.`);
  else { console.log(`${DASHBOARD.info} still holds a token from an older alp dashboard; run \`alp dashboard rotate\` to revoke it.`); process.exitCode = 1; }
}

/** `alp dashboard` subcommands, which have their own arguments (and no --json). */
const DASHBOARD_SUBCOMMANDS = ['pair', 'rotate', 'serve'];

/**
 * alp dashboard. With --json (docs/alp/dashboard.md §3.3) stdout carries exactly one line, a JSON
 * object, on success and on every failure, and the exit code names the failure class. The token is
 * in that line only on success: it goes to the caller's stdout, as the address of --print does, and
 * nowhere else (no file, no argument, no log; --json never opens a browser).
 */
async function dashboardCommand(args: string[]) {
  if (!args.includes('--json') || DASHBOARD_SUBCOMMANDS.includes(args[0])) return runDashboard(args);
  try {
    await runDashboard(args);
  } catch (error) {
    // any (three lines): whatever was thrown, read for an optional code, failure class or message.
    const usage = error instanceof UsageError || (error as any)?.code?.startsWith?.('ERR_PARSE_ARGS');
    const kind = usage ? 'usage' : Object.hasOwn(PRINT_EXIT, (error as any)?.kind) ? (error as any).kind as keyof typeof PRINT_EXIT : 'failed';
    const message = scrubText(String(error instanceof UsageError ? 'usage: alp dashboard [--port N] [--host 127.0.0.1|localhost] [--no-open|--print] [--json]' : (error as any)?.message ?? error));
    console.log(JSON.stringify({ schema: PRINT_SCHEMA, version: PRINT_VERSION, ok: false, error: { code: kind, message } }));
    console.error(`alp: ${message}`);
    process.exitCode = PRINT_EXIT[kind];
  }
}

async function runDashboard(args: string[]) {
  // alp dashboard prints, rotates and pairs with the user's own secrets (t-1c59), and stops the
  // user's service: a process an ALP agent started is refused before anything is read, stopped or printed.
  if (isAgentProcess()) throw failure('agent', 'alp dashboard is the user\'s: it prints and rotates the user\'s credential; this process was started by an ALP agent (ALP_AGENT_SESSION is set)');
  if (args[0] === 'pair') return pairCommand(args.slice(1));
  if (args[0] === 'rotate') return rotateCommand(args.slice(1));
  // alp-dashboard itself in this process; its own options (--service, --rotate, --project DIR, --port N) follow.
  if (args[0] === 'serve') return runRole('dashboard', dashboardScript(), args.slice(1));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    print: { type: 'boolean' }, 'no-open': { type: 'boolean' }, status: { type: 'boolean' }, stop: { type: 'boolean' },
    port: { type: 'string' }, host: { type: 'string' }, json: { type: 'boolean' },
  } });
  if (positionals.length) throw new UsageError();
  const home = alpHome();
  // As in Hermes, the lifecycle flags win over the start flags: they report or stop, and exit.
  if (values.status && values.stop) throw new UsageError();
  // --json is the contract of the address only; --status and --stop print text.
  if (values.json && (values.status || values.stop)) throw new UsageError();
  if (values.status) return statusCommand(home);
  if (values.stop) return stopCommand(home);
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port < 1024 || port > 65535) throw failure('usage', `--port must be a port from 1024 to 65535, not ${values.port}`);
  }
  // ALP's token is the dashboard's only lock and its gateway accepts only loopback Host and Origin
  // names, so it is never bound beyond this machine (Hermes too refuses a non-loopback bind without
  // an auth provider, which ALP does not have).
  if (values.host !== undefined && !LOOPBACK_HOSTS.includes(values.host)) {
    throw failure('usage', `alp dashboard listens on this machine only (127.0.0.1): --host ${values.host} is refused. Reach it from another machine through an SSH tunnel to 127.0.0.1.`);
  }
  const entry = await classed('not_built', () => dashboardEntry());
  // Strict: alp web from before the rename that alp cannot prove and so does not stop is in the way.
  reportMigration(await classed('conflict', () => migrateDashboard(home, { strict: true })));
  if (await dashboardDisabled(home)) throw failure('disabled', DISABLED);
  await classed('daemon', () => start());
  const served = await serveDashboard(home, entry, { port });
  if (values.host === 'localhost') served.base = served.base.replace('://127.0.0.1:', '://localhost:');
  const url = addressOf(served);
  if (values.json) {
    console.log(JSON.stringify({ schema: PRINT_SCHEMA, version: PRINT_VERSION, ok: true, url, origin: new URL(served.base).origin, token: served.token, port: served.port, pid: served.pid }));
    return;
  }
  console.log(url);
  if (values.print || values['no-open']) return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => console.error('Open the address above in your browser')).unref();
}

/**
 * alp dashboard rotate: alp dashboard's token is replaced and the old one revoked, so every open
 * page loses access. Only the process holding the dashboard lock writes its credentials, so the
 * service is stopped first; `alp-dashboard.js --rotate` then takes the lock, revokes every credential
 * and releases the lock, and the service starts again with a new one (every start mints one, t-cee3).
 */
async function rotateCommand(args: string[]) {
  if (args.length) throw new UsageError();
  const entry = dashboardEntry();
  const home = alpHome();
  reportMigration(await migrateDashboard(home, { strict: true }));
  await start();
  const project = await projectArgs();
  for (let attempt = 1; ; attempt++) {
    await stopService(home);
    const rotated = await new Promise<{ code: number; output: string }>(resolve => {
      const rotate = entryCommand(entry, 'dashboard', ['--rotate', ...project]);
      execFile(rotate.command, rotate.args, { env: { ...process.env, ALP_HOME: home }, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGTERM' },
        (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stderr}${stdout}`.trim() }));
    });
    if (rotated.code === 0) break;
    // Exit 3: alp dashboard started again between the stop and the rotation; stop it once more.
    if (rotated.code !== 3 || attempt >= 3) throw new Error(`alp dashboard could not rotate its token${rotated.output ? `:\n${rotated.output.slice(-2000)}` : ''}`);
  }
  if (await dashboardDisabled(home)) {
    console.log(`alp dashboard's token is revoked; the old one no longer works and the next start mints a new token. ${DISABLED.replace(/\.$/, '')}, so it was not started.`);
    return;
  }
  console.log(addressOf(await serveDashboard(home, entry)));
}

/**
 * alp dashboard pair: the link that pairs Paseo's app on another device with alpd through Paseo's relay
 * (ALPD §64). The device then signs in with the password this command prints: the integration's token,
 * which it keeps in its credential directory `<home>/paseo/` (t-cde5) and hands over only on its
 * private token socket (integrations/paseo/server/web.ts). `--rotate` makes the integration replace
 * it: the old password is refused from then on and every paired device must sign in again.
 */

/** The request lines of the Paseo integration's token socket (integrations/paseo/server/web.ts). */
const PASEO_TOKEN_REQUEST = '{"op":"token"}';
const PASEO_ROTATE_REQUEST = '{"op":"rotate"}';

/**
 * Where the Paseo integration of `home` answers for its token. Must match tokenSocketPath in
 * integrations/paseo/server/web.ts (the CLI does not depend on that package).
 */
export function paseoTokenSocketPath(home: string, { platform = process.platform, uid = process.getuid?.() }: { platform?: NodeJS.Platform; uid?: number } = {}): string {
  const hash = createHash('sha256').update(home).digest('hex');
  if (platform === 'win32') return `\\\\.\\pipe\\alp-paseo-${hash.slice(0, 24)}`;
  const preferred = path.join(home, PASEO, 'token.sock');
  return Buffer.byteLength(preferred) < 100 ? preferred : `/tmp/alp-paseo-${uid ?? 'user'}-${hash.slice(0, 12)}/token.sock`;
}

/**
 * Asks the Paseo integration of `home` for its password over its token socket, or (`rotate`) for a
 * new one. Refuses a socket that is not the user's 0600 socket in a 0700 directory of the user's.
 */
export async function readPaseoToken(home: string, { rotate = false, timeoutMs = 10_000, socketPath = paseoTokenSocketPath(home) }: { rotate?: boolean; timeoutMs?: number; socketPath?: string } = {}): Promise<{ token: string; serverId: string | undefined; pid: number | undefined }> {
  if (process.platform !== 'win32') {
    const directory = path.dirname(socketPath);
    await assertPrivateDirectory(directory).catch(error => {
      throw new Error(`the Paseo integration's token socket must be in a directory owned by you with mode 0700: ${directory} is not (${error?.message ?? error})`, { cause: error });
    });
    const info = await lstat(socketPath);
    if (!info.isSocket()) throw new Error(`the Paseo integration's token socket ${socketPath} is not a socket`);
    if (info.uid !== process.getuid?.()) throw new Error(`the Paseo integration's token socket ${socketPath} is not yours (uid ${info.uid})`);
    if ((info.mode & 0o777) !== 0o600) throw new Error(`the Paseo integration's token socket ${socketPath} must have mode 0600, not ${(info.mode & 0o777).toString(8).padStart(4, '0')}`);
  }
  const text = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(socketPath);
    let received = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`the Paseo integration did not answer on ${socketPath} within ${timeoutMs} ms`)); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${rotate ? PASEO_ROTATE_REQUEST : PASEO_TOKEN_REQUEST}\n`));
    socket.on('data', chunk => { received += chunk; if (received.length > 4_096) socket.destroy(); });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', () => { clearTimeout(timer); resolve(received); });
  });
  let answer;
  try { answer = JSON.parse(text); } catch { answer = undefined; }
  if (typeof answer?.token !== 'string' || !/^[a-f0-9]{64}$/.test(answer.token)) throw new Error(`the Paseo integration gave no password on ${socketPath}`);
  return { token: answer.token, serverId: typeof answer.serverId === 'string' ? answer.serverId : undefined, pid: Number.isSafeInteger(answer.pid) ? answer.pid : undefined };
}

/**
 * `web.pairing` is an extension the integration registers on its alpd connection. Right after an
 * alpd restart the old registration is gone and the new one may still be in flight, so an
 * unknown-method reply means "not yet", not "never": wait for the fresh registration.
 *
 * Exported so the wait can be pinned by a regression test without a live daemon restart.
 */
export async function requestPairing(
  client: { request(method: string, params?: unknown): Promise<any> }, // any: the integration's web.pairing answer
  params: { enable?: boolean },
  attempts = 50,
  // any: web.pairing's answer as the integration sends it (relayEnabled, url, endpoint, connected).
): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // any: the answer (see above), or the error the request failed with.
    const outcome: { value?: any; error?: any } = await client.request('web.pairing', params).then(value => ({ value }), error => ({ error }));
    if (!outcome.error) return outcome.value;
    last = outcome.error;
    const unknown = outcome.error?.code === -32601 || /unknown method|not available|not registered/i.test(outcome.error?.message ?? '');
    if (!unknown) throw outcome.error;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw last ?? new Error('alpd did not register web.pairing; run `alp dashboard pair` again to let the integration start');
}

/** Why the password could not be had, and what to do. */
const noPassword = (home: string, error: unknown) => `the Paseo integration did not give its password (${(error as Error | undefined)?.message ?? error}). An integration started by a version of ALP from before t-cde5 has no token socket: stop it (the pid in ${path.join(home, `${PASEO}.json`)}), then run alp dashboard pair again.`;

async function pairCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { on: { type: 'boolean' }, off: { type: 'boolean' }, rotate: { type: 'boolean' } } });
  if (positionals.length || (values.on && values.off)) throw new UsageError();
  // The password is the user's: an agent gets neither it nor a new one (alpd refuses its web.pairing too, t-d08b).
  if (isAgentProcess()) throw new Error('alp dashboard pair is the user\'s: it prints and rotates the password of the user\'s Paseo pairing; this process was started by an ALP agent (ALP_AGENT_SESSION is set)');
  await start();
  const home = alpHome();
  await startPaseoIntegration(home);
  const client = await running();
  try {
    // web.pairing first: alpd marks an agent's call and the integration refuses it before any password is read.
    const pairing = await requestPairing(client, values.on ? { enable: true } : values.off ? { enable: false } : {});
    if (values.rotate) {
      const { token } = await readPaseoToken(home, { rotate: true }).catch(error => { throw new Error(noPassword(home, error), { cause: error }); });
      console.log('The Paseo password is rotated: the old one no longer works, and every paired device must sign in again.');
      if (pairing.relayEnabled) console.log(`Open this link on the device that runs Paseo's app:\n${pairing.url}`);
      console.log(`When Paseo's app asks for a password, give it: ${token}`);
      return;
    }
    if (!pairing.relayEnabled) {
      console.log(`The relay is off${values.off ? ' now' : ''}. Turn it on with: alp dashboard pair --on`);
      return;
    }
    console.log(`Relay ${pairing.endpoint}: ${pairing.connected ? 'connected' : 'connecting'}`);
    console.log(`Open this link on the device that runs Paseo's app:\n${pairing.url}`);
    const { token } = await readPaseoToken(home).catch(error => { throw new Error(noPassword(home, error), { cause: error }); });
    console.log(`When Paseo's app asks for a password, give it: ${token}`);
  } finally {
    client.close();
  }
}

/** alp acp: ALP as an ACP agent for editors; stdout carries only the protocol (ALPD §60). */

async function acpCommand(args: string[]) {
  if (args.length) throw new UsageError();
  await built();
  const { runAcp } = (await import(distributionEntry('acp.js').href)) as { runAcp: (options: { daemonEntry: string }) => Promise<void> };
  await runAcp({ daemonEntry: DAEMON_ENTRY });
}

export { dashboardCommand, pairCommand, acpCommand };
