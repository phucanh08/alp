import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, readdir, rename, rmdir, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scrubText } from '@anhlp/alp-core/log';
import { entryCommand, isNativeDaemonName } from '@anhlp/alp-core/packaged';
import { bootId, bootTime, processBirth } from './boot.ts';
import { holdOps, lockAlive, readLock } from './lock.ts';
import { alpHome, assertPrivateDirectory, daemonPaths, findDaemonEntry } from './paths.ts';
import type { HoldOps } from './lock.ts';

/** One start or stop of alpd in its lifecycle directory, read from its owner token. */
export type LifecycleOwner = { token: string, pid: number, bootTime: number, action: string, id?: string, proof?: string };

/** Why a launcher failed, from the last structured log line it wrote to stderr: code and message, scrubbed. */
function launcherReason(text: string): string {
  const line = text.trim().split('\n').filter(Boolean).at(-1);
  if (!line) return '';
  let reason = line;
  try {
    const record = JSON.parse(line);
    reason = `${record.code ? `${record.code}, ` : ''}${record.msg}${record.error?.message ? `: ${record.error.message}` : ''}`;
  } catch {}
  return `: ${scrubText(reason, { max: 600 })}`;
}

async function tail(file: string, lines = 30): Promise<string> {
  // The tail goes into an error message, so it is scrubbed like every other log output.
  try { return scrubText((await readFile(file, 'utf8')).split('\n').slice(-lines).join('\n'), { max: 8000 }); } catch { return ''; }
}

/** This process's own birth: it never changes, so it is asked for once. */
let ownBirth: string | undefined | null = null;

/** How long one check of a lifecycle owner's proof stands before it is made again. */
const LIFECYCLE_PROOF_TTL_MS = 1_000;
/** How long admission waits when no alp command holds it and yet it cannot be taken. */
const LIFECYCLE_STUCK_MS = 30_000;

const lifecycleDirectory = (home: string) => path.join(home, 'state', 'alpd.starting');
/** The Windows hold of a lifecycle owner: outside the directory it publishes, which Windows would not move with an open handle inside. */
const lifecycleHold = (home: string, id: string) => path.join(home, 'state', `alpd.lifecycle-${id}.held`);

/**
 * Immutable admission identities live in filenames, including for service hard links.
 *
 * `owner-<pid>-<boot time>-<start|stop>-<uuid>[-<proof>]`. The proof says how to tell the owner
 * from another process that later got its pid (t-dc0e): `c<ticks>` or `b<time>` is the owner's
 * birth as processBirth reads it, `e` a hold the owner keeps open on Windows (lifecycleHold, the
 * handle of t-a5d8). A name without one comes from an older ALP and is judged by its pid; an
 * older ALP reads a name with one as it always did, since the proof is hex digits after the uuid.
 */
async function lifecycleOwners(home: string): Promise<LifecycleOwner[]> {
  const names = await readdir(lifecycleDirectory(home)).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return names.map(token => {
    const match = /^owner-(\d+)-(\d+)-(start|stop)-[a-f0-9-]+$/.exec(token);
    if (!match) throw new Error('Invalid alpd startup admission owner');
    const proven = /-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})-(c\d+|b\d{14}|e)$/.exec(token);
    return { token, pid: Number(match[1]), bootTime: Number(match[2]), action: match[3], ...(proven ? { id: proven[1], proof: proven[2] } : {}) };
  });
}

/**
 * Whether a lifecycle owner still runs, and whether that was more than a look at its pid.
 * A proof that cannot be checked here leaves the owner alive: only a different birth, or a hold
 * nobody has open, shows that the pid belongs to someone else now.
 */
