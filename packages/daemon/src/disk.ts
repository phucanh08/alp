import { statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Errors that mean alpd cannot write its home now: the disk is full, a quota is used up, or it became read-only. */
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS']);

/** Whether `error` (or the error it wraps) says the disk cannot take writes. */
export function isDiskError(error: unknown): boolean {
  for (let current: any = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (typeof current.code === 'string' && DISK_CODES.has(current.code)) return true;
  }
  return false;
}

export const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export type DiskRuntime = {
  holdForDisk(reason: string): unknown;
  releaseDisk(by: string): unknown;
  diskHeld(): boolean;
  diskLow(free: string): void;
};

export type DiskGuardOptions = {
  /** The directory whose disk alpd writes: ALP_HOME. */
  home: string;
  runtime: DiskRuntime;
  log: { warn(message: string, fields?: Record<string, unknown>): void; info(message: string, fields?: Record<string, unknown>): void };
  /** How often space is checked; ALP checks every minute. */
  intervalMs?: number;
  /** Below this, alpd warns once that space runs low (2 GiB). */
  lowBytes?: number;
  /** Below this, alpd holds work before writes fail (100 MiB). */
  criticalBytes?: number;
  /** Free space alpd needs to resume work it held (256 MiB); above criticalBytes, so it does not flap. */
  resumeBytes?: number;
  /** How long one statfs or probe may take (10 s). */
  checkTimeoutMs?: number;
  /** Free bytes on the disk of a directory; undefined when unknown. */
  free?: (directory: string) => Promise<number | undefined>;
  /** Writes and removes a small file; rejects when the disk takes no writes. */
  probe?: (directory: string) => Promise<void>;
};

async function freeBytes(directory: string) {
  try {
    const info = await statfs(directory);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return undefined;
  }
}

async function probeWrite(directory: string) {
  const file = path.join(directory, `.alpd-disk-probe-${process.pid}`);
  try { await writeFile(file, 'x'.repeat(4096), { mode: 0o600 }); }
  finally { await unlink(file).catch(() => {}); }
}

export function formatBytes(bytes: number) {
  return bytes >= GiB ? `${(bytes / GiB).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / MiB))} MB`;
}

/**
 * Keeps alpd running when its disk fills (t-2831): a write failing with ENOSPC, EDQUOT or
 * EROFS pauses all of ALP and parks running assignments (as a usage limit does), instead of
 * stopping alpd. Reads go on. Every minute alpd checks free space and probes a write; when
 * the disk takes writes again it lifts the pause it made and parked work continues. A pause
 * the user made, and their alp resume, stay theirs. alpd deletes nothing to make room.
 */
export function createDiskGuard(options: DiskGuardOptions) {
  const { home, runtime, log } = options;
  const lowBytes = options.lowBytes ?? 2 * GiB;
  const criticalBytes = options.criticalBytes ?? 100 * MiB;
  const resumeBytes = Math.max(options.resumeBytes ?? 256 * MiB, criticalBytes);
  const free = options.free ?? freeBytes;
  const probe = options.probe ?? probeWrite;
  let warnedLow = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking: Promise<void> | undefined;
  let last: { at: string; free?: number; writable: boolean } | undefined;
  /** Set from the first disk error until space returns: a log line about it, itself failing, must not hold again (and recurse). */
  let full = false;
  /** Checks in a row that found the disk writable; two are needed to resume, so a borderline disk does not flap. */
  let good = 0;

  function hold(reason: string) {
    good = 0;
    if (full && runtime.diskHeld()) return;
    const first = !full;
    full = true;
    // Hold first: the log line below may fail on this disk and report again, which now returns at once.
    runtime.holdForDisk(reason);
    if (first) log.warn(`${reason}; ALP pauses its work until the disk takes writes again`, { code: 'ALP_DISK_FULL' });
  }

  /** A write failed; returns whether it was a disk error that alpd now handles. */
  function report(error: unknown) {
    if (!isDiskError(error)) return false;
    const code = (error as any)?.code ?? (error as any)?.cause?.code;
    hold(code === 'EROFS' ? 'the disk is read-only' : 'the disk is full');
    return true;
  }

  async function checkOnce() {
    const bytes = await bounded(free(home), undefined);
    const writable = await bounded(probe(home).then(() => true, error => isDiskError(error) ? false : true), !full);
    last = { at: new Date().toISOString(), ...(bytes === undefined ? {} : { free: bytes }), writable };
    const shown = bytes === undefined ? 'unknown' : formatBytes(bytes);
    if (full) {
      if (!writable || (bytes !== undefined && bytes < resumeBytes)) { good = 0; if (!runtime.diskHeld()) runtime.holdForDisk(writable ? `the disk is almost full (${shown} free)` : 'the disk is full'); return; }
      if (++good < 2) return;
      full = false;
      good = 0;
      warnedLow = false;
      // Release first: a log line failing on a disk that filled again holds again, rightly.
      runtime.releaseDisk('alpd, after disk space returned');
      log.info(`the disk takes writes again (${shown} free); ALP resumes its work`, { code: 'ALP_DISK_BACK', free: bytes });
      return;
    }
    if (!writable) { hold('the disk is full'); return; }
    if (bytes !== undefined && bytes < criticalBytes) { hold(`the disk is almost full (${shown} free)`); return; }
    if (bytes !== undefined && bytes < lowBytes) {
      if (!warnedLow) { warnedLow = true; log.warn(`disk space is low: ${shown} free`, { code: 'ALP_DISK_LOW', free: bytes }); runtime.diskLow(shown); }
    } else if (bytes !== undefined && bytes >= lowBytes * 1.25) warnedLow = false;
  }

  /** A statfs or probe that hangs (a stuck network disk) gives `fallback` after 10 s, so checks go on. */
  function bounded<T>(work: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), options.checkTimeoutMs ?? 10_000); timer.unref?.(); });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  /** Checks space now; concurrent calls share one check. */
  function check() {
    checking ??= checkOnce().catch(() => {}).finally(() => { checking = undefined; });
    return checking;
  }

  return {
    report,
    check,
    status: () => ({ held: runtime.diskHeld(), full, ...(last ? { last } : {}) }),
    start() {
      if (timer) return;
      timer = setInterval(() => void check(), options.intervalMs ?? 60_000);
      timer.unref?.();
      void check();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
  };
}

/**
 * Makes process.stdout and stderr survive a full disk when they are files (alpd's log, as the
 * detached launcher opens it): a failed write is dropped, not thrown later as an 'error' event
 * that would end alpd, and logging continues once space returns. Other streams (a terminal,
 * a pipe) keep Node's own writes but no longer turn a write error into a crash.
 */
export function guardOutput(onError: (error: unknown) => void, fs: { fstatSync(fd: number): { isFile(): boolean }; writeSync(fd: number, data: string | Uint8Array): number }) {
  for (const [stream, fd] of [[process.stdout, 1], [process.stderr, 2]] as const) {
    stream.on('error', onError);
    let file = false;
    try { file = fs.fstatSync(fd).isFile(); } catch {}
    if (!file) continue;
    stream.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
      try { fs.writeSync(fd, chunk); } catch (error) { onError(error); }
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') done();
      return true;
    }) as typeof stream.write;
  }
}
