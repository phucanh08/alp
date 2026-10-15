import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, lstat, mkdir, readlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { PROTOCOL_VERSION, MAX_FRAME, AlpRpcError, encodeFrame } from '@anhlp/alp-protocol';
import { scrubText } from '@anhlp/alp-core/log';
export { PROTOCOL_VERSION, MAX_FRAME, AlpRpcError, encodeFrame } from '@anhlp/alp-protocol';

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
    const name = await readFile(path.join(root, 'package.json'), 'utf8').then(text => JSON.parse(text).name, () => undefined);
    const entry = path.join(root, 'dist', 'alpd.js');
    if (CLI_PACKAGES.includes(name) && await isFile(entry)) return entry;
  }
  return undefined;
}

/** Wall-clock boot time; a lock from an earlier boot is stale even if its pid is reused. */
export function bootTime() {
  return Math.round((Date.now() - os.uptime() * 1000) / 1000);
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
  if (!lock || !Number.isSafeInteger(lock.pid) || Math.abs((lock.bootTime ?? 0) - bootTime()) > 30) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** One JSON-RPC 2.0 connection to alpd; events arrive as `event` notifications. */
export class AlpClient {
  #socket;
  #sequence = 0;
  #pending = new Map();
  #events = new Set();
  #closes = new Set();
  #requestHandlers = new Set();
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME) { socket.destroy(new Error('ALP daemon frame exceeds size limit')); return; }
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) this.#receive(line);
      }
    });
    socket.on('close', () => this.#finish(new Error('ALP daemon connection closed')));
    socket.on('error', error => this.#finish(error));
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { this.#socket.destroy(new Error('Invalid frame from ALP daemon')); return; }
    if (message.method === 'event') {
      for (const listener of this.#events) listener(message.params);
      return;
    }
    if (message.method && (message.id !== undefined && message.id !== null) && !Object.prototype.hasOwnProperty.call(message, 'result') && !Object.prototype.hasOwnProperty.call(message, 'error')) {
      const handler = [...this.#requestHandlers][0];
      if (handler) {
        Promise.resolve().then(async () => {
          try {
            const result = await handler(message.method, message.params ?? {});
            this.#socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, result: result === undefined ? {} : result }));
          } catch (error) {
            const code = (error && typeof error.code === 'number') ? error.code : 1000;
            const msg = error instanceof Error ? error.message : String(error);
            const data = (error && error.data !== undefined) ? { data: error.data } : {};
            this.#socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, error: { code, message: msg.length > 2000 ? msg.slice(0,2000)+'...' : msg, ...data } }));
          }
        });
        return;
      }
      this.#socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method '${message.method}'` } }));
      return;
    }
    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    if (message.error) waiter.reject(new AlpRpcError(message.error));
    else waiter.resolve(message.result);
  }

  #finish(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#pending.values()) waiter.reject(error);
    this.#pending.clear();
    for (const listener of this.#closes) listener(error);
  }

  get closed() { return this.#closed; }

  request(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error('ALP daemon connection closed'));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
    });
  }

  onEvent(listener) {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  onRequest(handler) {
    this.#requestHandlers.add(handler);
    return () => this.#requestHandlers.delete(handler);
  }

  onClose(listener) {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  close() {
    this.#socket.end();
    this.#finish(new Error('ALP daemon connection closed'));
  }
}

/** Connects and performs the version handshake. */
export async function connect(socketPath, client = { name: 'alp', version: '0' }) {
  await assertPrivateSocket(socketPath);
  const socket = await new Promise((resolve, reject) => {
    const candidate = net.createConnection(socketPath);
    candidate.once('connect', () => { candidate.off('error', reject); resolve(candidate); });
    candidate.once('error', reject);
  });
  const connection = new AlpClient(socket);
  try {
    await connection.request('daemon.hello', { protocolVersion: PROTOCOL_VERSION, client });
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

/**
 * Returns the socket of a ready daemon, starting one when none runs.
 * `entry` is the daemon script; it is started through its own detaching launcher so the
 * daemon outlives the client that started it.
 */
export async function ensureDaemon({ home = alpHome(), entry = /** @type {string | undefined} */ (undefined), env = process.env, execPath = process.execPath, timeoutMs = 15_000 } = {}) {
  const ready = async () => {
    const lock = await readLock(home);
    return lockAlive(lock) && lock.ready ? lock.socket : undefined;
  };
  const live = await ready();
  if (live) return live;
  if (!lockAlive(await readLock(home))) {
    entry ??= await findDaemonEntry({ home, env });
    if (!entry) throw new Error('ALP daemon is not running and alpd.js was not found. Install the ALP CLI and run `alp daemon start`, or set ALP_DAEMON_ENTRY to alpd.js');
    await new Promise((resolve, reject) => {
      const launcher = spawn(execPath, [entry, '--detach'], {
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
  return name === 'web' ? 'alp-web-integration' : `alp-${name}-integration`;
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

export async function discoverIntegration(name = 'web', options = {}) {
  // Explicit environment override always wins.
  const envCandidates = [
    process.env.ALP_WEB_INTEGRATION,
    process.env.ALP_INTEGRATION_ENTRY,
    name !== 'web' ? process.env[`ALP_${name.toUpperCase()}_INTEGRATION`] : undefined,
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

function integrationAlive(lock) {
  if (!lock || !Number.isSafeInteger(lock.pid)) return false;
  try { process.kill(lock.pid, 0); } catch (error) {
    return error?.code === 'EPERM';
  }
  if (typeof lock.bootTime === 'number' && Math.abs(lock.bootTime - bootTime()) > 30) return false;
  return true;
}

export async function startIntegration(nameOrOptions = 'web') {
  const options = typeof nameOrOptions === 'string' ? { name: nameOrOptions } : (nameOrOptions ?? {});
  const name = options.name ?? 'web';
  const fs = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const home = options.home ? pathMod.resolve(options.home) : alpHome();
  const lockPath = pathMod.join(home, 'integrations', `${name}.lock`);
  const webPath = pathMod.join(home, `${name}.json`);

  // Clear, actionable diagnostics for a disabled optional integration.
  let settings = {};
  try { settings = JSON.parse(await fs.readFile(pathMod.join(home, 'settings.json'), 'utf8')); } catch {}
  if (settings?.web?.enabled === false) {
    throw new Error('ALP web app is disabled by settings ("web.enabled": false).');
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const readLock = async () => {
    try { return JSON.parse(await fs.readFile(lockPath, 'utf8')); } catch { return undefined; }
  };
  const readWeb = async () => {
    try { return JSON.parse(await fs.readFile(webPath, 'utf8')); } catch { return undefined; }
  };

  // The authoritative check: the ready integration lock and live web.json must name the same pid.
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
      await sleep(100);
    }
    const lock = await readLock();
    if (lock && !lock.ready) throw new Error('ALP web integration started but did not become ready; see ~/.alp/logs/integrations/paseo.log');
    if (!lock) throw new Error('ALP web app is provided by an optional integration package. Install it (for example `npm install -g alp-paseo-plugin`) and run `alp web` again.');
    throw new Error('ALP web integration did not publish a matching web.json lock');
  }

  const existing = await readLock();
  if (existing && integrationAlive(existing)) {
    return waitForReady();
  }

  const entry = await discoverIntegration(name, { home });
  if (!entry) {
    throw new Error('ALP web app is provided by an optional integration package. Install it (for example `npm install -g alp-paseo-plugin`) and run `alp web` again.');
  }

  const { spawn } = await import('node:child_process');
  // The child is detached with its stdio ignored, so it cannot rely on the parent's console. `--service`
  // is the generic contract: the entry writes its own log (the path its error messages advertise) and
  // keeps the process alive as a service. `--register` still prints to stdout and is not passed here.
  const child = spawn(process.execPath, [entry, '--service'], { stdio: 'ignore', detached: true, env: { ...process.env, ALP_HOME: home } });
  let spawnError = null;
  child.on('error', error => { spawnError = error; });
  let exited = false;
  child.on('exit', code => { if (code !== 0 && code !== null) exited = true; });
  child.unref();

  if (spawnError) throw spawnError;
  // Give the process a moment to fail immediately on missing entry or bad permissions.
  await sleep(150);
  if (spawnError) throw spawnError;
  if (exited) throw new Error('ALP web integration failed to start; see ~/.alp/logs/integrations/paseo.log');

  return waitForReady();
}
