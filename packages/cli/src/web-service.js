import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bootTime, isSameBoot, readLock } from '@anhlp/alp-client/index';
import { distributionEntry } from './paths.js';
import { isPackaged, selfEntry } from '@anhlp/alp-core/packaged';

/**
 * The CLI's side of alp-web (packages/cli/src/web), the service behind `alp web`: where it is, which
 * process owns its lock, and how to stop that process safely.
 *
 * Only a process proven to be the one that took `integrations/web.lock` is ever signalled, and only
 * with SIGTERM (the CLI's own `--rotate` child aside, which it may time out): the lock and `web.json` name the same pid, both files are the user's, the lock is
 * from this boot, the pid answers signal 0 (so it is the user's own process), and that process
 * started no later than the lock was written (so the pid was not reused). Anything else is reported
 * and left alone. A stopped owner releases the lock; one that died holding it leaves it to the next
 * acquire, which reclaims it only on proof of death (the integration lock protocol, t-e148).
 */

const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The alp-web service script beside this CLI; a clear error when this CLI was built without it. */
export function alpWebScript() {
  const entry = fileURLToPath(distributionEntry('alp-web.js'));
  // The ALP executable carries alp-web inside itself.
  if (!isPackaged() && !existsSync(entry)) throw new Error(`alp web is not built: ${entry} is missing. Build the CLI (npm run build in the ALP checkout) or reinstall ALP.`);
  return entry;
}

/** What starts alp-web: its script under Node, or the ALP executable (`alp web serve`). */
export const alpWebEntry = () => selfEntry(alpWebScript());

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

/** When `pid` started and elapsed seconds from ps, or undefined when ps cannot say. @param {number} pid */
async function processTimes(pid) {
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
 * The process that owns alp web's lock, if it is proven safe to stop; else why not. `kind` says
 * whether waiting can help: `transient` (an owner still starting has not published web.json yet),
 * `foreign` (proven not to be the integration: another user's, another boot's, or a reused pid) or
 * `unknown` (it cannot be proven either way, for example without ps or on Windows).
 *
 * The reuse proof compares the lock's creation time with the process's start from ps: when
 * `startedUptime` is recorded, monotonic uptime comparison prevents clock step vulnerabilities.
 * For legacy locks, wall-clock `startedAt` is compared.
 * @param {string} home
 * @returns {Promise<{ pid: number, app: unknown } | { reason: string, alive: boolean, kind?: 'transient' | 'foreign' | 'unknown' }>}
 */
export async function webOwner(home) {
  const lockFile = path.join(home, 'integrations', 'web.lock');
  const infoFile = path.join(home, 'web.json');
  let lock, lockInfo;
  try { lockInfo = await lstat(lockFile); lock = await readJson(lockFile); } catch { return { reason: `${lockFile} is missing or unreadable`, alive: false }; }
  if (!lockInfo.isFile() || !Number.isSafeInteger(lock?.pid) || lock.pid <= 0 || typeof lock.bootTime !== 'number' || !Number.isFinite(Date.parse(lock.startedAt))) {
    return { reason: `${lockFile} is not a complete integration lock`, alive: false };
  }
  const { pid } = lock;
  try { process.kill(pid, 0); } catch (error) {
    if (error?.code === 'ESRCH') return { reason: `its pid ${pid} has exited`, alive: false };
    if (error?.code === 'EPERM') return { reason: `pid ${pid} belongs to another user`, alive: true, kind: 'foreign' };
    return { reason: `pid ${pid} cannot be signalled (${error?.code ?? error})`, alive: true, kind: 'unknown' };
  }
  const refuse = (/** @type {string} */ reason, /** @type {'transient' | 'foreign' | 'unknown'} */ kind) => ({ reason, alive: true, kind });
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
  // The lock's owner; web.json must name it too (an owner still starting has not written it yet).
  let info, infoStat;
  try { infoStat = await lstat(infoFile); info = await readJson(infoFile); } catch { return refuse(`${infoFile} is missing or unreadable`, 'transient'); }
  if (info?.pid !== pid) return refuse(`${infoFile} names another process than the lock`, 'transient');
  if (!infoStat.isFile() || infoStat.uid !== uid) return refuse(`${infoFile} is not yours`, 'foreign');
  return { pid, app: info.app };
}

/**
 * Sends SIGTERM to a proven owner and waits for it to exit.
 * @param {number} pid @param {string} what @param {number} [timeoutMs]
 */
async function terminate(pid, what, timeoutMs = 20_000) {
  try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error?.code === 'ESRCH') return; throw error; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error?.code === 'ESRCH') return; }
    await sleep(100);
  }
  throw new Error(`${what} (pid ${pid}) did not stop within ${timeoutMs / 1000} s of SIGTERM; stop it, then run the command again`);
}

/** Whether `web.json` is alp-web's own (the pre-rename Paseo integration wrote it without `app`). */
const isAlpWeb = app => app === 'alp-web';
const PASEO_BEFORE_RENAME = 'The Paseo integration from before its rename';

/**
 * Stops the Paseo integration from before its rename when it still runs as integration `web` (its
 * web.json has no `app: 'alp-web'`), so alp-web can take the lock and web.port. Returns the pid it
 * stopped. A process that cannot be proven to be that integration is left alone.
 * @param {string} home
 */
export async function stopPreRenamePaseo(home) {
  const owner = await webOwner(home);
  if (!('pid' in owner) || isAlpWeb(owner.app)) return undefined;
  await terminate(owner.pid, PASEO_BEFORE_RENAME);
  return owner.pid;
}

/**
 * Stops whatever runs as integration `web` (alp-web, or the Paseo integration from before its
 * rename), waiting up to `timeoutMs` for a starting owner to publish what proves it. Resolves once
 * no live process owns the lock; refuses at once an owner that is foreign or cannot be proven.
 * @param {string} home @param {number} [timeoutMs]
 */
export async function stopWebService(home, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const owner = await webOwner(home);
    if ('pid' in owner) { await terminate(owner.pid, isAlpWeb(owner.app) ? 'alp web' : PASEO_BEFORE_RENAME); return owner.pid; }
    if (!owner.alive) return undefined;
    // Only an owner still starting can become provable; waiting changes nothing else.
    if (owner.kind !== 'transient' || Date.now() >= deadline) throw new Error(`${refusal(home)} (${owner.reason}); stop it, then run the command again`);
    await sleep(200);
  }
}

/** The opening of the message for a web lock held by a process alp would not stop. @param {string} home */
export function refusal(home) {
  return `${path.join(home, 'integrations', 'web.lock')} is held by a process that alp cannot prove is alp web or the Paseo integration from before its rename, so it was left running`;
}

/**
 * Probes whether the published web service URL is live and answering requests.
 * Accepts only loopback HTTP/HTTPS addresses.
 * @param {string | undefined} url
 * @param {number} [timeoutMs]
 */
export async function isWebReady(url, timeoutMs = 1_000) {
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
 * Whether web metadata is genuinely claimed by a live alp-web process.
 * If the process is proven foreign (e.g. a reused PID or from another boot) or
 * the URL does not answer HTTP requests, it is never claimed.
 * @param {any} published
 * @param {number | undefined} lockPid
 * @param {any} held
 * @param {number} [timeoutMs]
 */
export async function isWebClaimed(published, lockPid, held, timeoutMs = 1_000) {
  if (published?.app !== 'alp-web' || published.pid !== lockPid) return false;
  if (held?.kind === 'foreign') return false;
  return isWebReady(published.url, timeoutMs);
}
