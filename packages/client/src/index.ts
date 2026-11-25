import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, unlinkSync, constants as fsConstants } from 'node:fs';
import { open, readFile, writeFile, realpath, stat, lstat, mkdir, readlink, unlink, readdir, chmod, rename, rmdir, link } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { scrubText } from '@anhlp/alp-core/log';
import { entryCommand, isNativeDaemonName, NATIVE_DAEMON } from '@anhlp/alp-core/packaged';
import { dashboardSettings } from '@anhlp/alp-core/user-settings';
import { createSocketTransport } from './connection/ipc.js';
import { AlpRpcClient } from './rpc/client.js';
import { hello } from './rpc/connection/handshake.js';
import type { Stats } from 'node:fs';
import type { Socket } from 'node:net';
import type { AttachmentLimits, TerminalLimits } from '@anhlp/alp-protocol';
export { PROTOCOL_VERSION, MAX_FRAME, AlpRpcError, encodeFrame } from '@anhlp/alp-protocol';
// The Node entry carries the whole portable API and the WebSocket transport too, so Node callers need one import.
export * from './portable.js';
export { connectWebSocket, createWebSocketTransport, redactUrl, CLOSE_CODE } from './connection/websocket.js';
export { createSocketTransport } from './connection/ipc.js';

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
/** One start or stop of alpd in its lifecycle directory, read from its owner token. */
export type LifecycleOwner = { token: string, pid: number, bootTime: number, action: string, id?: string, proof?: string };
/** The options of the socket transport (maxFrame, maxBufferedBytes). */
export type SocketTransportOptions = NonNullable<Parameters<typeof createSocketTransport>[1]>;
/** The options of AlpClient and connect: the RPC client's and the socket transport's. */
export type AlpClientOptions = NonNullable<ConstructorParameters<typeof AlpRpcClient>[1]> & SocketTransportOptions;

export function alpHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.ALP_HOME || path.join(os.homedir(), '.alp'));
}

