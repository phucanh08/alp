import { closeSync, fstatSync, openSync, unlinkSync, constants as fsConstants } from 'node:fs';
import { open, readFile, lstat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { bootId, bootTime, isSameBoot } from './boot.ts';
import { daemonPaths } from './paths.ts';
import type { Stats } from 'node:fs';

/** What alpd writes into its lock beyond the fields every lock has. */
export type DaemonLockContents = { version: string, protocolVersion: number, socket: string, maintenance?: string };
/** alpd's single-instance lock, `<home>/alpd.lock`, as acquireDaemonLock writes it. */
export type DaemonLock = DaemonLockContents & {
  pid: number, startedAt: string, startedUptime: number, bootTime: number, bootId?: string, uid: number, ready: boolean, hold?: string,
};
/** The fields of a lock record that tell whether its owner still runs. */
export type LiveLock = { pid: number, bootId?: string, bootTime?: number, hold?: string };
/** How the Windows hold on a lock is opened, probed and closed (holdOps; tests replace it). */
export type HoldOps = { take(file: string): number, taken(file: string): boolean, close(fd: number): void };

export async function readLock(home: string): Promise<DaemonLock | undefined> {
  try {
    return JSON.parse(await readFile(daemonPaths(home).lock, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * The Windows hold on alpd's lock: a handle on `alpd.lock.held` opened with share mode 0
 * (libuv's UV_FS_O_EXLOCK, 0x10000000 in uv/win.h; Node does not export it). Windows closes it
 * when the owner exits, however it exits, and a child does not inherit it, so a pid Windows has
 * already given to another process does not keep a crashed owner's lock alive (t-a5d8).
 */
const UV_FS_O_EXLOCK = 0x10000000;
export const holdOps = {
  /** Opens the hold; throws EBUSY while another handle has it open. */
  take(file: string): number {
    for (let attempt = 0; ; attempt++) {
      try { return openSync(file, fsConstants.O_RDWR | fsConstants.O_CREAT | UV_FS_O_EXLOCK, 0o600); }
      catch (error) {
        // A reader probing it (`taken`) holds it for a moment; a real owner keeps it.
        if (attempt >= 10 || !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code!)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  },
  /** True while some handle has the hold open; a missing file is free. */
  taken(file: string): boolean {
    try { closeSync(openSync(file, 'r')); return false; }
    catch (error) { return (error as NodeJS.ErrnoException)?.code !== 'ENOENT'; }
  },
  close(fd: number): void { closeSync(fd); },
};
/** home → the hold this process has: its descriptor and how to close it. */
const holds = new Map<string, { fd: number, close: (fd: number) => void }>();

/**
 * True while the lock's owner runs: same boot, its pid exists, and on Windows, when the lock
 * names a hold, that hold is still open. A lock without `hold` (an older alpd) is judged by its
 * pid alone.
 */
export function lockAlive(lock: LiveLock | null | undefined, { platform = process.platform, taken = holdOps.taken }: { platform?: NodeJS.Platform, taken?: (file: string) => boolean } = {}): boolean {
  if (!lock || !Number.isSafeInteger(lock.pid) || !isSameBoot(lock)) return false;
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') return false;
  }
  if (platform === 'win32' && typeof lock.hold === 'string') return taken(lock.hold);
  return true;
}

/**
 * Takes alpd's single-instance lock for `home`: exclusive create; a lock whose pid or boot is
 * gone is stale and replaced. alpd takes it to run; `alp backup` and `alp restore` take it with
 * `maintenance` set, so no alpd starts on data they read or replace (ALPD §68).
 */
export async function acquireDaemonLock(home: string, contents: DaemonLockContents, { platform = process.platform, ops = holdOps }: { platform?: NodeJS.Platform, ops?: HoldOps } = {}): Promise<DaemonLock> {
  const { lock: file, hold } = daemonPaths(home);
  const busy = (current: DaemonLock) => new Error(current.maintenance ? `ALP is busy: alp ${current.maintenance} runs (pid ${current.pid}); try again when it finishes` : `ALP daemon already running (pid ${current.pid})`);
  // On Windows the hold comes first: whoever has it is the only one that may write the lock.
  let fd: number | undefined;
  if (platform === 'win32' && !holds.has(home)) {
    try { fd = ops.take(hold); }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code!)) throw error;
      const current = await readLock(home);
      if (lockAlive(current, { platform, taken: ops.taken })) throw busy(current!);
      throw new Error(`ALP daemon lock ${file} is held: another start is in progress. Try again when it finishes`);
    }
    // The hold counts only if a second open really fails; else go on by pid alone, unmarked.
    if (!ops.taken(hold)) { ops.close(fd!); fd = undefined; }
  }
  try {
    const lock = await takeLockFile(home, file, contents, fd === undefined ? undefined : hold, platform, ops, busy);
    if (fd !== undefined) holds.set(home, { fd, close: ops.close });
    return lock;
  } catch (error) {
    if (fd !== undefined) { try { ops.close(fd); } catch {} }
    throw error;
  }
}

/** Our own hold, named by `current`: its owner is gone, since we could take it. */
function ownHold(current: { hold?: unknown } | undefined, hold: string | undefined, platform: NodeJS.Platform): boolean {
  if (!hold || typeof current?.hold !== 'string') return false;
  const a = path.resolve(current!.hold as string), b = path.resolve(hold);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function takeLockFile(home: string, file: string, contents: DaemonLockContents, hold: string | undefined, platform: NodeJS.Platform, ops: HoldOps, busy: (current: DaemonLock) => Error): Promise<DaemonLock> {
  const currentBootId = bootId();
  const lock: DaemonLock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    startedUptime: Math.floor(os.uptime()),
    bootTime: bootTime(),
    ...(currentBootId ? { bootId: currentBootId } : {}),
    uid: process.getuid?.() ?? -1,
    ready: false,
    ...contents,
    ...(hold ? { hold } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      // The identity of the file this call created, taken before anything can fail on it.
      let ours: Stats | undefined;
      try {
        ours = await handle.stat();
        await handle.writeFile(JSON.stringify(lock));
      } catch (error) {
        // Recover the descriptor identity if async fstat failed. Never infer ownership from
        // the pathname: another process may already have replaced it. If both stats fail,
        // leave the unreadable lock for explicit recovery rather than unlinking a successor.
        if (!ours) { try { ours = fstatSync(handle.fd); } catch {} }
        await handle.close().catch(() => {});
        const there = await lstat(file).catch(() => undefined);
        if (ours && there && ours.ino === there.ino && ours.dev === there.dev) await unlink(file).catch(() => {});
        throw error;
      }
      await handle.close();
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      const current = await readLock(home);
      const alive = (candidate: DaemonLock | undefined) => !ownHold(candidate, hold, platform) && lockAlive(candidate, { platform, taken: ops.taken });
      if (alive(current)) throw busy(current!);
      // Remove the stale lock only if nobody replaced it meanwhile. A lock that cannot be read may
      // be one another start is writing now: it stays, and this start says so.
      const again = await readFile(file, 'utf8').catch(() => undefined);
      let parsed;
      try { parsed = again === undefined ? undefined : JSON.parse(again); }
      catch { throw new Error(`ALP daemon lock ${file} cannot be read: another start may be writing it. If no alpd or alp command is starting, remove it and try again`); }
      if (again === undefined || JSON.stringify(current) === again || !alive(parsed)) await unlink(file).catch(() => {});
    }
  }
  throw new Error('Could not acquire the ALP daemon lock');
}

/** Lets go of alpd's lock if this process holds it. */
export async function releaseDaemonLock(home: string): Promise<void> {
  const current = await readLock(home).catch(() => undefined);
  // The lock goes first, then the hold, in one tick: no start sees our lock with the hold free
  // and no one else's lock is removed.
  if (current?.pid === process.pid) { try { unlinkSync(daemonPaths(home).lock); } catch {} }
  const held = holds.get(home);
  if (held) { holds.delete(home); try { held.close(held.fd); } catch {} }
}
