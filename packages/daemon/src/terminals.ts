import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readFile } from 'node:fs/promises';
import { nativePtySpawn, nativeTerminalCapability, type CleanupResult } from './native-terminal.js';
import path from 'node:path';
import { ERROR, RPC_ERROR, TERMINAL, TERMINAL_LIMIT_KEYS, isTerminalId } from '@anhlp/alp-protocol';
import type { TerminalEndReason, TerminalEvent, TerminalInfo, TerminalLimits } from '@anhlp/alp-protocol/rpc';
import { RpcError } from './rpc-error.js';
import { TerminalScreen, SCREEN_LIMITS } from './terminal-screen.js';

/**
 * Terminals (capability `terminal`, docs/protocol/alp-json-rpc-v1.md §12.10, issue #121 H): a real
 * PTY running a shell on this host **as the daemon's account**. A workspace chooses only where the
 * shell starts and who sees the terminal; it is not a sandbox. alpd serves terminals only while the
 * host owner opted in (`<ALP_HOME>/terminal.json` `allowRemoteTerminal`, an owner-private file no RPC
 * writes), on macOS and Linux, when the shipped native owner validates its capability. Lifecycle is audited;
 * input, output and the environment never are.
 */

/** Who a call acts for, as for attachments: a gateway's credential and grant epoch, or the owner. */
export type TerminalPrincipal = { id: string; epoch: string; roots?: readonly string[] };
/** The connection a terminal streams to: alpd's own IPC connection object. */
export type TerminalSink = { send(message: unknown): void; socket?: { writableLength: number; destroyed?: boolean } };
type Disposable = { dispose(): void };
/** Native owner interface; injected owners are used only by tests. */
export type PtyProcess = {
  pid: number;
  /** The PTY's device (node-pty's UnixTerminal), such as /dev/ttys004 or /dev/pts/3. */
  readonly ptsName?: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  cleanup?: () => Promise<CleanupResult>;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number | null; signal?: number }) => void): Disposable;
};
export type PtySpawn = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string>; killGraceMs?: number; signal?: AbortSignal }) => PtyProcess | Promise<PtyProcess>;
/** One process: ids, (Linux) session, controlling tty, age, and the terminal markers in its environment. */
export type ProcessRow = { pid: number; ppid: number; pgid: number; sid?: number; tty?: string; elapsedMs: number; markers?: string[] };
type Log = { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };

export type TerminalServiceOptions = {
  home: string;
  /** The canonical directory of a registry workspace, or a RegistryError-like refusal. */
  resolveWorkspace(workspaceId: string): Promise<string>;
  log: Log;
  /** Lower limits (tests, an embedding host); never higher than TERMINAL. */
  limits?: Partial<TerminalLimits>;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Test hook: the PTY owner; production uses only the identity-bound native owner. */
  spawn?: PtySpawn;
  /** Test hook: the process table; default `ps`. */
  processes?: () => Promise<ProcessRow[]>;
  sweepMs?: number;
  killGraceMs?: number;
  /** Bytes of terminal events waiting on a connection's socket before it counts as a slow consumer. */
  maxBufferedBytes?: number;
};

type Frame = { seq: number; data: string; bytes: number };
type Terminal = {
  id: string;
  principal: { id: string; epoch: string };
  workspaceId: string;
  root: string;
  title: string;
  cols: number;
  rows: number;
  pty: PtyProcess;
  screen: TerminalScreen;
  pid: number;
  /** The PTY's device as ps names it (ttys004, pts/3): a controlling terminal outlives double forks. */
  tty?: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  requestKey: string;
  ring: Frame[];
  ringBytes: number;
  nextSeq: number;
  sink?: TerminalSink;
  detachedAt?: number;
  /** Informational terminal marker only; NEVER used to discover or signal processes. */
  marker: string;
  ending?: TerminalEndReason;
  exit?: { seq: number; exitCode: number | null; signal: number | null; reason: TerminalEndReason; at: number };
  disposables: Disposable[];
  reaped?: Promise<void>;
};

const SWEEP_MS = 5_000;
const KILL_GRACE_MS = 1_000;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const CONFIG_FILE = 'terminal.json';
/** Variables of alpd's own environment a terminal does not inherit. */
const PRIVATE_ENV = /^(ALP_|npm_)/i;

const notFound = () => new RpcError(ERROR.notFound, 'No such terminal', { reason: 'not_found' });
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The host switch and the operator's lower limits. Anything but a regular, owner-private file of
 * this user saying `"allowRemoteTerminal": true` is off.
 */
