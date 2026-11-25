import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import net from 'node:net';
import { assertPrivateDirectory, bootTime, isSameBoot, readLock } from '@anhlp/alp-client/index';
import { distributionEntry } from './paths.js';
import { selfEntry } from '@anhlp/alp-core/packaged';

/**
 * The CLI's side of alp-dashboard (packages/cli/src/dashboard), the service behind `alp dashboard`:
 * where it is, which process owns its lock, and how to stop that process safely. The same proofs
 * apply to what ran under the names from before the rename (t-81b0.5): `integrations/web.lock` and
 * `web.json`, held by alp web of 0.0.1-beta.8 or earlier, or by the Paseo integration from before
 * its own rename.
 *
 * Only a process proven to be the one that took the service's lock is ever signalled, and only
 * with SIGTERM (the CLI's own `--rotate` child aside, which it may time out): the lock and the
 * service's `<name>.json` name the same pid, both files are the user's, the lock is
 * from this boot, the pid answers signal 0 (so it is the user's own process), and that process
 * started no later than the lock was written (so the pid was not reused). Anything else is reported
 * and left alone. A stopped owner releases the lock; one that died holding it leaves it to the next
 * acquire, which reclaims it only on proof of death (the integration lock protocol, t-e148).
 */

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The alp-dashboard service script beside this CLI; a clear error when this CLI was built without it. */
export function dashboardScript() {
  const entry = fileURLToPath(distributionEntry('alp-dashboard.js'));
  if (!existsSync(entry)) throw new Error(`alp dashboard is not built: ${entry} is missing. Build the CLI (npm run build in the ALP checkout) or reinstall ALP.`);
  return entry;
}

/** What starts alp-dashboard: its script under Node (named through app/current in the ALP bundle). */
export const dashboardEntry = () => selfEntry(dashboardScript());

/**
 * The integration lock's name, the file the service publishes, the `app` it writes there, and what
 * messages call it.
 */
export type Service = { lock: string; info: string; app: string; what: string };
/** Who owns a service's lock: a process proven safe to stop, or why it is not (see serviceOwner). */
export type ServiceOwner = { pid: number; app: unknown } | { reason: string; alive: boolean; kind?: 'transient' | 'foreign' | 'unknown' };
export const DASHBOARD: Service = Object.freeze({ lock: 'dashboard', info: 'dashboard.json', app: 'alp-dashboard', what: 'alp dashboard' });
/** alp web as 0.0.1-beta.8 and earlier ran it (and, before that, the Paseo integration). */
export const LEGACY_WEB: Service = Object.freeze({ lock: 'web', info: 'web.json', app: 'alp-web', what: 'alp web from before its rename to alp dashboard' });

const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));

/** When `pid` started and elapsed seconds from ps, or undefined when ps cannot say. */
async function processTimes(pid: number) {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
    // [[dd-]hh:]mm:ss
    const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(stdout);
    if (!match) return undefined;
    const [, days = '0', hours = '0', minutes, seconds] = match;
    const elapsed = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
    return { started: Date.now() - elapsed * 1000, elapsed };
  } catch { return undefined; }
}

/**
 * The process that owns `service`'s lock, if it is proven safe to stop; else why not. `kind` says
 * whether waiting can help: `transient` (an owner still starting has not published its file yet),
 * `foreign` (proven not to be the integration: another user's, another boot's, or a reused pid) or
 * `unknown` (it cannot be proven either way, for example without ps or on Windows).
 *
 * The reuse proof compares the lock's creation time with the process's start from ps: when
 * `startedUptime` is recorded, monotonic uptime comparison prevents clock step vulnerabilities.
 * For legacy locks, wall-clock `startedAt` is compared.
 */
