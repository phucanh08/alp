import { readFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { connect, daemonPaths, lockAlive, readLock } from '../../index.ts';
import { installedProgram, serviceFor } from '../../daemon/service.ts';
import { readLogTail } from '@anhlp/alp-core/log';
import type { LogRecord } from '@anhlp/alp-core/log';
import type { DoctorCheck } from './types.ts';

/** The fields of alpd's lock that doctor reads. */
type DaemonLock = { pid: number; socket: string; version?: string; ready?: boolean; maintenance?: string; startedAt: string };
/** The part of alpd's daemon.status answer that doctor reads. */
type DaemonStatus = { protocolVersion?: number | string; version?: string; health?: { ready: boolean; checks: Array<{ ok: boolean; id: string; code?: string; message?: string }> } };
/** A failed connection or request: an Error, perhaps with a code. */
type IpcError = Error & { code?: string };

/** An array with ES2023's findLast and findLastIndex, which Node has and the ES2022 library types lack. */
type FindLastArray<T> = T[] & { findLast(predicate: (value: T) => unknown): T | undefined; findLastIndex(predicate: (value: T) => unknown): number };

/** An installed alpd service whose node, alpd.js or native alpd moved can no longer start alpd. */
export async function serviceCheck(home: string, env: NodeJS.ProcessEnv): Promise<DoctorCheck | undefined> {
  const service = serviceFor({ home, env });
  const program = service && await installedProgram(service);
  if (!program) return undefined;
  const missing: string[] = [];
  // [node, alpd.js], or [alpd, --service] for the native alpd (t-81b0.9): only the files.
  for (const file of program.filter(arg => path.isAbsolute(arg))) if (!await lstat(file).then(() => true, () => false)) missing.push(file);
  return missing.length
    ? { id: 'service', status: 'fail', summary: `the ${service!.kind} service ${service!.name} runs files that are gone; run alp daemon install again`, details: missing }
    : { id: 'service', status: 'ok', summary: `${service!.kind} runs alpd as ${service!.name}` };
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;

/** Codes of the failures a start can stop at, and of the ones that mean another alpd is running. */
const STARTUP_CODES = new Set(['ALP_HOME_UNUSABLE', 'ALP_LOCK_FAILED', 'ALP_STARTUP_FAILED', 'ALP_IPC_LISTEN_FAILED']);
const GROUPS = [
  { id: 'persistence log', match: /^ALP_(PERSISTENCE|STATE|RECORD|TIMELINE)_/, hint: 'alpd could not read or write its state; check free space and the permissions of the state directory' },
  { id: 'ipc log', match: /^ALP_(IPC|RPC)_/, hint: 'clients had trouble talking to alpd; alp daemon restart reopens the endpoint' },
  { id: 'provider log', match: /^ALP_PROVIDER_/, hint: 'a runtime process failed or would not start; the runtime checks above say whether it is installed and logged in' },
];

/** What a failed connection to alpd's socket means, as a code the log uses too. */
function ipcFailure(error: IpcError | undefined): string {
  if (error?.code === 'ALP_IPC_TIMEOUT') return 'ALP_IPC_TIMEOUT';
  if (error?.code === 'ENOENT') return 'ALP_IPC_SOCKET_MISSING';
  if (error?.code === 'ECONNREFUSED') return 'ALP_IPC_REFUSED';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'ALP_IPC_DENIED';
  if (/private|owned by|ancestors|symlink/.test(error?.message ?? '')) return 'ALP_IPC_SOCKET_UNSAFE';
  return 'ALP_IPC_FAILED';
}

/** Asks a running alpd for its status; `error` says why it could not be asked. */
async function askDaemon(lock: DaemonLock, timeoutMs: number): Promise<{ status: DaemonStatus; error?: undefined } | { status?: undefined; error: IpcError }> {
  let timer: NodeJS.Timeout | undefined;
  const attempt = connect(lock.socket, { name: 'alp-doctor', version: '1' }).then(async client => {
    try { return await client.request('daemon.status'); } finally { client.close(); }
  });
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`no answer within ${seconds(timeoutMs)}`), { code: 'ALP_IPC_TIMEOUT' })), timeoutMs); });
  try { return { status: await Promise.race([attempt, timeout]) as DaemonStatus }; }
  catch (error) { attempt.catch(() => {}); return { error: error as IpcError }; }
  finally { clearTimeout(timer); }
}

/**
 * alpd as a client sees it (ALPD §67): whether its IPC endpoint answers, and whether it is ready,
 * which is more than alive: it accepts connections and its state is readable and writable now.
 */