export async function readTerminalConfig(home: string, log?: Log): Promise<{ enabled: boolean; reason?: string; limits: TerminalLimits; paseo: boolean }> {
  const defaults = Object.fromEntries(TERMINAL_LIMIT_KEYS.map(key => [key, TERMINAL[key as keyof typeof TERMINAL]])) as TerminalLimits;
  const file = path.join(home, CONFIG_FILE);
  const info = await lstat(file).catch(() => undefined);
  if (!info) return { enabled: false, reason: 'missing', limits: defaults, paseo: false };
  if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) {
    log?.warn('terminal.json is not a private file of the daemon user; terminals stay off', { code: 'ALPD_TERMINAL_CONFIG' });
    return { enabled: false, reason: 'not_private', limits: defaults, paseo: false };
  }
  let value: any;
  try { value = JSON.parse(await readFile(file, 'utf8')); } catch {
    log?.warn('terminal.json is not valid JSON; terminals stay off', { code: 'ALPD_TERMINAL_CONFIG' });
    return { enabled: false, reason: 'invalid', limits: defaults, paseo: false };
  }
  if (!value || typeof value !== 'object' || value.version !== 1) return { enabled: false, reason: 'invalid', limits: defaults, paseo: false };
  const limits = { ...defaults };
  if (value.limits && typeof value.limits === 'object') {
    for (const [key, raw] of Object.entries(value.limits)) {
      if (!(TERMINAL_LIMIT_KEYS as readonly string[]).includes(key) || !Number.isSafeInteger(raw) || (raw as number) < 1) { log?.warn(`terminal.json limit ${key} ignored`, { code: 'ALPD_TERMINAL_CONFIG' }); continue; }
      const k = key as keyof TerminalLimits;
      if ((raw as number) > defaults[k]) { log?.warn(`terminal.json limit ${key} is above the maximum; ignored`, { code: 'ALPD_TERMINAL_CONFIG' }); continue; }
      limits[k] = raw as number;
    }
  }
  // allowPaseoTerminal: Paseo app devices paired through the relay act as the owner and hold no
  // terminal.exec; the Paseo bridge offers terminals only with this second, separate opt-in.
  return value.allowRemoteTerminal === true ? { enabled: true, limits, paseo: value.allowPaseoTerminal === true } : { enabled: false, reason: 'off', limits, paseo: false };
}

/** `[[dd-]hh:]mm:ss` of ps etime, in milliseconds. */
function elapsed(text: string) {
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text];
  const parts = rest!.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return (((Number(days) * 24 + h) * 60 + m) * 60 + s) * 1000;
}

const MARKER = /(?:^|\s)ALP_TERMINAL_ID=(atm_[0-9a-f]{32})(?=\s|$)/g;
const markersOf = (text: string) => [...text.matchAll(MARKER)].map(match => match[1]!);
const ENTRY = /^ALP_TERMINAL_ID=(atm_[0-9a-f]{32})$/;

/**
 * The process table: pid, parent, group, (Linux) session, controlling tty, age, and the terminal
 * markers in each process's environment (macOS: `ps -E`, this user's processes only; Linux:
 * /proc/<pid>/environ, readable for this user's processes).
 */
