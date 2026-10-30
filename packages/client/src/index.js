import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, readFile, writeFile, realpath, stat, lstat, mkdir, readlink, unlink, readdir, rename, rmdir, link } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { scrubText } from '@anhlp/alp-core/log';
import { createSocketTransport } from './ipc.js';
import { AlpRpcClient } from './rpc/client.js';
import { hello } from './rpc/handshake.js';
export { PROTOCOL_VERSION, MAX_FRAME, AlpRpcError, encodeFrame } from '@anhlp/alp-protocol';
// The Node entry carries the whole portable API and the WebSocket transport too, so Node callers need one import.
export * from './portable.js';
export { connectWebSocket, createWebSocketTransport, redactUrl, CLOSE_CODE } from './websocket.js';
export { createSocketTransport } from './ipc.js';

export function alpHome(env = process.env) {
  return path.resolve(env.ALP_HOME || path.join(os.homedir(), '.alp'));
}

/** Windows uses named pipes; long Unix homes get a short socket in the temp directory. */
export function daemonPaths(home) {
  const preferred = path.join(home, 'alpd.sock');
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\alpd-${createHash('sha256').update(home).digest('hex').slice(0, 24)}`
    : Buffer.byteLength(preferred) < 100
    ? preferred
    : path.join(os.tmpdir(), `alpd-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`, 'rpc.sock');
  return { home, lock: path.join(home, 'alpd.lock'), socket, log: path.join(home, 'logs', 'alpd.log'), install: path.join(home, 'alpd.json') };
}

/** IPC trusts the OS user, not every local process. Existing unsafe directories fail closed.
 * Windows mode bits do not describe named-pipe ACLs; those remain an OS deployment assumption. */
async function assertSafeAncestors(directory) {
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

export async function assertPrivateDirectory(directory, { create = false } = {}) {
  await assertSafeAncestors(directory);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('IPC requires a private directory, not a symlink');
  if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) {
    throw new Error('IPC directory must be owned by the current user with private permissions (0700)');
  }
}

export async function assertPrivateSocket(socketPath) {
  if (process.platform === 'win32') return;
  await assertPrivateDirectory(path.dirname(socketPath));
  const info = await lstat(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error('IPC socket must be owned by the current user with private permissions (0600)');
  }
  return info;
}

const isFile = file => stat(file).then(info => info.isFile(), () => false);

/** Global bin directories that a GUI app's PATH may lack. */
const BIN_DIRECTORIES = [path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

/** The npm package that ships the `alp` command and alpd. */
const CLI_PACKAGES = ['@anhlp/alp', '@anhlp/alp-cli'];

/**
 * Finds alpd.js for a client that cannot locate it beside itself, such as the Paseo
 * plugin, which Paseo re-bundles: the first existing candidate, then where alpd last
 * recorded itself ($ALP_HOME/alpd.json), then the ALP CLI (`alp`) on PATH.
 */
export async function findDaemonEntry({ home = alpHome(), env = process.env, candidates = /** @type {Array<string | undefined>} */ ([]) } = {}) {
  for (const candidate of candidates) if (candidate && await isFile(candidate)) return candidate;
  try {
    const { entry } = JSON.parse(await readFile(daemonPaths(home).install, 'utf8'));
    if (typeof entry === 'string' && await isFile(entry)) return entry;
  } catch {}
  for (const directory of [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...BIN_DIRECTORIES]) {
    const cli = await realpath(path.join(directory, 'alp')).catch(() => undefined);
    if (!cli || path.basename(cli) !== 'cli.js') continue;
    const root = path.resolve(path.dirname(cli), '..');
    const name = await readFile(path.join(root, 'package.json'), 'utf8').then(text => JSON.parse(text)?.name).catch(() => undefined);
    const entry = path.join(root, 'dist', 'alpd.js');
    if (CLI_PACKAGES.includes(name) && await isFile(entry)) return entry;
  }
  return undefined;
}

/**
 * Integration names are single lowercase path segments: they name `<home>/integrations/<name>.lock`,
 * its guard and `<home>/<name>.json`. Returns the name, or throws a TypeError.
 * @param {unknown} name
 * @returns {string}
 */
export function assertIntegrationName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new TypeError(`Invalid integration name: ${JSON.stringify(name)}`);
  return name;
}

let cachedBootId = null;

/**
 * Returns a stable identifier for the current OS boot session,
 * or undefined if unavailable on the platform or inaccessible.
 *
 * On Linux, reads /proc/sys/kernel/random/boot_id.
 * On Darwin (macOS), queries sysctl kern.bootsessionuuid.
 *
 * @returns {string | undefined}
 */
export function bootId() {
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
export function _setBootIdForTest(id = null) {
  cachedBootId = id;
}

/** Wall-clock boot time; a lock from an earlier boot is stale even if its pid is reused. */
export function bootTime() {
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
export function isSameBoot(lock, { bootId: curBootId = bootId(), bootTime: curBootTime = bootTime() } = {}) {
  if (!lock) return false;
  if (typeof lock.bootId === 'string' && lock.bootId.length > 0 && typeof curBootId === 'string' && curBootId.length > 0) {
    return lock.bootId === curBootId;
  }
  if (typeof lock.bootTime === 'number' && Number.isFinite(lock.bootTime) && Number.isFinite(curBootTime)) {
    return Math.abs(lock.bootTime - curBootTime) <= 30;
  }
  return false;
}

export async function readLock(home) {
  try {
    return JSON.parse(await readFile(daemonPaths(home).lock, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function lockAlive(lock) {
  if (!lock || !Number.isSafeInteger(lock.pid) || !isSameBoot(lock)) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Takes alpd's single-instance lock for `home`: exclusive create; a lock whose pid or boot is
 * gone is stale and replaced. alpd takes it to run; `alp backup` and `alp restore` take it with
 * `maintenance` set, so no alpd starts on data they read or replace (ALPD §68).
 * @param {string} home
 * @param {{ version: string, protocolVersion: number, socket: string, maintenance?: string }} contents
 */
export async function acquireDaemonLock(home, contents) {
  const file = daemonPaths(home).lock;
  const currentBootId = bootId();
  const lock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    startedUptime: Math.floor(os.uptime()),
    bootTime: bootTime(),
    ...(currentBootId ? { bootId: currentBootId } : {}),
    uid: process.getuid?.() ?? -1,
    ready: false,
    ...contents,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(lock));
      await handle.close();
      return lock;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = await readLock(home);
      if (lockAlive(current)) throw new Error(current.maintenance ? `ALP is busy: alp ${current.maintenance} runs (pid ${current.pid}); try again when it finishes` : `ALP daemon already running (pid ${current.pid})`);
      // Remove the stale lock only if nobody replaced it meanwhile.
      const again = await readFile(file, 'utf8').catch(() => undefined);
      if (again === undefined || JSON.stringify(current) === again || !lockAlive(JSON.parse(again))) await unlink(file).catch(() => {});
    }
  }
  throw new Error('Could not acquire the ALP daemon lock');
}

/** Lets go of alpd's lock if this process holds it. */
export async function releaseDaemonLock(home) {
  const current = await readLock(home);
  if (current?.pid === process.pid) await unlink(daemonPaths(home).lock).catch(() => {});
}

/**
 * One JSON-RPC 2.0 connection to alpd over a Unix socket or named pipe; events arrive as `event`
 * notifications. The engine is the portable AlpRpcClient; this keeps the socket constructor the
 * CLI, alpd's tests and the Paseo plugin use.
 */
export class AlpClient extends AlpRpcClient {
  /** Host features captured by connect's handshake. @type {readonly string[]} */
  capabilities = [];
  /** Limits captured by connect's handshake. @type {import('@anhlp/alp-protocol').AttachmentLimits | undefined} */
  attachmentLimits;
  /** @type {{ readonly maxCount: number; readonly maxBytes: number; readonly maxTotalBytes: number } | undefined} */
  promptImageLimits;
  /** @type {import('@anhlp/alp-protocol').TerminalLimits | undefined} */
  terminalLimits;
  /**
   * @param {import('node:net').Socket} socket a connected or connecting socket; the client owns it
   * @param {import('./rpc/client.js').AlpRpcClientOptions & import('./ipc.js').SocketTransportOptions} [options]
   */
  constructor(socket, { maxFrame, maxBufferedBytes, ...options } = {}) {
    super(createSocketTransport(socket, { maxFrame, maxBufferedBytes }), { maxFrame, ...options });
  }
}

/** A socket to alpd, once it is checked to be private to this user (the IPC checks above). @param {string} socketPath */
async function openSocket(socketPath) {
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
 * @param {import('./ipc.js').SocketTransportOptions} [options]
 */
export async function connectSocket(socketPath, options) {
  return createSocketTransport(await openSocket(socketPath), options);
}

/**
 * Connects and performs the version handshake.
 * @param {string} socketPath
 * @param {{ name: string, version: string }} [client]
 * @param {import('./rpc/client.js').AlpRpcClientOptions & import('./ipc.js').SocketTransportOptions} [options]
 * @returns {Promise<AlpClient>}
 */
export async function connect(socketPath, client = { name: 'alp', version: '0' }, options = {}) {
  const connection = new AlpClient(await openSocket(socketPath), options);
  try {
    const greeting = await hello(connection, client, undefined, { agent: typeof process.env.ALP_AGENT_SESSION === 'string' && process.env.ALP_AGENT_SESSION !== '' });
    connection.capabilities = Object.freeze(Array.isArray(greeting.capabilities) ? greeting.capabilities.filter(value => typeof value === 'string') : []);
    if (greeting.attachmentLimits && typeof greeting.attachmentLimits === 'object') {
      connection.attachmentLimits = Object.freeze({ ...greeting.attachmentLimits });
    }
    if (greeting.promptImageLimits && typeof greeting.promptImageLimits === 'object') {
      connection.promptImageLimits = Object.freeze({ ...greeting.promptImageLimits });
    }
    if (greeting.terminalLimits && typeof greeting.terminalLimits === 'object') {
      connection.terminalLimits = Object.freeze({ ...greeting.terminalLimits });
    }
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

/** Why a launcher failed, from the last structured log line it wrote to stderr: code and message, scrubbed. */
function launcherReason(text) {
  const line = text.trim().split('\n').filter(Boolean).at(-1);
  if (!line) return '';
  let reason = line;
  try {
    const record = JSON.parse(line);
    reason = `${record.code ? `${record.code}, ` : ''}${record.msg}${record.error?.message ? `: ${record.error.message}` : ''}`;
  } catch {}
  return `: ${scrubText(reason, { max: 600 })}`;
}

async function tail(file, lines = 30) {
  // The tail goes into an error message, so it is scrubbed like every other log output.
  try { return scrubText((await readFile(file, 'utf8')).split('\n').slice(-lines).join('\n'), { max: 8000 }); } catch { return ''; }
}

/** Immutable admission identities live in filenames, including for service hard links. */
async function lifecycleOwners(home) {
  const directory = path.join(home, 'state', 'alpd.starting');
  const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return names.map(token => {
    const match = /^owner-(\d+)-(\d+)-(start|stop)-[a-f0-9-]+$/.exec(token);
    if (!match) throw new Error('Invalid alpd startup admission owner');
    return { token, pid: Number(match[1]), bootTime: Number(match[2]), action: match[3] };
  });
}

export async function readDaemonLifecycle(home) {
  return (await lifecycleOwners(home)).find(owner => lockAlive(owner));
}

/** Serializes requested starts and stops, including the time before alpd has a lock.
 * Rename publishes a fully populated directory: an existing nonempty directory cannot
 * be replaced. Reaping/release unlinks only its unique owner token, then rmdir; even
 * racing stale reapers cannot remove a successor's nonempty directory.
 */
export async function withDaemonLifecycle(home, action, run, { joinStart = false, signal = /** @type {AbortSignal | undefined} */ (undefined) } = {}) {
  signal?.throwIfAborted();
  try {
    await assertPrivateDirectory(home, { create: true });
  } catch (cause) {
    // Admission now prepares the home before the launcher can report this failure.
    // Preserve the operator-facing startup code at this earlier boundary.
    throw Object.assign(new Error(`ALP_HOME_UNUSABLE, alpd failed to start while preparing its home: ${cause.message}`, { cause }), { code: 'ALP_HOME_UNUSABLE' });
  }
  const state = path.join(home, 'state');
  await assertPrivateDirectory(state, { create: true });
  const directory = path.join(state, 'alpd.starting');
  const currentBootId = bootId();
  const token = `owner-${process.pid}-${bootTime()}-${action}-${randomUUID()}`;
  const candidate = path.join(state, `alpd.starting-${token}`);
  await mkdir(candidate, { mode: 0o700 });
  await writeFile(path.join(candidate, token), JSON.stringify({
    pid: process.pid,
    bootTime: bootTime(),
    ...(currentBootId ? { bootId: currentBootId } : {}),
    startedUptime: Math.floor(os.uptime()),
    action,
  }), { mode: 0o600 });
  try {
    let joined = false;
    if (joinStart) {
      const owner = await readDaemonLifecycle(home);
      if (owner?.action === 'start') {
        try {
          // Linking the unique source token both validates this generation and
          // pins its directory until this service has finished starting.
          await link(path.join(directory, owner.token), path.join(directory, token));
          joined = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    while (!joined) {
      signal?.throwIfAborted();
      try { await rename(candidate, directory); break; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        for (const owner of await lifecycleOwners(home)) {
          if (!lockAlive(owner)) await unlink(path.join(directory, owner.token)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        await rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
        await delay(25, undefined, { signal });
      }
    }
    try { signal?.throwIfAborted(); return await run(); }
    finally {
      await unlink(path.join(directory, token));
      await rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
    }
  } finally {
    await unlink(path.join(candidate, token)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/**
 * Returns the socket of a ready daemon, starting one when none runs.
 * `entry` is the daemon script; it is started through its own detaching launcher so the
 * daemon outlives the client that started it.
 */
export async function ensureDaemon({ home = alpHome(), entry = /** @type {string | undefined} */ (undefined), env = process.env, execPath = process.execPath, timeoutMs = 15_000, lifecycleLocked = false, signal = /** @type {AbortSignal | undefined} */ (undefined) } = {}) {
  signal?.throwIfAborted();
  if (!lifecycleLocked) return withDaemonLifecycle(home, 'start', () => ensureDaemon({ home, entry, env, execPath, timeoutMs, lifecycleLocked: true, signal }), { signal });
  const ready = async () => {
    const lock = await readLock(home);
    return lockAlive(lock) && lock.ready ? lock.socket : undefined;
  };
  const live = await ready();
  if (live) return live;
  const held = await readLock(home);
  if (lockAlive(held) && held.maintenance) throw new Error(`ALP is busy: alp ${held.maintenance} runs (pid ${held.pid}); alpd starts again when it finishes`);
  if (!lockAlive(held)) {
    entry ??= await findDaemonEntry({ home, env });
    if (!entry) throw new Error('ALP daemon is not running and alpd.js was not found. Install the ALP CLI and run `alp daemon start`, or set ALP_DAEMON_ENTRY to alpd.js');
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const launcher = spawn(execPath, [entry, '--detach', `--startup-timeout=${timeoutMs}`], {
        env: { ...env, ALP_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
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

async function readIntegrationDescriptor(file, baseDirs = []) {
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

async function integrationCandidateFromHome(home, name) {
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

function integrationBinaryName(name) {
  return `alp-${name}-integration`;
}

/** Distribution roots that may carry a bundled integration descriptor. */
async function distributionRoots() {
  const roots = [];
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
 * `web`: that name belongs to alp-web, which ships with the CLI and is started with its explicit
 * entry. Everything once registered under `web` (the descriptor `integrations/web.json`, the
 * `alp-web-integration` binary, `ALP_WEB_INTEGRATION`) is the Paseo integration from before its
 * rename to `paseo`, which must never run under the web lock. `ALP_WEB_INTEGRATION` is read for
 * `paseo` only, after `ALP_PASEO_INTEGRATION`, for one release (like the alp-web-integration alias).
 * @param {string} [name]
 * @param {{ home?: string }} [options]
 */
export async function discoverIntegration(name = 'web', options = {}) {
  // The name becomes a descriptor path under <home>/integrations, so it must stay one safe segment.
  assertIntegrationName(name);
  if (name === 'web') return undefined;
  // Explicit environment override always wins: the integration's own, then the generic one.
  const envCandidates = [
    process.env[`ALP_${name.toUpperCase()}_INTEGRATION`],
    name === 'paseo' ? process.env.ALP_WEB_INTEGRATION : undefined,
    process.env.ALP_INTEGRATION_ENTRY,
  ].filter(Boolean);
  for (const candidate of envCandidates) if (await isFile(candidate)) return candidate;

  const home = options?.home ? path.resolve(options.home) : alpHome();
  const fromHome = await integrationCandidateFromHome(home, name);
  if (fromHome) return fromHome;

  // A full distribution may describe a bundled integration relative to its own root.
  for (const root of await distributionRoots()) {
    for (const descriptorPath of [path.join(root, 'integrations', `${name}.json`), path.join(root, 'integrations', name, 'integration.json')]) {
      const entry = await readIntegrationDescriptor(descriptorPath, [root]);
      if (entry) return entry;
    }
  }

  // Installed integration packages announce themselves on PATH.
  const binary = integrationBinaryName(name);
  for (const directory of [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...BIN_DIRECTORIES]) {
    const candidate = await realpath(path.join(directory, binary)).catch(() => undefined);
    if (candidate && await isFile(candidate)) return candidate;
  }
  return undefined;
}

export function integrationAlive(lock) {
  if (!lock || !Number.isSafeInteger(lock.pid) || !isSameBoot(lock)) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * What startIntegration says about integration `name`, and where its service writes its log: alp-web
 * (`web`) is part of the CLI, Paseo (`paseo`) an optional package, anything else named as is.
 * @param {string} name
 * @param {string} home
 */
function integrationText(name, home) {
  const logs = path.join(home, 'logs', 'integrations');
  if (name === 'web') return {
    what: 'alp web',
    log: path.join(logs, 'alp-web.log'),
    missing: 'alp web runs the alp-web service of the ALP CLI, which is started with its entry (packages/cli/dist/alp-web.js); run `alp web`',
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
 * Starts integration `name` (default `web`) detached with `--service` (then `args`) unless its lock
 * already names a live owner, then waits until its ready lock and `<home>/<name>.json` name the same
 * pid. `entry` names the script to run with this Node and skips descriptor, environment and PATH
 * discovery; `web` (alp-web) is never discovered, so it needs its entry. `"web": { "enabled": false }`
 * in the home's settings.json refuses `web` only.
 * @param {string | { name?: string, entry?: string, home?: string, args?: string[] }} [nameOrOptions]
 */
export async function startIntegration(nameOrOptions = 'web') {
  const options = typeof nameOrOptions === 'string' ? { name: nameOrOptions } : (nameOrOptions ?? {});
  const name = assertIntegrationName(options.name ?? 'web');
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

  // web.enabled turns off alp web only; other integrations have their own switches.
  if (name === 'web') {
    let settings = {};
    try { settings = JSON.parse(await fs.readFile(pathMod.join(home, 'settings.json'), 'utf8')); } catch {}
    if (settings?.web?.enabled === false) throw new Error('alp web is disabled by settings ("web.enabled": false).');
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
      // alp-web can fail during bootstrap after the initial exit check (for example a
      // refused uncertain lock). Its service log carries the cause; do not mask it with
      // a readiness/web.json timeout. Check a concurrent winner's ready lock first.
      if (name === 'web' && webStartupFailed()) throw new Error(`${text.what}${started} failed to start; see ${text.log}`);
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
  const child = spawn(process.execPath, [entry, '--service', ...args], { stdio: 'ignore', detached: true, env: { ...process.env, ALP_HOME: home } });
  let spawnError = null;
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