/** Windows uses named pipes; long Unix homes get a short socket in the temp directory. */
export function daemonPaths(home: string) {
  const preferred = path.join(home, 'alpd.sock');
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\alpd-${createHash('sha256').update(home).digest('hex').slice(0, 24)}`
    : Buffer.byteLength(preferred) < 100
    ? preferred
    : path.join(os.tmpdir(), `alpd-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`, 'rpc.sock');
  return { home, lock: path.join(home, 'alpd.lock'), hold: path.join(home, 'alpd.lock.held'), socket, log: path.join(home, 'logs', 'alpd.log'), install: path.join(home, 'alpd.json') };
}

/** IPC trusts the OS user, not every local process. Existing unsafe directories fail closed.
 * Windows mode bits do not describe named-pipe ACLs; those remain an OS deployment assumption. */
async function assertSafeAncestors(directory: string) {
  if (process.platform === 'win32') return;
  const absolute = path.isAbsolute(directory) ? directory : `${process.cwd()}/${directory}`;
  let current = path.parse(absolute).root;
  const pending = absolute.slice(current.length).split('/');
  let links = 0;
  // Follow every link expansion, including intermediate targets that realpath hides.
  // Check a directory before entering it; never create beneath an unsafe parent.
  while (pending.length) {
    const part = pending.shift();
    if (!part || part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    const candidate = path.join(current, part);
    const info = await lstat(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info) { current = candidate; continue; }
    const trustedOwner = info.uid === 0 || info.uid === process.getuid?.();
    if (!trustedOwner) throw new Error('IPC requires ancestors owned by the current user or root');
    if (info.isSymbolicLink()) {
      if (++links > 40) throw new Error('IPC ancestor symlink loop');
      const target = await readlink(candidate);
      if (path.isAbsolute(target)) current = path.parse(target).root;
      pending.unshift(...target.slice(path.isAbsolute(target) ? path.parse(target).root.length : 0).split('/'));
      continue;
    }
    // Sticky shared temp directories prevent users replacing each other's entries.
    if (!info.isDirectory() || ((info.mode & 0o022) && !(info.mode & 0o1000))) {
      throw new Error('IPC requires trusted ancestors without shared write permissions');
    }
    current = candidate;
  }
}

export async function assertPrivateDirectory(directory: string, { create = false }: { create?: boolean } = {}): Promise<void> {
  await assertSafeAncestors(directory);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('IPC requires a private directory, not a symlink');
  if (process.platform === 'win32') return;
  const shown = JSON.stringify(directory);
  const mine = (entry: Stats) => entry.isDirectory() && !entry.isSymbolicLink() && entry.uid === process.getuid?.();
  if (info.uid !== process.getuid?.()) throw new Error(`IPC directory ${shown} must be owned by the current user (it belongs to uid ${info.uid}); use a directory of your own`);
  if ((info.mode & 0o077) === 0) return;
  // t-37f1: a directory the user made for ALP (mkdir, mktemp) and left at 0755 is still empty:
  // ALP tightens it. One that holds anything is left alone, with the exact command to fix it.
  if (create && (await readdir(directory)).length === 0) {
    await chmod(directory, 0o700).catch(() => {});
  }
  // Re-read: another ALP process may have tightened it meanwhile (and filled it).
  info = await lstat(directory);
  if (mine(info) && (info.mode & 0o077) === 0) return;
  // Single quotes, so the command is safe to paste into a POSIX shell.
  const quoted = `'${directory.replaceAll("'", "'\\''")}'`;
  throw new Error(`IPC directory ${shown} must have private permissions (0700), not ${(info.mode & 0o777).toString(8).padStart(4, '0')}; fix it with: chmod 700 ${quoted}`);
}

export async function assertPrivateSocket(socketPath: string): Promise<Stats | undefined> {
  if (process.platform === 'win32') return;
  await assertPrivateDirectory(path.dirname(socketPath));
  const info = await lstat(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error('IPC socket must be owned by the current user with private permissions (0600)');
  }
  return info;
}

const isFile = (file: string) => stat(file).then(info => info.isFile(), () => false);

/** Global bin directories that a GUI app's PATH may lack. */
const BIN_DIRECTORIES = [path.join(os.homedir(), '.alp', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

/** The npm package that ships the `alp` command and alpd. */
const CLI_PACKAGES = ['@anhlp/alp', '@anhlp/alp-cli'];

/**
 * alpd behind an `alp` found on PATH (its real path), or undefined: the ALP bundle's launcher
 * (<bundle>/bin/alp or alp.cmd, t-1807; its native alpd when it ships one, t-81b0.9, else its alpd.js), npm's @anhlp/alp-cli (dist/cli.js) or the @anhlp/alp wrapper (bin/alp.js),
 * which depends on @anhlp/alp-cli (installed beside it, or in its own node_modules). On Windows an
 * alp.cmd shim of npm or install.ps1 is followed to the script it runs (t-1f14).
 * @param {string} cli @param {number} [depth] @param {NodeJS.ProcessEnv} [env]
 */
async function cliDaemonEntry(cli: string, depth = 0, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const base = path.basename(cli).toLowerCase();
  const root = path.resolve(path.dirname(cli), '..');
  const alpd = (directory: string) => path.join(directory, 'dist', 'alpd.js');
  const named = async (directory: string) => readFile(path.join(directory, 'package.json'), 'utf8').then(text => JSON.parse(text)?.name).catch(() => undefined);
  let candidates: string[] = [];
  if (base === 'alp.cmd' && depth < 1 && !await isFile(path.join(root, 'alp-bundle.json'))) {
    // A Windows shim that is not the bundle's own: npm's ("%dp0%\node_modules\@anhlp\alp\bin\alp.js")
    // or install.ps1's ("<root>\app\current\lib\node_modules\@anhlp\alp-cli\dist\cli.js"): follow the script it runs.
    const text = await stat(cli).then(info => info.size <= 64 * 1024 ? readFile(cli, 'utf8') : '', () => '');
    for (const [, quoted] of text.matchAll(/"([^"\r\n]+\.js)"/gi)) {
      const script = quoted.replace(/^%~?dp0%?[\\/]?/i, `${path.dirname(cli)}${path.sep}`);
      const entry = path.isAbsolute(script) && await isFile(script) ? await cliDaemonEntry(script, depth + 1, env) : undefined;
      if (entry) return entry;
    }
    return undefined;
  }
  if (base === 'alp' || base === 'alp.cmd') {
    // A bundle: bin/ beside alp-bundle.json; name alpd through app/current when that is this bundle.
    if (!await isFile(path.join(root, 'alp-bundle.json'))) return undefined;
    const current = path.join(path.dirname(root), 'current');
    const viaCurrent = await realpath(current).then(real => real === root, () => false);
    const bundle = viaCurrent ? current : root;
    // The native alpd first (t-81b0.9), as the bundle's own `alp` starts it; alpd.js where it ships none.
    candidates = [...(env.ALP_NATIVE_DAEMON === '0' ? [] : [path.join(bundle, 'bin', NATIVE_DAEMON)]), alpd(path.join(bundle, 'lib', 'node_modules', '@anhlp', 'alp-cli'))];
  } else if (base === 'cli.js' && CLI_PACKAGES.includes(await named(root))) {
    candidates = [alpd(root)];
  } else if (base === 'alp.js' && await named(root) === '@anhlp/alp') {
    candidates = [alpd(path.join(root, 'node_modules', '@anhlp', 'alp-cli')), alpd(path.join(root, '..', 'alp-cli'))];
  }
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return undefined;
}

/**
 * Finds alpd.js for a client that cannot locate it beside itself, such as the Paseo
 * plugin, which Paseo re-bundles: the first existing candidate, then where alpd last
 * recorded itself ($ALP_HOME/alpd.json), then the ALP CLI (`alp`) on PATH and in the usual install
 * directories (`binDirectories`; a test passes [] so the caller's own install is not found).
 */
export async function findDaemonEntry({ home = alpHome(), env = process.env, candidates = /** @type {Array<string | undefined>} */ ([]), binDirectories = BIN_DIRECTORIES }: { home?: string, env?: NodeJS.ProcessEnv, candidates?: Array<string | undefined>, binDirectories?: string[] } = {}): Promise<string | undefined> {
  for (const candidate of candidates) if (candidate && await isFile(candidate)) return candidate;
  try {
    const { entry } = JSON.parse(await readFile(daemonPaths(home).install, 'utf8'));
    if (typeof entry === 'string' && await isFile(entry)) return entry;
  } catch {}
  for (const directory of [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...binDirectories]) {
    for (const name of process.platform === 'win32' ? ['alp.cmd', 'alp'] : ['alp']) {
      const cli = await realpath(path.join(directory, name)).catch(() => undefined);
      const entry = cli && await cliDaemonEntry(cli, 0, env);
      if (entry) return entry;
    }
  }
  return undefined;
}

/**
 * Integration names are single lowercase path segments: they name `<home>/integrations/<name>.lock`,
 * its guard and `<home>/<name>.json`. Returns the name, or throws a TypeError.
 * @param {unknown} name
 * @returns {string}
 */
export function assertIntegrationName(name: unknown): string {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new TypeError(`Invalid integration name: ${JSON.stringify(name)}`);
  return name;
}

let cachedBootId: string | undefined | null = null;

/**
 * Returns a stable identifier for the current OS boot session,
 * or undefined if unavailable on the platform or inaccessible.
 *
 * On Linux, reads /proc/sys/kernel/random/boot_id.
 * On Darwin (macOS), queries sysctl kern.bootsessionuuid.
 *
 * @returns {string | undefined}
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

/**
 * Internal/testing seam: resets or sets the cached boot identifier.
 * @param {string | undefined | null} [id]
 */
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
 *
 * @param {{ bootId?: string, bootTime?: number }} [lock]
 * @param {{ bootId?: string, bootTime?: number }} [current]
 * @returns {boolean}
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
 * @param {string} home
 * @param {{ version: string, protocolVersion: number, socket: string, maintenance?: string }} contents
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

/**
 * One JSON-RPC 2.0 connection to alpd over a Unix socket or named pipe; events arrive as `event`
 * notifications. The engine is the portable AlpRpcClient; this keeps the socket constructor the
 * CLI, alpd's tests and the Paseo plugin use.
 */
export class AlpClient extends AlpRpcClient {
  /** Host features captured by connect's handshake. @type {readonly string[]} */
  capabilities: readonly string[] = [];
  /** Limits captured by connect's handshake. @type {import('@anhlp/alp-protocol').AttachmentLimits | undefined} */
  attachmentLimits: AttachmentLimits | undefined;
  /** @type {{ readonly maxCount: number; readonly maxBytes: number; readonly maxTotalBytes: number } | undefined} */
  promptImageLimits: { readonly maxCount: number; readonly maxBytes: number; readonly maxTotalBytes: number } | undefined;
  /** @type {import('@anhlp/alp-protocol').TerminalLimits | undefined} */
  terminalLimits: TerminalLimits | undefined;
  /**
   * @param {import('node:net').Socket} socket a connected or connecting socket; the client owns it
   * @param {import('./rpc/client.js').AlpRpcClientOptions & import('./connection/ipc.js').SocketTransportOptions} [options]
   */
  constructor(socket: Socket, { maxFrame, maxBufferedBytes, ...options }: AlpClientOptions = {}) {
    super(createSocketTransport(socket, { maxFrame, maxBufferedBytes }), { maxFrame, ...options });
  }
}

/** A socket to alpd, once it is checked to be private to this user (the IPC checks above). @param {string} socketPath */
async function openSocket(socketPath: string): Promise<Socket> {
  await assertPrivateSocket(socketPath);
  return /** @type {Promise<import('node:net').Socket>} */ (new Promise((resolve, reject) => {
    const candidate = net.createConnection(socketPath);
    candidate.once('connect', () => { candidate.off('error', reject); resolve(candidate); });
    candidate.once('error', reject);
  }));
}

/**
 * The transport to alpd's socket without the handshake, for an AlpRpcClient or a reconnecting
 * client whose onConnect runs `hello`. `connect` is this plus `hello`.
 * @param {string} socketPath
 * @param {import('./connection/ipc.js').SocketTransportOptions} [options]
 */
export async function connectSocket(socketPath: string, options?: SocketTransportOptions) {
  return createSocketTransport(await openSocket(socketPath), options);
}

/**
 * Connects and performs the version handshake.
 * @param {string} socketPath
 * @param {{ name: string, version: string }} [client]
 * @param {import('./rpc/client.js').AlpRpcClientOptions & import('./connection/ipc.js').SocketTransportOptions} [options]
 * @returns {Promise<AlpClient>}
 */
export async function connect(socketPath: string, client: { name: string, version: string } = { name: 'alp', version: '0' }, options: AlpClientOptions = {}): Promise<AlpClient> {
  const connection = new AlpClient(await openSocket(socketPath), options);
  try {
    const greeting = await hello(connection, client, undefined, { agent: typeof process.env.ALP_AGENT_SESSION === 'string' && process.env.ALP_AGENT_SESSION !== '' });
    connection.capabilities = Object.freeze(Array.isArray(greeting.capabilities) ? greeting.capabilities.filter((value: unknown): value is string => typeof value === 'string') : []);
    if (greeting.attachmentLimits && typeof greeting.attachmentLimits === 'object') {
      connection.attachmentLimits = Object.freeze({ ...greeting.attachmentLimits }) as AttachmentLimits;
    }
    if (greeting.promptImageLimits && typeof greeting.promptImageLimits === 'object') {
      connection.promptImageLimits = Object.freeze({ ...greeting.promptImageLimits }) as { readonly maxCount: number; readonly maxBytes: number; readonly maxTotalBytes: number };
    }
    if (greeting.terminalLimits && typeof greeting.terminalLimits === 'object') {
      connection.terminalLimits = Object.freeze({ ...greeting.terminalLimits }) as TerminalLimits;
    }
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

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
 * @param {NodeJS.ProcessEnv} [env]
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
export async function withDaemonLifecycle<T>(home: string, action: 'start' | 'stop', run: () => T | Promise<T>, { joinStart = false, signal = /** @type {AbortSignal | undefined} */ (undefined), waitMs = daemonLifecycleWaitMs(), platform = process.platform, ops = holdOps }: { joinStart?: boolean, signal?: AbortSignal, waitMs?: number, platform?: NodeJS.Platform, ops?: HoldOps } = {}): Promise<T> {
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
 * @param {NodeJS.ProcessEnv} [env]
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
export async function ensureDaemon({ home = alpHome(), entry = /** @type {string | undefined} */ (undefined), env = process.env, execPath = process.execPath, timeoutMs = daemonStartTimeoutMs(env), lifecycleLocked = false, signal = /** @type {AbortSignal | undefined} */ (undefined) }: { home?: string, entry?: string, env?: NodeJS.ProcessEnv, execPath?: string, timeoutMs?: number, lifecycleLocked?: boolean, signal?: AbortSignal } = {}): Promise<string> {
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

/** Registration descriptor field names, in priority order. */
const INTEGRATION_DESCRIPTOR_FIELDS = ['main', 'entry', 'path', 'command'];

async function readIntegrationDescriptor(file: string, baseDirs: string[] = []): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    for (const field of INTEGRATION_DESCRIPTOR_FIELDS) {
      const value = raw?.[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      if (path.isAbsolute(value)) {
        if (await isFile(value)) return value;
      } else {
        const bases = [path.dirname(file), ...baseDirs];
        for (const base of bases) {
          const resolved = path.resolve(base, value);
          if (await isFile(resolved)) return resolved;
        }
      }
    }
  } catch {}
  return undefined;
}

async function integrationCandidateFromHome(home: string, name: string): Promise<string | undefined> {
  const descriptors = [
    path.join(home, 'integrations', `${name}.json`),
    path.join(home, 'integrations', name, 'integration.json'),
  ];
  for (const descriptor of descriptors) {
    const entry = await readIntegrationDescriptor(descriptor, [home]);
    if (entry) return entry;
  }
  // Legacy single-file registration.
  const legacy = path.join(home, 'integrations', name, 'main.js');
  return (await isFile(legacy)) ? legacy : undefined;
}

function integrationBinaryName(name: string): string {
  return `alp-${name}-integration`;
}

/** Distribution roots that may carry a bundled integration descriptor. */
async function distributionRoots() {
  const roots: string[] = [];
  const argv = process.argv[1] ? await realpath(process.argv[1]).catch(() => process.argv[1]) : undefined;
  if (argv) {
    // The CLI runs from <distribution>/packages/cli/dist, so the distribution root is a few levels
    // up. Resolve the real path first so a symlinked global bin still finds its own root.
    let directory = path.dirname(argv);
    for (let depth = 0; depth < 4; depth += 1) { roots.push(path.resolve(directory, '..')); directory = path.resolve(directory, '..'); }
    // Every package ancestor may carry a bundled descriptor (a full distribution, or the plugin
    // package installed next to it).
    for (let ancestor = path.dirname(argv); ; ancestor = path.dirname(ancestor)) {
      if (await isFile(path.join(ancestor, 'package.json'))) roots.push(ancestor);
      if (path.dirname(ancestor) === ancestor) break;
    }
  }
  // Also consider the current working directory for full distributions.
  roots.push(process.cwd());
  return [...new Set(roots)];
}

/**
 * The entry of integration `name`: an environment override, a descriptor under the home or a
 * distribution root, or an `alp-<name>-integration` binary. Discovery never returns an entry for
 * `dashboard`: that is alp dashboard's service, which ships with the CLI and is started with its
 * explicit entry; nor for `web`, its name before the rename (t-81b0.5). Everything once registered
 * under `web` (the descriptor `integrations/web.json`, the
 * `alp-web-integration` binary, `ALP_WEB_INTEGRATION`) is the Paseo integration from before its
 * rename to `paseo`, which must never run under the web lock. `ALP_WEB_INTEGRATION` is read for
 * `paseo` only, after `ALP_PASEO_INTEGRATION`, for one release (like the alp-web-integration alias).
 * @param {string} [name]
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, binDirectories?: string[], roots?: string[] }} [options]
 */
export async function discoverIntegration(name: string = 'dashboard', options: { home?: string, env?: NodeJS.ProcessEnv, binDirectories?: string[], roots?: string[] } = {}): Promise<string | undefined> {
  // The name becomes a descriptor path under <home>/integrations, so it must stay one safe segment.
  assertIntegrationName(name);
  if (name === 'dashboard' || name === 'web') return undefined;
  const { env = process.env, binDirectories = BIN_DIRECTORIES, roots } = options;
  // Explicit environment override always wins: the integration's own, then the generic one.
  const envCandidates = [
    env[`ALP_${name.toUpperCase()}_INTEGRATION`],
    name === 'paseo' ? env.ALP_WEB_INTEGRATION : undefined,
    env.ALP_INTEGRATION_ENTRY,
  ].filter(Boolean) as string[];
  for (const candidate of envCandidates) if (await isFile(candidate)) return candidate;

  const home = options?.home ? path.resolve(options.home) : alpHome();
  const fromHome = await integrationCandidateFromHome(home, name);
  if (fromHome) return fromHome;

  // A full distribution may describe a bundled integration relative to its own root.
  for (const root of roots ?? await distributionRoots()) {
    for (const descriptorPath of [path.join(root, 'integrations', `${name}.json`), path.join(root, 'integrations', name, 'integration.json')]) {
      const entry = await readIntegrationDescriptor(descriptorPath, [root]);
      if (entry) return entry;
    }
  }

  // Installed integration packages announce themselves on PATH.
  const binary = integrationBinaryName(name);
  for (const directory of [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...binDirectories]) {
    const candidate = await realpath(path.join(directory, binary)).catch(() => undefined);
    if (candidate && await isFile(candidate)) return candidate;
  }
  return undefined;
}

export function integrationAlive(lock: LiveLock | null | undefined): boolean {
  if (!lock || !Number.isSafeInteger(lock.pid) || !isSameBoot(lock)) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * What startIntegration says about integration `name`, and where its service writes its log: alp
 * dashboard (`dashboard`) is part of the CLI, Paseo (`paseo`) an optional package, anything else named as is.
 * @param {string} name
 * @param {string} home
 */
function integrationText(name: string, home: string) {
  const logs = path.join(home, 'logs', 'integrations');
  if (name === 'dashboard') return {
    what: 'alp dashboard',
    log: path.join(logs, 'alp-dashboard.log'),
    missing: 'alp dashboard runs the alp-dashboard service of the ALP CLI, which is started with its entry (packages/cli/dist/alp-dashboard.js); run `alp dashboard`',
  };
  if (name === 'paseo') return {
    what: 'The Paseo integration',
    log: path.join(logs, 'paseo.log'),
    missing: 'The Paseo integration is an optional integration package. Install it (for example `npm install -g @anhlp/alp-paseo@beta`), then run the command again.',
  };
  return {
    what: `ALP integration ${name}`,
    log: path.join(logs, `${name}.log`),
    missing: `ALP integration ${name} is not installed: no ALP_${name.toUpperCase()}_INTEGRATION, descriptor <home>/integrations/${name}.json or alp-${name}-integration binary was found.`,
  };
}

/**
 * Starts integration `name` (default `dashboard`) detached with `--service` (then `args`) unless its lock
 * already names a live owner, then waits until its ready lock and `<home>/<name>.json` name the same
 * pid. `entry` names the script to run with this Node and skips descriptor, environment and PATH
 * discovery; `dashboard` is never discovered, so it needs its entry. `"dashboard": { "enabled": false }`
 * in the home's settings.json (or `web.enabled`, its key before the rename) refuses `dashboard` only.
 * @param {string | { name?: string, entry?: string, home?: string, args?: string[] }} [nameOrOptions]
 */
export async function startIntegration(nameOrOptions: string | { name?: string, entry?: string, home?: string, args?: string[] } = 'dashboard') {
  const options: { name?: string, entry?: string, home?: string, args?: string[] } = typeof nameOrOptions === 'string' ? { name: nameOrOptions } : (nameOrOptions ?? {});
  const name = assertIntegrationName(options.name ?? 'dashboard');
  if (options.entry !== undefined && (typeof options.entry !== 'string' || !options.entry)) throw new TypeError('startIntegration entry must be a non-empty path');
  const args = options.args ?? [];
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new TypeError('startIntegration args must be a list of strings');
  const fs = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const home = options.home ? pathMod.resolve(options.home) : alpHome();
  const text = integrationText(name, home);
  // An explicit entry is the caller's own service script: it must exist even when a live owner is
  // reused, and it replaces descriptor, environment and PATH discovery.
  const explicit = options.entry !== undefined ? pathMod.resolve(options.entry) : undefined;
  if (explicit !== undefined && !(await isFile(explicit))) throw new Error(`${text.what}: integration entry not found: ${explicit}`);
  const lockPath = pathMod.join(home, 'integrations', `${name}.lock`);
  const webPath = pathMod.join(home, `${name}.json`);
  const started = explicit ? ` (entry ${explicit})` : '';

  // dashboard.enabled turns off alp dashboard only; other integrations have their own switches.
  if (name === 'dashboard') {
    let settings = {};
    try { settings = JSON.parse(await fs.readFile(pathMod.join(home, 'settings.json'), 'utf8')); } catch {}
    if (dashboardSettings(settings).enabled === false) throw new Error('alp dashboard is disabled by settings ("dashboard.enabled": false).');
  }

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const readLock = async () => {
    try { return JSON.parse(await fs.readFile(lockPath, 'utf8')); } catch { return undefined; }
  };
  const readWeb = async () => {
    try { return JSON.parse(await fs.readFile(webPath, 'utf8')); } catch { return undefined; }
  };

  // The authoritative check: the ready integration lock and live <name>.json must name the same pid.
  // A loser of a concurrent start accepts the winning pid after its own contender has exited or
  // the lock already names the winner.
  async function waitForReady() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const lock = await readLock();
      if (lock && integrationAlive(lock) && lock.ready) {
        const info = await readWeb();
        if (info && info.pid === lock.pid) return lock;
      }
      // alp dashboard can fail during bootstrap after the initial exit check (for example a
      // refused uncertain lock). Its service log carries the cause; do not mask it with
      // a readiness/dashboard.json timeout. Check a concurrent winner's ready lock first.
      if (name === 'dashboard' && webStartupFailed()) throw new Error(`${text.what}${started} failed to start; see ${text.log}`);
      await sleep(100);
    }
    const lock = await readLock();
    if (lock && !lock.ready) throw new Error(`${text.what}${started} started but did not become ready; see ${text.log}`);
    if (!lock) throw new Error(explicit ? `${text.what}${started} did not start; see ${text.log}` : text.missing);
    throw new Error(`${text.what}${started} did not publish a ${name}.json matching its lock; see ${text.log}`);
  }

  // Existing-owner waits have no child to observe.
  let webStartupFailed = () => false;
  const existing = await readLock();
  if (existing && integrationAlive(existing)) {
    return waitForReady();
  }

  const entry = explicit ?? await discoverIntegration(name, { home });
  if (!entry) throw new Error(text.missing);

  const { spawn } = await import('node:child_process');
  // The child is detached with its stdio ignored, so it cannot rely on the parent's console. `--service`
  // is the generic contract: the entry writes its own log (the path its error messages advertise) and
  // keeps the process alive as a service. `--register` still prints to stdout and is not passed here.
  // alp dashboard may be an `alp` command (`alp dashboard serve`); other integrations are scripts.
  const launch = name === 'dashboard' ? entryCommand(entry, 'dashboard', ['--service', ...args]) : entryCommand(entry, 'dashboard', ['--service', ...args], undefined, { scriptOnly: true });
  const child = spawn(launch.command, launch.args, { stdio: 'ignore', detached: true, env: { ...process.env, ALP_HOME: home } });
  let spawnError: Error | null = null;
  child.on('error', error => { spawnError = error; });
  let exited = false;
  child.on('exit', code => { if (code !== 0 && code !== null) exited = true; });
  child.unref();
  webStartupFailed = () => exited;

  if (spawnError) throw spawnError;
  // Give the process a moment to fail immediately on missing entry or bad permissions.
  await sleep(150);
  if (spawnError) throw spawnError;
  if (exited) throw new Error(`${text.what}${explicit ? started : ` (${entry})`} failed to start; see ${text.log}`);

  return waitForReady();
}
