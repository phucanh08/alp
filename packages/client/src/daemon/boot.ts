import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

let cachedBootId: string | undefined | null = null;

/**
 * Returns a stable identifier for the current OS boot session,
 * or undefined if unavailable on the platform or inaccessible.
 *
 * On Linux, reads /proc/sys/kernel/random/boot_id.
 * On Darwin (macOS), queries sysctl kern.bootsessionuuid.
 */
export function bootId(): string | undefined {
  if (cachedBootId !== null) return cachedBootId;
  try {
    if (process.platform === 'linux') {
      const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (id.length > 0) {
        cachedBootId = id;
        return cachedBootId;
      }
    } else if (process.platform === 'darwin') {
      const id = execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim();
      if (id.length > 0) {
        cachedBootId = id;
        return cachedBootId;
      }
    }
  } catch {
    // Platform lacks boot id or procfs/sysctl is restricted; fall back gracefully.
  }
  cachedBootId = undefined;
  return cachedBootId;
}

/** Internal/testing seam: resets or sets the cached boot identifier. */
export function _setBootIdForTest(id: string | undefined | null = null): void {
  cachedBootId = id;
}

/** Wall-clock boot time; a lock from an earlier boot is stale even if its pid is reused. */
export function bootTime(): number {
  return Math.round((Date.now() - os.uptime() * 1000) / 1000);
}

/**
 * Evaluates whether a lock record belongs to the current boot session.
 *
 * When both the lock and the current environment supply a bootId (Linux
 * /proc/sys/kernel/random/boot_id or macOS kern.bootsessionuuid), identity is
 * determined by exact bootId match, which is immune to wall-clock jumps.
 *
 * For legacy locks or environments without a bootId, falls back to checking
 * whether wall-clock bootTime is within a 30-second window.
 */
export function isSameBoot(lock?: { bootId?: string, bootTime?: number } | null, { bootId: curBootId = bootId(), bootTime: curBootTime = bootTime() }: { bootId?: string, bootTime?: number } = {}): boolean {
  if (!lock) return false;
  if (typeof lock.bootId === 'string' && lock.bootId.length > 0 && typeof curBootId === 'string' && curBootId.length > 0) {
    return lock.bootId === curBootId;
  }
  if (typeof lock.bootTime === 'number' && Number.isFinite(lock.bootTime) && Number.isFinite(curBootTime)) {
    return Math.abs(lock.bootTime - curBootTime) <= 30;
  }
  return false;
}

/**
 * When the OS says `pid` started, as a letter and digits that stay the same for the life of that
 * process, or undefined where it cannot tell (Windows, a sandbox, a process that is gone). Linux
 * reads the start tick in /proc/<pid>/stat ("c…"); other Unix systems ask ps ("b…"), in UTC and
 * the C locale so that two callers agree whatever their own environment says. ps counts whole
 * seconds: a pid cannot come back within the second its last owner started in.
 */
export function processBirth(pid: number, { platform = process.platform }: { platform?: NodeJS.Platform } = {}): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || platform === 'win32') return undefined;
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The command name may hold spaces and brackets: count fields after its closing one.
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return /^\d+$/.test(ticks) ? `c${ticks}` : undefined;
    }
    const text = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    // "Tue Nov 24 04:00:02 2026"
    const match = /^\w+ +(\w{3}) +(\d{1,2}) +(\d\d):(\d\d):(\d\d) +(\d{4})\s*$/.exec(text);
    const month = match ? 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(match[1]) / 3 : -1;
    if (!match || !Number.isInteger(month) || month < 0) return undefined;
    return `b${match[6]}${String(month + 1).padStart(2, '0')}${match[2].padStart(2, '0')}${match[3]}${match[4]}${match[5]}`;
  } catch {
    return undefined;
  }
}