export async function daemonHealthChecks(lock: DaemonLock | undefined, timeoutMs: number): Promise<DoctorCheck[]> {
  if (!lockAlive(lock) || lock!.maintenance) return [];
  const { status, error } = await askDaemon(lock!, timeoutMs);
  if (error) {
    const code = ipcFailure(error);
    // A socket that is missing right after start is still being opened.
    const starting = !lock!.ready && Date.now() - Date.parse(lock!.startedAt) < 60_000;
    return [{
      id: 'ipc', status: starting ? 'info' : 'fail',
      summary: `alpd (pid ${lock!.pid}) is running but ${starting ? 'does not answer yet, it is still starting' : 'cannot be reached'} on ${lock!.socket}: ${code}, ${error.message}`,
      details: [`code ${code}`, ...(starting ? [] : ['alp daemon restart starts it again; its work is kept and continued'])],
    }];
  }
  const checks: DoctorCheck[] = [{ id: 'ipc', status: 'ok', summary: `alpd answers on ${lock!.socket} (protocol ${status.protocolVersion})` }];
  const health = status.health;
  if (!health) { checks.push({ id: 'readiness', status: 'info', summary: `alpd ${status.version} does not report readiness; alp daemon restart updates it` }); return checks; }
  const failing = health.checks.filter(check => !check.ok);
  checks.push(health.ready
    ? { id: 'readiness', status: 'ok', summary: 'alpd is ready: it accepts connections and reads and writes its state' }
    : {
      id: 'readiness', status: 'fail',
      summary: `alpd is alive but not ready: ${failing.map(check => check.code ?? check.id).join(', ')}`,
      details: failing.map(check => `${check.code ?? check.id}: ${check.message ?? 'failed'}`),
      hint: 'new prompts may fail until this clears; alp doctor shows the state directory below',
    });
  if (!lock!.ready) checks.push({ id: 'startup', status: 'warn', summary: 'alpd answers but has not finished starting' });
  return checks;
}

const brief = (record: LogRecord): string => `${record.time} ${record.component} ${record.code ?? ''} ${record.msg}${record.sessionId ? ` [session ${record.sessionId}]` : ''}`.replace(/\s+/g, ' ').trim();

/** What alpd's own log says: where the last start stopped, and the failures logged since it was ready. */
export async function logChecks(home: string, running: boolean): Promise<DoctorCheck[]> {
  const file = daemonPaths(home).log;
  let records: FindLastArray<LogRecord>;
  try { records = (await readLogTail(file)).filter(record => !record.legacy) as FindLastArray<LogRecord>; }
  catch (error) { return [{ id: 'log', status: 'warn', summary: `${file} cannot be read: ${(error as Error).message}` }]; }
  if (!records.length) return [];
  const lastReady = records.findLastIndex(record => record.event === 'ready');
  const since = records.slice(lastReady + 1) as FindLastArray<LogRecord>;
  const checks: DoctorCheck[] = [];
  const failure = since.findLast(record => record.level === 'error' && STARTUP_CODES.has(record.code as string));
  if (failure) checks.push({
    id: 'startup', status: running ? 'info' : 'fail',
    summary: `${running ? 'an attempt to start another alpd' : 'the last alpd'} failed at ${failure.time}: ${failure.code}, ${failure.msg}`,
    details: [...(failure.error ? [`${failure.error.name ?? 'Error'}${failure.error.code ? ` ${failure.error.code}` : ''}: ${failure.error.message}`] : []), `log: ${file}`],
    ...(running ? {} : { hint: 'fix the cause and run alp daemon start; its work is kept and continued' }),
  });
  for (const group of GROUPS) {
    const found = since.filter(record => (record.level === 'error' || record.level === 'warn') && group.match.test(record.code ?? ''));
    if (!found.length) continue;
    const counts = new Map();
    for (const record of found) counts.set(record.code, (counts.get(record.code) ?? 0) + 1);
    checks.push({
      id: group.id, status: 'warn',
      summary: `${found.length} problem${found.length > 1 ? 's' : ''} logged since alpd was last ready: ${[...counts].map(([code, count]) => `${code} x${count}`).join(', ')}`,
      details: [...found.slice(-5).map(brief), group.hint],
    });
  }
  return checks;
}

export async function daemonCheck(home: string): Promise<DoctorCheck> {
  const paths = daemonPaths(home);
  const lock = await readLock(home);
  const exists = (file: string) => lstat(file).then(() => true, () => false);
  if (lockAlive(lock) && lock!.maintenance) return { id: 'alpd', status: 'info', summary: `not running while alp ${lock!.maintenance} runs (pid ${lock!.pid})` };
  if (lockAlive(lock)) return { id: 'alpd', status: 'ok', summary: `running (pid ${lock!.pid}, ${lock!.version})${lock!.ready ? '' : ', starting'}` };
  const stale: string[] = [];
  if (await exists(paths.lock)) stale.push(paths.lock);
  if (await exists(paths.socket)) stale.push(paths.socket);
  const marker = path.join(home, 'state', 'alpd.running');
  const crashed = await exists(marker);
  // A stop that was asked for and cut short says so in the marker (t-11c7): alpd reads that as a restart, not a crash.
  const cutShort = crashed && await readFile(marker, 'utf8').then(text => typeof JSON.parse(text)?.stopping === 'string').catch(() => false);
  const after = !crashed ? ''
    : cutShort ? '; the last alpd was stopped before it had finished stopping, and the next start continues its work'
    : '; the last alpd stopped unexpectedly, and the next start continues its work';
  if (!stale.length) return { id: 'alpd', status: crashed ? 'info' : 'ok', summary: `not running${after}` };
  return {
    id: 'alpd', status: 'warn', summary: `not running, and left ${stale.map(file => path.basename(file)).join(' and ')} behind${after}`,
    fix: {
      describe: `remove ${stale.join(', ')}`,
      async apply() {
        // Check again: an alpd may have started meanwhile.
        if (lockAlive(await readLock(home))) return 'skipped: alpd started meanwhile';
        for (const file of stale) await unlink(file).catch(() => {});
        return `removed ${stale.length} stale file${stale.length > 1 ? 's' : ''}`;
      },
    },
  };
}