export function psProcesses(platform: NodeJS.Platform = process.platform, options: {
  /** Controlled filesystem seam; production always reads the actual proc entry asynchronously. */
  readEnvironment?: (pid: number) => Promise<string>;
} = {}): () => Promise<ProcessRow[]> {
  const linux = platform === 'linux';
  // At most 10 s for each ps, even one that does not die at once.
  const run = (args: string[]) => new Promise<string | undefined>(resolve => {
    const child = execFile('ps', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, killSignal: 'SIGKILL', env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => { clearTimeout(timer); resolve(error ? undefined : stdout); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(undefined); }, 10_000);
  });
  return async () => {
    const columns = linux ? 'pid=,ppid=,pgid=,sid=,tty=,etime=' : 'pid=,ppid=,pgid=,tty=,etime=,command=';
    // macOS: `ps -E` appends the environment to the command line (escaping newlines as \012); the
    // command line alone, from a second pass, is cut off first so a marker in arguments never counts.
    const [stdout, plain] = await Promise.all([run(linux ? ['-A', '-o', columns] : ['-A', '-E', '-ww', '-o', columns]), linux ? undefined : run(['-A', '-ww', '-o', 'pid=,command='])]);
    if (stdout === undefined) return [];
    const commands = new Map<number, string>();
    for (const line of plain?.split('\n') ?? []) {
      const match = /^\s*(\d+) (.*)$/.exec(line);
      if (match) commands.set(Number(match[1]), match[2]!);
    }
    const rows: ProcessRow[] = [];
    for (const line of stdout.split('\n')) {
      const cells = line.trim().split(/\s+/);
      if (cells.length < 5) continue;
      const [pid, ppid, pgid] = cells.slice(0, 3).map(Number) as [number, number, number];
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) continue;
      const sid = linux ? Number(cells[3]) : undefined;
      const tty = cells[linux ? 4 : 3]!;
      let markers: string[] = [];
      // Linux: one entry of the environment, never a marker inside another variable's value.
      if (linux) { try { markers = (await (options.readEnvironment ? options.readEnvironment(pid) : readFile(`/proc/${pid}/environ`, 'utf8'))).split('\0').flatMap(entry => ENTRY.exec(entry)?.[1] ?? []); } catch {} }
      else {
        // Exactly one space after etime: a command line may itself start with spaces.
        const full = /^\s*(?:\S+\s+){4}\S+ (.*)$/.exec(line)?.[1] ?? '';
        const command = commands.get(pid);
        // The environment is what follows the command line; when the two passes disagree, none.
        if (command !== undefined && full.startsWith(command)) markers = markersOf(full.slice(command.length));
      }
      rows.push({ pid, ppid, pgid, ...(sid !== undefined && Number.isSafeInteger(sid) ? { sid } : {}), ...(/^[?-]+$/.test(tty) ? {} : { tty }), elapsedMs: elapsed(cells[linux ? 5 : 4]!), ...(markers.length ? { markers } : {}) });
    }
    return rows;
  };
}

/** Splits output into frames of at most `max` UTF-8 bytes, never inside a character. */
export function frames(data: string, max: number): string[] {
  if (Buffer.byteLength(data) <= max) return [data];
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of data) {
    const size = Buffer.byteLength(char);
    if (bytes + size > max && current) { out.push(current); current = ''; bytes = 0; }
    current += char;
    bytes += size;
  }
  if (current) out.push(current);
  return out;
}