export async function serviceOwner(home: string, service: Service = DASHBOARD): Promise<ServiceOwner> {
  const lockFile = path.join(home, 'integrations', `${service.lock}.lock`);
  const infoFile = path.join(home, service.info);
  let lock, lockInfo;
  try { lockInfo = await lstat(lockFile); lock = await readJson(lockFile); } catch { return { reason: `${lockFile} is missing or unreadable`, alive: false }; }
  if (!lockInfo.isFile() || !Number.isSafeInteger(lock?.pid) || lock.pid <= 0 || typeof lock.bootTime !== 'number' || !Number.isFinite(Date.parse(lock.startedAt))) {
    return { reason: `${lockFile} is not a complete integration lock`, alive: false };
  }
  const { pid } = lock;
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH') return { reason: `its pid ${pid} has exited`, alive: false };
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EPERM') return { reason: `pid ${pid} belongs to another user`, alive: true, kind: 'foreign' };
    return { reason: `pid ${pid} cannot be signalled (${(error as NodeJS.ErrnoException | undefined)?.code ?? error})`, alive: true, kind: 'unknown' };
  }
  const refuse = (reason: string, kind: 'transient' | 'foreign' | 'unknown') => ({ reason, alive: true, kind });
  if (process.platform === 'win32') return refuse('alp does not stop it on Windows', 'unknown');
  const uid = process.getuid?.();
  if (lockInfo.uid !== uid) return refuse('its lock is not yours', 'foreign');
  if (!isSameBoot(lock)) return refuse('its lock is from another boot', 'foreign');
  if (pid === process.pid || pid === (await readLock(home).catch(() => undefined))?.pid) return refuse(`pid ${pid} is not an integration`, 'foreign');
  const times = await processTimes(pid);
  if (times === undefined) return refuse(`the start time of pid ${pid} is unknown`, 'unknown');
  // When startedUptime is recorded, monotonic uptime comparison prevents clock step vulnerabilities.
  // Otherwise, fallback to wall-clock startedAt comparison with 2s tolerance for ps resolution.
  const isReused = typeof lock.startedUptime === 'number'
    ? (Math.floor(os.uptime()) - times.elapsed) > lock.startedUptime + 2
    : times.started > Date.parse(lock.startedAt) + 2_000;
  if (isReused) return refuse(`pid ${pid} started after the lock was written (a reused pid)`, 'foreign');
  // The lock's owner; its published file must name it too (an owner still starting has not written it yet).
  let info, infoStat;
  try { infoStat = await lstat(infoFile); info = await readJson(infoFile); } catch { return refuse(`${infoFile} is missing or unreadable`, 'transient'); }
  if (info?.pid !== pid) return refuse(`${infoFile} names another process than the lock`, 'transient');
  if (!infoStat.isFile() || infoStat.uid !== uid) return refuse(`${infoFile} is not yours`, 'foreign');
  return { pid, app: info.app };
}

/**
 * Sends SIGTERM to a proven owner and waits for it to exit.
 */
async function terminate(pid: number, what: string, timeoutMs = 20_000) {
  try { process.kill(pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH') return; throw error; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH') return; }
    await sleep(100);
  }
  throw new Error(`${what} (pid ${pid}) did not stop within ${timeoutMs / 1000} s of SIGTERM; stop it, then run the command again`);
}

const PASEO_BEFORE_RENAME = 'The Paseo integration from before its rename';

/** What a proven owner of `service`'s lock is, by the `app` its file names. */
const ownerName = (service: Service, app: unknown) => app === service.app || service === DASHBOARD ? service.what : PASEO_BEFORE_RENAME;

/**
 * Stops whatever runs as `service` (alp dashboard; for LEGACY_WEB, alp web from before the rename or
 * the Paseo integration from before its own), waiting up to `timeoutMs` for a starting owner to
 * publish what proves it. Resolves with the pid it stopped, or undefined once no live process owns
 * the lock; refuses at once an owner that is foreign or cannot be proven.
 */
export async function stopService(home: string, timeoutMs = 30_000, service: Service = DASHBOARD): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const owner = await serviceOwner(home, service);
    if ('pid' in owner) { await terminate(owner.pid, ownerName(service, owner.app)); return owner.pid; }
    if (!owner.alive) return undefined;
    // Only an owner still starting can become provable; waiting changes nothing else.
    if (owner.kind !== 'transient' || Date.now() >= deadline) throw new Error(`${refusal(home, service)} (${owner.reason}); stop it, then run the command again`);
    await sleep(200);
  }
}

/** The opening of the message for a lock held by a process alp would not stop. */
export function refusal(home: string, service: Service = DASHBOARD): string {
  const lock = path.join(home, 'integrations', `${service.lock}.lock`);
  return service === DASHBOARD
    ? `${lock} is held by a process that alp cannot prove is alp dashboard, so it was left running`
    : `${lock} is held by a process that alp cannot prove is ${service.what} or the Paseo integration from before its rename, so it was left running`;
}

