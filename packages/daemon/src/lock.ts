import { unlink, utimes, writeFile, rename } from 'node:fs/promises';
import { acquireDaemonLock, daemonPaths, readLock } from '@anhlp/alp-client/index';

export type LockContents = {
  pid: number;
  startedAt: string;
  bootTime: number;
  uid: number;
  version: string;
  protocolVersion: number;
  socket: string;
  ready: boolean;
};

/** Single-instance lock (Paseo acquirePidLock, simplified): exclusive create, stale when its pid or boot is gone. */
export async function acquireLock(home: string, contents: Omit<LockContents, 'pid' | 'startedAt' | 'bootTime' | 'uid' | 'ready'>): Promise<LockContents> {
  return acquireDaemonLock(home, contents) as Promise<LockContents>;
}

/**
 * Moves `temporary` over `file`. On Windows the move fails with EPERM, EACCES or EBUSY while
 * another process has `file` open, such as a client reading the lock; it is tried again then.
 */
export async function replaceFile(temporary: string, file: string) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(temporary, file); }
    catch (error: any) {
      if (process.platform !== 'win32' || attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 + attempt * 10));
    }
  }
}

export async function updateLock(home: string, lock: LockContents) {
  const file = daemonPaths(home).lock;
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(lock), { mode: 0o600 });
  await replaceFile(temporary, file);
}

/** True while this process still owns the lock; refreshes its mtime as a heartbeat. */
export async function heartbeat(home: string) {
  const current = await readLock(home);
  if (current?.pid !== process.pid) return false;
  const now = new Date();
  await utimes(daemonPaths(home).lock, now, now).catch(() => {});
  return true;
}

export async function releaseLock(home: string) {
  const current = await readLock(home);
  if (current?.pid === process.pid) await unlink(daemonPaths(home).lock).catch(() => {});
}