function lifecycleOwnerState(home: string, owner: LifecycleOwner, { platform = process.platform, ops = holdOps }: { platform?: NodeJS.Platform, ops?: HoldOps } = {}): { alive: boolean, proven: boolean } {
  if (!lockAlive(owner)) return { alive: false, proven: true };
  if (owner.proof === 'e') return platform === 'win32' ? { alive: ops.taken(lifecycleHold(home, owner.id!)), proven: true } : { alive: true, proven: false };
  if (!owner.proof) return { alive: true, proven: false };
  const birth = processBirth(owner.pid, { platform });
  if (birth === undefined || birth[0] !== owner.proof[0]) return { alive: true, proven: false };
  return { alive: birth === owner.proof, proven: true };
}

/** Removes what a dead owner left: its token, then its hold. */
async function reapLifecycleOwner(home: string, owner: LifecycleOwner): Promise<void> {
  await unlink(path.join(lifecycleDirectory(home), owner.token)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (owner.proof === 'e') await unlink(lifecycleHold(home, owner.id!)).catch(() => {});
}

/** The start or stop that holds the lifecycle of `home` now, if one does. */
export async function readDaemonLifecycle(home: string, { platform = process.platform, ops = holdOps }: { platform?: NodeJS.Platform, ops?: HoldOps } = {}): Promise<LifecycleOwner | undefined> {
  return (await lifecycleOwners(home)).find(owner => lifecycleOwnerState(home, owner, { platform, ops }).alive);
}

/**
 * How long a start or stop waits behind one unchanged holder of the lifecycle before it gives up:
 * twice the start timeout (a start waits that long for its launcher and again for readiness) and
 * half a minute, so 150 s by default. A holder that finishes sooner is never cut short.
 */
export function daemonLifecycleWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return 2 * daemonStartTimeoutMs(env) + 30_000;
}

/** Serializes requested starts and stops, including the time before alpd has a lock.
 * Rename publishes a fully populated directory: an existing nonempty directory cannot
 * be replaced. Reaping/release unlinks only its unique owner token, then rmdir; even
 * racing stale reapers cannot remove a successor's nonempty directory.
 *
 * An owner is alive while its pid runs AND its proof holds (lifecycleOwners): the token of a
 * crashed owner is reaped even when another process has its pid. Where no proof can be had, the
 * wait is bounded instead: after `waitMs` behind the same holder, or LIFECYCLE_STUCK_MS with no
 * holder at all, this rejects with ALP_LIFECYCLE_BUSY and says what to remove. It never takes the
 * lifecycle from a holder it cannot show to be gone.
 */