/**
 * Probes whether the published dashboard URL is live and answering requests.
 * Accepts only loopback HTTP/HTTPS addresses.
 */
export async function isDashboardReady(url: string | undefined, timeoutMs = 1_000): Promise<boolean> {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) return false;
    const res = await fetch(parsed.href, { signal: AbortSignal.timeout(timeoutMs) });
    return typeof res.status === 'number' && res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Whether the published file is genuinely claimed by a live alp-dashboard process.
 * If the process is proven foreign (e.g. a reused PID or from another boot) or
 * the URL does not answer HTTP requests, it is never claimed.
 */
export async function isServiceClaimed(
  // any: the service's published <name>.json as read from disk; only app, pid and url are checked.
  published: any,
  lockPid: number | undefined,
  // any: serviceOwner's answer, or a caller's stand-in for it; only `kind` is read.
  held: any,
  timeoutMs = 1_000,
): Promise<boolean> {
  if (published?.app !== DASHBOARD.app || published.pid !== lockPid) return false;
  if (held?.kind === 'foreign') return false;
  return isDashboardReady(published.url, timeoutMs);
}

// ---- The token socket (t-cee3): the service serves it (./dashboard/token-socket.js), `alp dashboard` reads it. ----

/** The request line a client writes to alp dashboard's token socket (./dashboard/token-socket.js). */
export const TOKEN_REQUEST = '{"op":"token"}';
/** A token as the gateway issues it. */
const TOKEN = /^alpgw1\.[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/;

/**
 * Where the service answers for `home`.
 */
export function tokenSocketPath(home: string, { platform = process.platform }: { platform?: NodeJS.Platform } = {}): string {
  const hash = createHash('sha256').update(home).digest('hex');
  if (platform === 'win32') return `\\\\.\\pipe\\alp-dashboard-${hash.slice(0, 24)}`;
  const preferred = path.join(home, 'dashboard', 'token.sock');
  return Buffer.byteLength(preferred) < 100
    ? preferred
    : path.join(os.tmpdir(), `alp-dashboard-${process.getuid?.() ?? 'user'}-${hash.slice(0, 12)}`, 'token.sock');
}

/**
 * Throws unless `socketPath` is a socket of the user's with mode 0600 in a directory of the user's
 * with mode 0700 (POSIX; nothing to check for a Windows pipe).
 */
export async function assertTokenSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = path.dirname(socketPath);
  await assertPrivateDirectory(directory).catch(error => {
    throw new Error(`alp dashboard's token socket must be in a directory owned by you with mode 0700: ${directory} is not (${error?.message ?? error})`, { cause: error });
  });
  const info = await lstat(socketPath);
  if (!info.isSocket()) throw new Error(`alp dashboard's token socket ${socketPath} is not a socket`);
  if (info.uid !== process.getuid?.()) throw new Error(`alp dashboard's token socket ${socketPath} is not yours (uid ${info.uid})`);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`alp dashboard's token socket ${socketPath} must have mode 0600, not ${(info.mode & 0o777).toString(8).padStart(4, '0')}`);
}

/**
 * Asks the running service of `home` for its token. Throws when there is no service, the socket is
 * not private, or the answer is not a token.
 */
export async function readToken(home: string, { timeoutMs = 5_000 }: { timeoutMs?: number } = {}): Promise<{ token: string; credentialId: string | undefined; pid: number | undefined }> {
  const socketPath = tokenSocketPath(home);
  await assertTokenSocket(socketPath);
  const text = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(socketPath);
    let received = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`alp dashboard did not answer on ${socketPath} within ${timeoutMs} ms`)); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${TOKEN_REQUEST}\n`));
    socket.on('data', chunk => { received += chunk; if (received.length > 4_096) socket.destroy(); });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', () => { clearTimeout(timer); resolve(received); });
  });
  let answer;
  try { answer = JSON.parse(text); } catch { answer = undefined; }
  if (typeof answer?.token !== 'string' || !TOKEN.test(answer.token)) throw new Error(`alp dashboard gave no token on ${socketPath}`);
  return { token: answer.token, credentialId: typeof answer.credentialId === 'string' ? answer.credentialId : undefined, pid: Number.isSafeInteger(answer.pid) ? answer.pid : undefined };
}