export function createTerminalService(options: TerminalServiceOptions) {
  const { home, resolveWorkspace, log } = options;
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const supported = platform === 'darwin' || platform === 'linux';
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const maxBuffered = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const terminals = new Map<string, Terminal>();
  const requests = new Map<string, string>();
  const watchers = new Map<TerminalSink, { principal: TerminalPrincipal; workspaceId?: string; watchId: string; cursor: string }>();
  const token = () => randomBytes(16).toString('hex');
  function changed(terminal: Terminal) {
    for (const [sink, watch] of watchers) {
      if (watch.principal.id !== terminal.principal.id || watch.principal.epoch !== terminal.principal.epoch || !within(watch.principal, terminal.root) || (watch.workspaceId !== undefined && watch.workspaceId !== terminal.workspaceId)) continue;
      watch.cursor = token();
      try { sink.send({ jsonrpc: '2.0', method: 'terminal.changed', params: { watchId: watch.watchId, cursor: watch.cursor } }); } catch { watchers.delete(sink); }
    }
  }
  function snapshot(principal: TerminalPrincipal, workspaceId?: string) {
    return [...terminals.values()].filter(terminal => terminal.principal.id === principal.id && terminal.principal.epoch === principal.epoch && within(principal, terminal.root) && (workspaceId === undefined || terminal.workspaceId === workspaceId))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)).map(info);
  }
  let closed = false;
  let enabled = false;
  let cleanupFault = false;
  type Pending = { principal: TerminalPrincipal; workspaceId: string; controller: AbortController; admitted: boolean; reason?: string; promise: Promise<{ terminal: TerminalInfo }> };
  const pending = new Map<string, Pending>();
  // Explicit injected test owners need no host capability. Production never falls back to node-pty.
  const spawner: PtySpawn = options.spawn ?? nativePtySpawn;
  let capable: boolean | undefined;
  function pty() { capable ??= !!options.spawn || nativeTerminalCapability().available; return capable ? spawner : undefined; }
  const cancel = (entry: Pending, reason: string) => { entry.reason ??= reason; entry.controller.abort(); };
  const refused = (reason: string) => new RpcError(ERROR.unavailable, 'Terminal startup was cancelled or its native owner is unavailable', { reason });
  async function cleanup(owner: PtyProcess, id?: string) {
    if (!owner.cleanup) { owner.kill(); return; } // explicit test owner only
    const result = await owner.cleanup();
    if (result.live || result.uncertain) {
      cleanupFault = true;
      log.warn('native terminal cleanup could not prove all observed processes exited', { code: 'ALPD_TERMINAL_REAP_FAILED', terminalId: id, ...result });
      throw refused('terminal_cleanup_uncertain');
    }
  }

  /** Effective limits: the operator's, then the caller's lower ones. */
  function effective(config: TerminalLimits): TerminalLimits {
    const limits = { ...config };
    for (const key of TERMINAL_LIMIT_KEYS as readonly (keyof TerminalLimits)[]) {
      const lower = options.limits?.[key];
      if (Number.isSafeInteger(lower) && lower! > 0 && lower! < limits[key]) limits[key] = lower!;
    }
    return limits;
  }

  /** The switch now: off kills every terminal (reason `disabled`). */
  async function state() {
    const config = await readTerminalConfig(home, log);
    const limits = effective(config.limits);
    if (enabled && !config.enabled) {
      log.info('terminals turned off on this host; ending every terminal', { code: 'ALPD_TERMINAL_DISABLED' });
      for (const entry of pending.values()) cancel(entry, 'terminal_disabled');
      for (const terminal of terminals.values()) if (!terminal.exit) void end(terminal, 'disabled').catch(() => {});
    }
    enabled = config.enabled;
    return { enabled: config.enabled, limits };
  }

  /** The switch, the platform and the module, or the refusal. */
  async function ready() {
    if (cleanupFault) throw refused('terminal_cleanup_uncertain');
    if (closed) throw new RpcError(ERROR.unavailable, 'alpd is shutting down', { reason: 'terminal_unsupported' });
    if (!supported) throw new RpcError(ERROR.unavailable, 'Terminals are not supported on this host\'s platform', { reason: 'terminal_unsupported' });
    const current = await state();
    if (!current.enabled) throw new RpcError(ERROR.unavailable, 'The host has not allowed remote terminals (alp terminal allow)', { reason: 'terminal_disabled' });
    if (!pty()) throw new RpcError(ERROR.unavailable, 'The native terminal owner is unavailable on this host', { reason: 'terminal_unsupported' });
    return current.limits;
  }

  function info(terminal: Terminal): TerminalInfo {
    return {
      terminalId: terminal.id, workspaceId: terminal.workspaceId, title: terminal.title, cols: terminal.cols, rows: terminal.rows,
      state: terminal.exit ? 'exited' : 'running', attached: !!terminal.sink, createdAt: iso(terminal.createdAt),
      lastActivityAt: iso(terminal.lastActivityAt), expiresAt: iso(terminal.expiresAt),
      ...(terminal.exit ? { exitCode: terminal.exit.exitCode, signal: terminal.exit.signal, endReason: terminal.exit.reason } : {}),
    };
  }

  const audit = (message: string, terminal: Terminal, fields: Record<string, unknown> = {}) =>
    log.info(message, { terminalId: terminal.id, workspaceId: terminal.workspaceId, principal: terminal.principal.id, ...fields });

  /** The caller's own terminal, in its roots; anything else is the same not_found. */
  function own(principal: TerminalPrincipal, terminalId: unknown): Terminal {
    const terminal = isTerminalId(terminalId) ? terminals.get(terminalId as string) : undefined;
    if (!terminal || terminal.principal.id !== principal.id || terminal.principal.epoch !== principal.epoch || !within(principal, terminal.root)) throw notFound();
    return terminal;
  }

  function within(principal: TerminalPrincipal, root: string) {
    if (principal.roots === undefined) return true;
    return principal.roots.some(granted => root === granted || root.startsWith(granted.endsWith(path.sep) ? granted : granted + path.sep));
  }

  function send(terminal: Terminal, event: TerminalEvent) {
    const sink = terminal.sink;
    if (!sink) return;
    sink.send({ jsonrpc: '2.0', method: 'terminal.event', params: event });
    if (event.type === 'output' && (sink.socket?.writableLength ?? 0) > maxBuffered) detach(terminal, 'slow_consumer');
  }

  /** Ends the stream of a terminal (it keeps running for reconnectMs). */
  function detach(terminal: Terminal, reason: 'replaced' | 'slow_consumer' | 'disconnected') {
    const sink = terminal.sink;
    if (!sink) return;
    terminal.sink = undefined;
    terminal.detachedAt = now();
    if (reason !== 'disconnected') sink.send({ jsonrpc: '2.0', method: 'terminal.event', params: { terminalId: terminal.id, type: 'detached', reason } satisfies TerminalEvent });
    changed(terminal);
    audit('terminal detached', terminal, { code: 'ALPD_TERMINAL_DETACHED', reason });
  }

  function output(terminal: Terminal, data: string, limits: TerminalLimits) {
    terminal.lastActivityAt = now();
    terminal.screen.write(data);
    for (const piece of frames(data, limits.maxOutputFrameBytes)) {
      const frame: Frame = { seq: terminal.nextSeq++, data: piece, bytes: Buffer.byteLength(piece) };
      terminal.ring.push(frame);
      terminal.ringBytes += frame.bytes;
      while (terminal.ringBytes > limits.replayBytes && terminal.ring.length > 1) terminal.ringBytes -= terminal.ring.shift()!.bytes;
      send(terminal, { terminalId: terminal.id, type: 'output', seq: frame.seq, data: frame.data });
    }
  }

  /** Native owns discovery, identity-bound signals, and exclusive root reap. */
  function reap(terminal: Terminal) {
    terminal.reaped ??= cleanup(terminal.pty, terminal.id);
    // Preserve rejection for close/revoke/shutdown while avoiding unhandled natural-exit errors.
    void terminal.reaped.catch(() => {});
    return terminal.reaped;
  }

  /** The shell ended: the exit event, the rest of its tree killed, the record kept for reconnectMs. */
  function exited(terminal: Terminal, exitCode: number | null, signalNumber: number | null) {
    if (terminal.exit) return;
    const reason = terminal.ending ?? 'exited';
    terminal.exit = { seq: terminal.nextSeq++, exitCode, signal: signalNumber, reason, at: now() };
    for (const disposable of terminal.disposables) { try { disposable.dispose(); } catch {} }
    requests.delete(terminal.requestKey);
    send(terminal, { terminalId: terminal.id, type: 'exit', seq: terminal.exit.seq, exitCode, signal: signalNumber, reason });
    changed(terminal);
    audit('terminal ended', terminal, { code: 'ALPD_TERMINAL_ENDED', reason, exitCode, signal: signalNumber });
    void reap(terminal).catch(() => {});
  }

  /** Ends a running terminal for `reason`; resolves once its tree was killed. */
  async function end(terminal: Terminal, reason: TerminalEndReason) {
    if (terminal.exit) return terminal.reaped;
    terminal.ending ??= reason;
    const reaping = reap(terminal);
    await reaping;
    // A clean native completion includes the root reap; preserve an exit if no callback arrived.
    if (!terminal.exit) exited(terminal, null, null);
  }

  let sweeping = false;
  async function sweep() {
    if (closed || sweeping) return;
    sweeping = true;
    try { await sweepOnce(); } finally { sweeping = false; }
  }
  async function sweepOnce() {
    const current = await state().catch(() => undefined);
    if (!current) return;
    const { limits } = current;
    const at = now();
    for (const terminal of [...terminals.values()]) {
      if (terminal.exit) {
        if (at - terminal.exit.at >= limits.reconnectMs) forget(terminal);
        continue;
      }
      if (at >= terminal.expiresAt) void end(terminal, 'lifetime').catch(() => {});
      else if (at - terminal.lastActivityAt >= limits.idleMs) void end(terminal, 'idle').catch(() => {});
      else if (!terminal.sink && terminal.detachedAt !== undefined && at - terminal.detachedAt >= limits.reconnectMs) void end(terminal, 'detached').catch(() => {});
    }
  }
  const timer = setInterval(() => void sweep().catch(() => {}), options.sweepMs ?? SWEEP_MS);
  timer.unref?.();

  /** The approved shell: the daemon user's login shell when /etc/shells lists it, else /bin/sh. */
  async function shell() {
    const candidate = process.env.SHELL;
    if (candidate && path.isAbsolute(candidate)) {
      const listed = await readFile('/etc/shells', 'utf8').then(text => text.split('\n').map(line => line.trim()).includes(candidate), () => false);
      if (listed && await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
    }
    return '/bin/sh';
  }

  function environment(marker: string) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !PRIVATE_ENV.test(key)) env[key] = value;
    return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ALP_TERMINAL: '1', ALP_TERMINAL_ID: marker };
  }

  function forget(terminal: Terminal) {
    terminal.screen.dispose();
    terminals.delete(terminal.id);
    changed(terminal);
  }

  const running = (filter: (terminal: Terminal) => boolean) => [...terminals.values()].filter(terminal => !terminal.exit && filter(terminal)).length;

  return {
    /** `terminalLimits` for daemon.hello while terminals are served, else undefined. */
    async advertised(): Promise<TerminalLimits | undefined> {
      if (closed || !supported) return undefined;
      const current = await state().catch(() => undefined);
      return !cleanupFault && current?.enabled && pty() ? current.limits : undefined;
    },

    create(principal: TerminalPrincipal, params: { workspaceId: string; cols: number; rows: number; requestId: string }): Promise<{ terminal: TerminalInfo }> {
      const requestKey = JSON.stringify([principal.id, principal.epoch, params.requestId]);
      const existing = pending.get(requestKey);
      if (existing) {
        if (existing.workspaceId !== params.workspaceId) return Promise.reject(new RpcError(ERROR.conflict, 'This requestId created another terminal', { reason: 'request_conflict' }));
        return existing.promise.then(result => { own(principal, result.terminal.terminalId); return result; });
      }
      if (pending.size >= TERMINAL.maxPerDaemon * 2) return Promise.reject(refused('terminal_limit'));
      const entry: Pending = { principal: { ...principal }, workspaceId: params.workspaceId, controller: new AbortController(), admitted: false, promise: undefined! };
      pending.set(requestKey, entry);
      entry.promise = (async () => {
        let process_: PtyProcess | undefined;
        try {
          const limits = await ready();
          const root = await resolveWorkspace(params.workspaceId).catch((error: any) => {
            if (typeof error?.code === 'number' && error.code !== ERROR.failed) throw new RpcError(error.code === ERROR.forbidden ? ERROR.forbidden : ERROR.notFound, error.code === ERROR.forbidden ? 'The workspace directory changed' : 'No workspace with this workspaceId', { reason: error.data?.reason ?? 'not_found' });
            throw error;
          });
          if (!within(principal, root)) throw new RpcError(ERROR.forbidden, 'The workspace is outside this grant', { reason: 'outside_workspace' });
          const file = await shell();
          if (cleanupFault) throw refused('terminal_cleanup_uncertain');
          if (entry.reason || closed) throw refused(entry.reason ?? 'terminal_unsupported');
          const repeated = terminals.get(requests.get(requestKey) ?? '');
          if (repeated && !repeated.exit) {
            if (repeated.workspaceId !== params.workspaceId) throw new RpcError(ERROR.conflict, 'This requestId created another terminal', { reason: 'request_conflict' });
            return { terminal: info(repeated) };
          }
          const reserved = (id?: string) => [...pending.values()].filter(other => other.admitted && (id === undefined || other.principal.id === id)).length;
          if (running(terminal => terminal.principal.id === principal.id) + reserved(principal.id) >= limits.maxPerPrincipal) throw new RpcError(ERROR.unavailable, `At most ${limits.maxPerPrincipal} terminals run per principal`, { reason: 'terminal_limit', limit: 'principal' });
          if (running(() => true) + reserved() >= limits.maxPerDaemon) throw new RpcError(ERROR.unavailable, `At most ${limits.maxPerDaemon} terminals run on this host`, { reason: 'terminal_limit', limit: 'daemon' });
          entry.admitted = true;
          const at = now();
          const marker = `atm_${randomBytes(16).toString('hex')}`;
          process_ = await spawner(file, [], { name: 'xterm-256color', cols: params.cols, rows: params.rows, cwd: root, env: environment(marker), killGraceMs, signal: entry.controller.signal });
          const current = await state();
          if (cleanupFault) throw refused('terminal_cleanup_uncertain');
          if (entry.reason || closed || !current.enabled) throw refused(entry.reason ?? (closed ? 'terminal_unsupported' : 'terminal_disabled'));
          const screens = [...terminals.values()].filter(terminal => terminal.screen.available);
          while (screens.length >= SCREEN_LIMITS.retained) {
            const oldest = screens.findIndex(terminal => !!terminal.exit);
            if (oldest < 0) break;
            screens.splice(oldest, 1)[0]!.screen.dispose();
          }
          const terminal: Terminal = {
            id: `term_${randomBytes(16).toString('hex')}`, principal: { id: principal.id, epoch: principal.epoch }, workspaceId: params.workspaceId,
            root, title: path.basename(file).slice(0, 64), cols: params.cols, rows: params.rows, pty: process_, pid: process_.pid, screen: new TerminalScreen(params.cols, params.rows),
            ...(typeof process_.ptsName === 'string' && process_.ptsName.startsWith('/dev/') ? { tty: process_.ptsName.slice('/dev/'.length) } : {}),
            createdAt: at, lastActivityAt: at, expiresAt: at + limits.maxLifetimeMs, requestKey, ring: [], ringBytes: 0, nextSeq: 1,
            detachedAt: at, marker, disposables: [],
          };
          terminals.set(terminal.id, terminal);
          requests.set(requestKey, terminal.id);
          terminal.disposables.push(process_.onData(data => output(terminal, data, limits)));
          terminal.disposables.push(process_.onExit(({ exitCode, signal: number }) => exited(terminal, terminal.ending ? null : exitCode, number || null)));
          entry.admitted = false;
          changed(terminal);
          audit('terminal created', terminal, { code: 'ALPD_TERMINAL_CREATED' });
          return { terminal: info(terminal) };
        } catch (error) {
          if (process_) await cleanup(process_);
          const failedCleanup = (error as { cleanupResult?: CleanupResult })?.cleanupResult;
          if (failedCleanup && (failedCleanup.live || failedCleanup.uncertain)) {
            cleanupFault = true;
            log.warn('native startup cleanup was uncertain', { code: 'ALPD_TERMINAL_REAP_FAILED', ...failedCleanup });
            throw refused('terminal_cleanup_uncertain');
          }
          if (entry.reason) throw refused(entry.reason);
          if (entry.admitted && !(error instanceof RpcError)) throw refused('terminal_unsupported');
          throw error;
        } finally { pending.delete(requestKey); }
      })();
      return entry.promise;
    },

    async list(principal: TerminalPrincipal, params: { workspaceId?: string }) {
      if (supported) await state().catch(() => undefined);
      return { terminals: snapshot(principal, params.workspaceId) };
    },

    async watch(principal: TerminalPrincipal, sink: TerminalSink, params: { workspaceId?: string; after?: string }) {
      await ready();
      const old = watchers.get(sink);
      const same = old && old.principal.id === principal.id && old.principal.epoch === principal.epoch && JSON.stringify(old.principal.roots) === JSON.stringify(principal.roots) && old.workspaceId === params.workspaceId;
      const watch = same ? old : { principal: { ...principal, ...(principal.roots ? { roots: [...principal.roots] } : {}) }, workspaceId: params.workspaceId, watchId: token(), cursor: token() };
      // Register and snapshot in one synchronous step after all configuration awaits.
      watchers.set(sink, watch);
      return { terminals: snapshot(principal, params.workspaceId), watchId: watch.watchId, cursor: watch.cursor, reset: params.after !== watch.cursor };
    },
    async unwatch(sink: TerminalSink) { watchers.delete(sink); return { closed: true as const }; },

    async capture(principal: TerminalPrincipal, params: { terminalId: string; start?: number; end?: number; stripAnsi?: boolean }) {
      await ready();
      const terminal = own(principal, params.terminalId);
      const result = await terminal.screen.capture(params);
      // Permission/config and record lifetime may have changed while the parser flushed.
      await ready();
      if (own(principal, params.terminalId) !== terminal) throw notFound();
      return result;
    },

    async attach(principal: TerminalPrincipal, sink: TerminalSink, params: { terminalId: string; after?: number }) {
      await ready();
      const terminal = own(principal, params.terminalId);
      if (terminal.sink && terminal.sink !== sink) detach(terminal, 'replaced');
      terminal.sink = sink;
      terminal.detachedAt = undefined;
      const after = Math.min(params.after ?? 0, terminal.nextSeq - 1);
      const first = terminal.ring[0]?.seq ?? terminal.nextSeq;
      const lastOutput = terminal.exit ? terminal.exit.seq - 1 : terminal.nextSeq - 1;
      const gap = after + 1 < first && after < lastOutput ? { fromSeq: after + 1, toSeq: Math.min(first, lastOutput + 1) - 1 } : undefined;
      for (const frame of terminal.ring) if (frame.seq > after) sink.send({ jsonrpc: '2.0', method: 'terminal.event', params: { terminalId: terminal.id, type: 'output', seq: frame.seq, data: frame.data } satisfies TerminalEvent });
      if (terminal.exit && terminal.exit.seq > after) sink.send({ jsonrpc: '2.0', method: 'terminal.event', params: { terminalId: terminal.id, type: 'exit', seq: terminal.exit.seq, exitCode: terminal.exit.exitCode, signal: terminal.exit.signal, reason: terminal.exit.reason } satisfies TerminalEvent });
      changed(terminal);
      audit('terminal attached', terminal, { code: 'ALPD_TERMINAL_ATTACHED', after, ...(gap ? { gap: gap.toSeq - gap.fromSeq + 1 } : {}) });
      return { terminal: info(terminal), nextSeq: terminal.nextSeq, ...(gap ? { gap } : {}) };
    },

    async input(principal: TerminalPrincipal, sink: TerminalSink, params: { terminalId: string; data: string }) {
      const limits = await ready();
      const terminal = own(principal, params.terminalId);
      if (terminal.sink !== sink) throw new RpcError(ERROR.conflict, 'Attach the terminal on this connection first', { reason: 'not_attached' });
      if (terminal.exit || terminal.ending) throw new RpcError(ERROR.conflict, 'The terminal has ended', { reason: 'terminal_exited' });
      const bytes = Buffer.byteLength(params.data);
      if (bytes > limits.maxInputBytes) throw new RpcError(RPC_ERROR.invalidParams, `At most ${limits.maxInputBytes} bytes of input at once`, { reason: 'input_too_large' });
      terminal.pty.write(params.data);
      terminal.lastActivityAt = now();
      return { bytes };
    },

    async resize(principal: TerminalPrincipal, sink: TerminalSink, params: { terminalId: string; cols: number; rows: number }) {
      await ready();
      const terminal = own(principal, params.terminalId);
      if (terminal.sink !== sink) throw new RpcError(ERROR.conflict, 'Attach the terminal on this connection first', { reason: 'not_attached' });
      if (terminal.exit || terminal.ending) throw new RpcError(ERROR.conflict, 'The terminal has ended', { reason: 'terminal_exited' });
      terminal.screen.resize(params.cols, params.rows);
      terminal.pty.resize(params.cols, params.rows);
      terminal.cols = params.cols;
      terminal.rows = params.rows;
      changed(terminal);
      return { cols: terminal.cols, rows: terminal.rows };
    },

    async close(principal: TerminalPrincipal, params: { terminalId: string }) {
      const terminal = own(principal, params.terminalId);
      if (terminal.exit) { await terminal.reaped; forget(terminal); return { closed: true as const }; }
      await end(terminal, 'closed');
      forget(terminal);
      return { closed: true as const };
    },

    /** Every terminal of a principal, any epoch: a gateway's revocation. */
    async revoke(principalId: string) {
      const starting = [...pending.values()].filter(entry => entry.principal.id === principalId);
      const newlyCancelled = starting.filter(entry => !entry.reason);
      for (const entry of newlyCancelled) cancel(entry, 'terminal_revoked');
      const mine = [...terminals.values()].filter(terminal => terminal.principal.id === principalId);
      const live = mine.filter(terminal => !terminal.exit && !terminal.ending);
      const outcomes = await Promise.allSettled([...mine.map(terminal => terminal.exit ? terminal.reaped : end(terminal, 'revoked')), ...starting.map(entry => entry.promise.then(() => {}, () => {}))]);
      if (cleanupFault || outcomes.some(result => result.status === 'rejected')) throw refused('terminal_cleanup_uncertain');
      for (const terminal of mine) forget(terminal);
      if (mine.length) log.info('revoked the terminals of a principal', { code: 'ALPD_TERMINAL_REVOKED', principal: principalId, closed: live.length });
      return { closed: live.length + newlyCancelled.length };
    },

    /** A connection closed: its terminals keep running for reconnectMs. */
    disconnect(sink: TerminalSink) {
      watchers.delete(sink);
      for (const terminal of terminals.values()) if (terminal.sink === sink) detach(terminal, 'disconnected');
    },

    sweep,

    /** alpd stops: every terminal ends (reason `shutdown`) and its tree is killed. */
    async shutdown() {
      closed = true;
      clearInterval(timer);
      const starting = [...pending.values()];
      for (const entry of starting) cancel(entry, 'terminal_unsupported');
      await Promise.all(starting.map(entry => entry.promise.then(() => {}, () => {})));
      const outcomes = await Promise.allSettled([...terminals.values()].map(terminal => terminal.exit ? terminal.reaped : end(terminal, 'shutdown')));
      for (const terminal of terminals.values()) terminal.screen.dispose();
      terminals.clear();
      watchers.clear();
      if (cleanupFault || outcomes.some(result => result.status === 'rejected')) throw refused('terminal_cleanup_uncertain');
    },

    /** Test hook: pids of every running terminal's shell. */
    pids() { return [...terminals.values()].filter(terminal => !terminal.exit).map(terminal => terminal.pid); },
  };
}
export type TerminalService = ReturnType<typeof createTerminalService>;