export async function withDaemonLifecycle<T>(home: string, action: 'start' | 'stop', run: () => T | Promise<T>, { joinStart = false, signal = undefined, waitMs = daemonLifecycleWaitMs(), platform = process.platform, ops = holdOps }: { joinStart?: boolean, signal?: AbortSignal, waitMs?: number, platform?: NodeJS.Platform, ops?: HoldOps } = {}): Promise<T> {
  signal?.throwIfAborted();
  try {
    await assertPrivateDirectory(home, { create: true });
  } catch (cause) {
    // Admission now prepares the home before the launcher can report this failure.
    // Preserve the operator-facing startup code at this earlier boundary.
    throw Object.assign(new Error(`ALP_HOME_UNUSABLE, alpd failed to start while preparing its home: ${(cause as Error).message}`, { cause }), { code: 'ALP_HOME_UNUSABLE' });
  }
  const state = path.join(home, 'state');
  await assertPrivateDirectory(state, { create: true });
  const directory = lifecycleDirectory(home);
  const currentBootId = bootId();
  const id = randomUUID();
  // The proof comes before the token: whoever can read the token can already check it.
  let proof: string | undefined, hold: string | undefined, fd: number | undefined;
  if (platform === 'win32') {
    hold = lifecycleHold(home, id);
    try {
      fd = ops.take(hold);
      // As for alpd's lock: the hold counts only if a second open really fails.
      if (ops.taken(hold)) proof = 'e';
    } catch {}
  } else {
    if (ownBirth === null) ownBirth = processBirth(process.pid, { platform });
    proof = ownBirth;
  }
  const token = `owner-${process.pid}-${bootTime()}-${action}-${id}${proof ? `-${proof}` : ''}`;
  const candidate = path.join(state, `alpd.starting-${token}`);
  try {
    await mkdir(candidate, { mode: 0o700 });
    await writeFile(path.join(candidate, token), JSON.stringify({
      pid: process.pid,
      bootTime: bootTime(),
      ...(currentBootId ? { bootId: currentBootId } : {}),
      startedUptime: Math.floor(os.uptime()),
      action,
    }), { mode: 0o600 });
    let joined = false;
    if (joinStart) {
      const owner = await readDaemonLifecycle(home, { platform, ops });
      if (owner?.action === 'start') {
        try {
          // Linking the unique source token both validates this generation and
          // pins its directory until this service has finished starting.
          await link(path.join(directory, owner.token), path.join(directory, token));
          joined = true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    // What blocks admission now and since when; the clock restarts whenever that changes.
    let blocker: string | undefined, since = 0;
    /** token → its owner's state and when it was read: ps is too slow to ask on every turn. */
    const checked = new Map<string, { at: number, alive: boolean, proven: boolean }>();
    while (!joined) {
      signal?.throwIfAborted();
      try { await rename(candidate, directory); break; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code!)) throw error;
        const holders: Array<LifecycleOwner & { proven: boolean }> = [];
        for (const owner of await lifecycleOwners(home)) {
          let seen = checked.get(owner.token);
          // A pid that is gone is seen at once; the proof is read again when it is a second old.
          if (!seen || Date.now() - seen.at >= LIFECYCLE_PROOF_TTL_MS || !lockAlive(owner)) {
            seen = { at: Date.now(), ...lifecycleOwnerState(home, owner, { platform, ops }) };
            checked.set(owner.token, seen);
          }
          if (seen.alive) holders.push({ ...owner, proven: seen.proven });
          else await reapLifecycleOwner(home, owner);
        }
        await rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
        const now = holders.map(owner => owner.token).sort().join(' ') || `!${(error as NodeJS.ErrnoException).code}`;
        if (now !== blocker) { blocker = now; since = Date.now(); }
        const waited = Date.now() - since;
        if (waited >= (holders.length ? waitMs : Math.min(waitMs, LIFECYCLE_STUCK_MS))) throw lifecycleBusy(home, action, holders, waited, error as NodeJS.ErrnoException);
        await delay(25, undefined, { signal });
      }
    }
    try { signal?.throwIfAborted(); return await run(); }
    finally {
      await unlink(path.join(directory, token));
      await rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
    }
  } finally {
    try {
      await unlink(path.join(candidate, token)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } finally {
      // Our token is gone from both places; only then the hold, so no one sees the token unheld.
      if (hold) {
        if (fd !== undefined) { try { ops.close(fd); } catch {} }
        await unlink(hold).catch(() => {});
      }
    }
  }
}

/** Why admission gave up: who holds the lifecycle, for how long it was watched, and what to do. */
function lifecycleBusy(home: string, action: string, holders: Array<LifecycleOwner & { proven: boolean }>, waited: number, cause: NodeJS.ErrnoException) {
  const directory = lifecycleDirectory(home);
  const seconds = Math.max(1, Math.round(waited / 1000));
  const [holder] = holders;
  const message = !holder
    ? `Could not ${action} alpd: its lifecycle in ${home} could not be taken for ${seconds} s (${cause.code}) although no alp command holds it. Check the permissions of ${directory} or remove it, then try again`
    : holder.proven
      ? `Could not ${action} alpd: waited ${seconds} s for another ${holder.action} of alpd (pid ${holder.pid}) that still runs. Wait for it or stop pid ${holder.pid}, then try again`
      : `Could not ${action} alpd: waited ${seconds} s for a ${holder.action} of alpd recorded for pid ${holder.pid}, and could not tell whether pid ${holder.pid} is still that command. If pid ${holder.pid} is neither alpd nor an alp command, that command crashed and its pid went to another process: remove ${path.join(directory, holder.token)} and try again`;
  return Object.assign(new Error(message, { cause }), { code: 'ALP_LIFECYCLE_BUSY', ...(holder ? { pid: holder.pid } : {}) });
}

/** How long a start waits for alpd to be ready by default: generous, as a loaded host can take a while. */
export const DAEMON_START_TIMEOUT_MS = 60_000;
/** The largest wait ALP_DAEMON_START_TIMEOUT_MS may ask for (one hour; setTimeout's own bound is about 24 days). */
const DAEMON_START_TIMEOUT_MAX_MS = 3_600_000;

/**
 * The time a start of alpd waits for it to become ready, in ms: ALP_DAEMON_START_TIMEOUT_MS when it
 * is a positive whole number of at most one hour, else DAEMON_START_TIMEOUT_MS.
 */
export function daemonStartTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALP_DAEMON_START_TIMEOUT_MS?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return DAEMON_START_TIMEOUT_MS;
  const value = Number(raw);
  return value > 0 && value <= DAEMON_START_TIMEOUT_MAX_MS ? value : DAEMON_START_TIMEOUT_MS;
}

/**
 * Returns the socket of a ready daemon, starting one when none runs.
 * `entry` is the daemon script; it is started through its own detaching launcher so the
 * daemon outlives the client that started it.
 */
export async function ensureDaemon({ home = alpHome(), entry = undefined, env = process.env, execPath = process.execPath, timeoutMs = daemonStartTimeoutMs(env), lifecycleLocked = false, signal = undefined }: { home?: string, entry?: string, env?: NodeJS.ProcessEnv, execPath?: string, timeoutMs?: number, lifecycleLocked?: boolean, signal?: AbortSignal } = {}): Promise<string> {
  signal?.throwIfAborted();
  if (!lifecycleLocked) return withDaemonLifecycle(home, 'start', () => ensureDaemon({ home, entry, env, execPath, timeoutMs, lifecycleLocked: true, signal }), { signal });
  const ready = async () => {
    const lock = await readLock(home);
    return lockAlive(lock) && lock!.ready ? lock!.socket : undefined;
  };
  const live = await ready();
  if (live) return live;
  const held = await readLock(home);
  if (lockAlive(held) && held!.maintenance) throw new Error(`ALP is busy: alp ${held!.maintenance} runs (pid ${held!.pid}); alpd starts again when it finishes`);
  if (!lockAlive(held)) {
    entry ??= await findDaemonEntry({ home, env });
    if (!entry) throw new Error('ALP daemon is not running and alpd.js was not found. Install the ALP CLI and run `alp daemon start`, or set ALP_DAEMON_ENTRY to alpd.js');
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const launch = entryCommand(entry!, 'daemon', ['--detach', `--startup-timeout=${timeoutMs}`], execPath);
      // BUN_BE_BUN=1 would turn the native alpd (t-81b0.9) into the Bun CLI instead of starting alpd.
      const launchEnv: NodeJS.ProcessEnv = { ...env, ALP_HOME: home, ELECTRON_RUN_AS_NODE: '1' };
      if (isNativeDaemonName(launch.command)) delete launchEnv.BUN_BE_BUN;
      const launcher = spawn(launch.command, launch.args, {
        env: launchEnv,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      // The launcher writes only when it fails, and before alpd has a log to write to.
      let failure = '';
      launcher.stderr.on('data', chunk => { if (failure.length < 8000) failure += chunk; });
      launcher.once('error', reject);
      launcher.once('close', code => code === 0 ? resolve() : reject(new Error(`ALP daemon launcher exited (${code})${launcherReason(failure)}`)));
    });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const socket = await ready();
    if (socket) return socket;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const log = await tail(daemonPaths(home).log);
  throw new Error(`ALP daemon did not become ready within ${timeoutMs} ms${log ? `\n${log}` : ''}`);
}
