import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from '@getpaseo/protocol/binary-frames/terminal';
import { TerminalInputModeTracker } from '@getpaseo/protocol/terminal-input-mode';
import { TERMINAL, type DaemonConnection } from '@anhlp/alp-protocol';
import type { TerminalEvent, TerminalInfo, TerminalLimits } from '@anhlp/alp-protocol/rpc';
import { alpHome, connect, readLock } from '@anhlp/alp-client/index';
import { frames, readTerminalConfig } from '@anhlp/alp-daemon/terminals';
import type { ClientContext, Handler } from './gateway.js';

/**
 * Terminals for the app (issue #121 H, ALPD §62): Paseo's terminal messages over alpd's
 * `terminal.*` (docs/protocol/alp-json-rpc-v1.md §12.10). A terminal is a real shell on this host
 * running as the account that runs alpd; its directory is only where it starts, never a sandbox.
 *
 * Paseo app devices paired through the relay act as the owner and never hold a gateway
 * `terminal.exec`, so the bridge offers terminals only when the host owner opted in twice: the
 * host switch (`allowRemoteTerminal`) and, for Paseo devices, `allowPaseoTerminal` (both in the
 * owner-private `<ALP_HOME>/terminal.json`, `alp terminal allow --paseo --yes`), and alpd's hello
 * lists `terminal`. It checks again at most every 5 s. Otherwise it makes no `terminal.*` call:
 * lists are empty, create and subscribe say why, input is dropped, kill fails.
 *
 * ALP picks the shell: a command, arguments or an agent from the app are refused. A workspace is a
 * registry workspace's own directory, exactly: never a directory inside it or outside the registry.
 *
 * alpd lets one connection stream a terminal, so the bridge attaches each terminal once, on its own
 * connection, keeps a copy of alpd's replay ring, and fans the output out to every app client
 * through that client's slots (0-255) as Paseo's binary frames: a subscribe is answered first,
 * then one Restore frame with what the ring holds, then one Output frame restoring the input modes,
 * then live Output frames. The bridge stays attached while nobody watches, so a terminal outlives
 * an app that went away, as Paseo's do, until it exits or alpd ends it.
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;
type PaseoTerminal = Extract<Outbound, { type: 'list_terminals_response' }>['payload']['terminals'][number];

/** A live registry workspace, as `registry.owner` has it. */
export type TerminalWorkspace = { id: string; directory: string; createdAt?: string };

export const TERMINALS_OFF = 'Terminals are off on this host; its owner enables them for Paseo devices with: alp terminal allow --paseo --yes. '
  + 'A terminal runs a shell as the account that runs ALP: its directory is not a sandbox.';
const SHELL_ONLY = 'ALP starts the host account\'s own shell: a command, arguments or an agent are not accepted. '
  + 'The terminal\'s directory is where it starts, not a sandbox.';
const REPLACED = 'This terminal was opened in another ALP client; open it again here to take it back';
const LOST = 'The ALP daemon went away; this terminal is no longer shown';
const GAP = '\r\n\x1b[2m[ALP: some output of this terminal is no longer kept]\x1b[0m\r\n';

const CHECK_MS = 5_000;
const POLL_MS = 5_000;
const RETRY_MS = 1_000;
const DRAIN_MS = 200;
/** A client with more than this waiting on its socket gets no live output until it drains. */
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const SLOTS = 256;
const MAX_PENDING_SIZES = 256;

type Sub = { client: ClientContext; slot: number; lagging: boolean };
type Stream = {
  id: string; workspaceId: string; cwd: string; title: string;
  conn?: DaemonConnection;
  state: 'attaching' | 'attached' | 'detached';
  ready?: Promise<void>;
  /** Events that arrived while the attach was answered: applied after it, behind a gap marker. */
  pending?: TerminalEvent[];
  ring: string[]; ringBytes: number; lastSeq: number;
  tracker: TerminalInputModeTracker;
  subs: Map<ClientContext, Sub>;
  size?: { cols: number; rows: number };
  owner?: ClientContext;
  input: Promise<void>;
};
type DirectorySub = { cwd: string; workspaceId?: string; last?: string };

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const sizeOf = (size: { cols?: unknown; rows?: unknown } | undefined) => ({
  cols: clamp(size?.cols, TERMINAL.minCols, TERMINAL.maxCols, 80),
  rows: clamp(size?.rows, TERMINAL.minRows, TERMINAL.maxRows, 24),
});
const defaults = (): TerminalLimits => ({
  maxPerPrincipal: TERMINAL.maxPerPrincipal, maxPerDaemon: TERMINAL.maxPerDaemon, maxInputBytes: TERMINAL.maxInputBytes,
  maxOutputFrameBytes: TERMINAL.maxOutputFrameBytes, replayBytes: TERMINAL.replayBytes, idleMs: TERMINAL.idleMs,
  maxLifetimeMs: TERMINAL.maxLifetimeMs, reconnectMs: TERMINAL.reconnectMs,
});

class Refused extends Error {}

export function createTerminals({
  workspaces: readWorkspaces, home = alpHome(), connect: connectTo, log = () => {}, archiveAgent = async () => { throw new Error('Agent archives are unavailable'); }, timing = {},
}: {
  /** The live registry workspaces (not archived, project not removed); read from alpd by default. */
  workspaces?: () => Promise<TerminalWorkspace[]>;
  /** ALP's home, whose terminal.json holds the host switch. */
  home?: string;
  /** A new connection to alpd, used for terminals only; defaults to its socket through the lock. */
  connect?: () => Promise<DaemonConnection>;
  log?: (message: string) => void;
  /** Archives a known ALP root through the agents facade; independent of terminal opt-in. */
  archiveAgent?: (agentId: string) => Promise<{ agentId: string; archivedAt: string }>;
  /** Shorter intervals for tests. */
  timing?: { checkMs?: number; pollMs?: number; retryMs?: number; drainMs?: number };
}) {
  const checkMs = timing.checkMs ?? CHECK_MS;
  const pollMs = timing.pollMs ?? POLL_MS;
  const retryMs = timing.retryMs ?? RETRY_MS;
  const drainMs = timing.drainMs ?? DRAIN_MS;
  const features: Record<string, boolean> = {
    'terminal-restore-modes': true, 'terminal-input-mode-replay': true, 'terminal-size-ownership': true, workspaceTerminals: false,
  };
  const streams = new Map<string, Stream>();
  /** Each client's slots: slot → terminal id. */
  const slots = new Map<ClientContext, Map<number, string>>();
  const directories = new Map<ClientContext, Map<string, DirectorySub>>();
  /** A size the app claimed before it subscribed (alpd resizes only an attached terminal). */
  const pendingSizes = new Map<string, { client: ClientContext; cols: number; rows: number }>();
  let gate = { at: -Infinity, on: false, limits: defaults() };
  let checking: Promise<boolean> | undefined;
  let conn: Promise<DaemonConnection> | undefined;
  let live: DaemonConnection | undefined;
  let closed = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let gateTimer: NodeJS.Timeout | undefined;
  let reconnecting: Promise<void> | undefined;
  let refreshing: Promise<void> | undefined;
  let again = false;
  const workspaces = readWorkspaces ?? (async (): Promise<TerminalWorkspace[]> => {
    const { registry } = await (await daemon()).request('registry.owner', {});
    const removed = new Set((registry?.projects ?? []).filter((project: any) => project.removedAt).map((project: any) => project.id));
    return (registry?.workspaces ?? []).filter((entry: any) => !entry.archivedAt && !removed.has(entry.projectId));
  });

  // ── alpd ────────────────────────────────────────────────────────────────────────────────────
  async function open(): Promise<DaemonConnection> {
    const connection = connectTo ? await connectTo() : await (async () => {
      const lock = await readLock(home);
      if (!lock?.ready) throw new Error('ALP daemon is not running');
      return connect(lock.socket, { name: 'alp-paseo-terminals', version: '1' }) as Promise<DaemonConnection>;
    })();
    if (closed) { connection.close(); throw new Error('closed'); }
    if (!connection.onNotification) { connection.close(); throw new Error('This ALP daemon connection carries no terminal events'); }
    connection.onNotification((method, params) => { if (method === 'terminal.event') event(connection, params as TerminalEvent); });
    connection.onClose(() => lost(connection));
    live = connection;
    return connection;
  }
  function daemon() {
    conn ??= open().catch(error => { conn = undefined; throw error; });
    return conn;
  }
  function drop(connection: DaemonConnection | undefined) {
    if (!connection) return;
    if (live === connection) { live = undefined; conn = undefined; }
    try { connection.close(); } catch {}
  }

  /** The host switch, Paseo's opt-in and alpd's capability, at most every checkMs. */
  function available(): Promise<boolean> {
    if (closed) return Promise.resolve(false);
    if (Date.now() - gate.at < checkMs) return Promise.resolve(gate.on);
    checking ??= check().finally(() => { checking = undefined; });
    return checking;
  }
  async function check() {
    let on = false;
    let limits = gate.limits;
    let reachable = true;
    try {
      const config = await readTerminalConfig(home);
      limits = config.limits;
      if (config.enabled && config.paseo) {
        try {
          const connection = await daemon();
          if (connection.capabilities !== undefined && (connection.terminalLimits !== undefined || !connection.capabilities.includes('terminal'))) {
            on = connection.capabilities.includes('terminal');
            if (connection.terminalLimits && typeof connection.terminalLimits === 'object') limits = { ...limits, ...connection.terminalLimits };
          } else {
            const hello = await connection.request('daemon.hello', { protocolVersion: 1 });
            on = Array.isArray(hello?.capabilities) && hello.capabilities.includes('terminal');
            if (hello?.terminalLimits && typeof hello.terminalLimits === 'object') limits = { ...limits, ...hello.terminalLimits };
          }
        } catch (error: any) {
          reachable = false;
          log(`terminals: ALP daemon not reachable: ${error?.message ?? error}`);
        }
      }
    } catch (error: any) {
      log(`terminals: terminal.json not read: ${error?.message ?? error}`);
    }
    const was = gate.on;
    gate = { at: Date.now(), on, limits };
    features.workspaceTerminals = on;
    // Off (not merely unreachable: a reconnect follows that): every stream ends, the connection goes.
    if (!on && reachable && (was || streams.size)) shutdown(TERMINALS_OFF);
    return on;
  }

  function lost(connection: DaemonConnection) {
    if (live === connection) { live = undefined; conn = undefined; }
    let any = false;
    for (const stream of streams.values()) {
      if (stream.conn !== connection) continue;
      stream.conn = undefined;
      stream.state = 'detached';
      stream.pending = undefined;
      any = true;
    }
    if (any && !closed) reconnect();
  }
  /** alpd went away: attach every stream again within reconnectMs, else end it. */
  function reconnect() {
    if (reconnecting) return;
    const deadline = Date.now() + gate.limits.reconnectMs;
    reconnecting = (async () => {
      while (!closed) {
        const waiting = [...streams.values()].filter(stream => stream.state === 'detached');
        if (!waiting.length) return;
        if (Date.now() >= deadline) { for (const stream of waiting) end(stream, LOST); return; }
        await new Promise(resolve => setTimeout(resolve, retryMs).unref?.());
        try {
          await daemon();
          // Back: the next request reads the switch and alpd's capability again.
          gate.at = -Infinity;
          if (!await available()) return;
          for (const stream of waiting) if (streams.get(stream.id) === stream && stream.state === 'detached') await reattach(stream);
        } catch (error: any) {
          log(`terminals: reconnect failed: ${error?.message ?? error}`);
        }
      }
    })().finally(() => { reconnecting = undefined; });
  }

  // ── Streams ─────────────────────────────────────────────────────────────────────────────────
  function stream(info: TerminalInfo, workspace: TerminalWorkspace): Stream {
    const made: Stream = {
      id: info.terminalId, workspaceId: workspace.id, cwd: workspace.directory, title: info.title, state: 'detached',
      ring: [], ringBytes: 0, lastSeq: 0, tracker: new TerminalInputModeTracker(), subs: new Map(), input: Promise.resolve(),
    };
    const claimed = pendingSizes.get(made.id);
    if (claimed) { pendingSizes.delete(made.id); made.size = { cols: claimed.cols, rows: claimed.rows }; made.owner = claimed.client; }
    streams.set(made.id, made);
    // While a stream is open the switch is read again even if no request comes: output stops too.
    gateTimer ??= setInterval(() => {
      if (!streams.size) { clearInterval(gateTimer); gateTimer = undefined; return; }
      void available();
    }, Math.max(checkMs, 100));
    gateTimer.unref?.();
    return made;
  }

  /** Attaches (again) after the last seq seen: alpd replays what its ring still has, then answers. */
  function attach(target: Stream) {
    target.ready = (async () => {
      const connection = await daemon();
      if (streams.get(target.id) !== target) return;
      target.conn = connection;
      target.state = 'attaching';
      target.pending = [];
      try {
        const result = await connection.request('terminal.attach', { terminalId: target.id, after: target.lastSeq });
        if (target.conn !== connection || streams.get(target.id) !== target) return;
        const events = target.pending ?? [];
        target.pending = undefined;
        target.state = 'attached';
        if (typeof result?.terminal?.title === 'string') target.title = result.terminal.title;
        if (result?.gap) output(target, GAP);
        for (const pending of events) apply(target, pending);
        if (streams.get(target.id) !== target) return;
        if (result?.terminal?.state === 'exited') { end(target); return; }
        resize(target);
      } catch (error) {
        if (target.conn === connection) { target.state = 'detached'; target.pending = undefined; target.conn = undefined; }
        throw error;
      }
    })();
    return target.ready;
  }
  async function reattach(target: Stream) {
    try { await attach(target); } catch (error: any) {
      if (error?.code === 1001) end(target, 'This terminal has ended');
      else log(`terminals: attach ${target.id} failed: ${error?.message ?? error}`);
    }
  }

  function event(connection: DaemonConnection, params: TerminalEvent) {
    const target = params && streams.get(params.terminalId);
    if (!target || target.conn !== connection) return;
    if (target.pending) target.pending.push(params);
    else apply(target, params);
  }
  function apply(target: Stream, params: TerminalEvent) {
    if (params.type === 'output') {
      if (params.seq <= target.lastSeq || typeof params.data !== 'string') return;
      target.lastSeq = params.seq;
      output(target, params.data);
    } else if (params.type === 'exit') {
      target.lastSeq = Math.max(target.lastSeq, params.seq);
      end(target);
    } else if (params.type === 'detached') {
      if (params.reason === 'replaced') { target.conn = undefined; end(target, REPLACED); return; }
      // slow_consumer: the bridge fell behind; it attaches again after the last seq it has.
      target.state = 'detached';
      target.conn = undefined;
      void reattach(target);
    }
  }

  /** Output: into the ring's copy, the input-mode tracker, and every client keeping up. */
  function output(target: Stream, data: string) {
    target.ring.push(data);
    target.ringBytes += Buffer.byteLength(data);
    trim(target);
    target.tracker.feed(data);
    for (const sub of target.subs.values()) {
      if (sub.lagging) continue;
      if (sub.client.buffered() > HIGH_WATER) { lag(sub); continue; }
      sub.client.emitBinary(encodeTerminalStreamFrame({ opcode: TerminalStreamOpcode.Output, slot: sub.slot, payload: data }));
    }
  }
  function trim(target: Stream) {
    const max = gate.limits.replayBytes;
    while (target.ringBytes > max && target.ring.length > 1) target.ringBytes -= Buffer.byteLength(target.ring.shift()!);
    if (target.ringBytes > max) {
      // One piece larger than the ring: keep its end, whole characters only.
      const bytes = Buffer.from(target.ring[0]);
      const kept = bytes.subarray(bytes.length - max).toString('utf8').replace(/^�+/, '');
      target.ring[0] = kept;
      target.ringBytes = Buffer.byteLength(kept);
    }
  }
  /** What a client sees on subscribe and after it drained: the ring's copy, then the input modes. */
  function restore(target: Stream, sub: Sub) {
    const replay = target.ring.join('');
    if (replay) sub.client.emitBinary(encodeTerminalStreamFrame({ opcode: TerminalStreamOpcode.Restore, slot: sub.slot, payload: replay }));
    const preamble = target.tracker.getPreamble();
    if (preamble) sub.client.emitBinary(encodeTerminalStreamFrame({ opcode: TerminalStreamOpcode.Output, slot: sub.slot, payload: preamble }));
  }
  function lag(sub: Sub) {
    sub.lagging = true;
    drainTimer ??= setInterval(drain, drainMs);
    drainTimer.unref?.();
  }
  function drain() {
    let waiting = false;
    for (const target of streams.values()) for (const sub of target.subs.values()) {
      if (!sub.lagging) continue;
      if (sub.client.buffered() > LOW_WATER) { waiting = true; continue; }
      sub.lagging = false;
      restore(target, sub);
    }
    if (!waiting && drainTimer) { clearInterval(drainTimer); drainTimer = undefined; }
  }

  /** A stream ends for every client: exited, closed, replaced, lost, or terminals turned off. */
  function end(target: Stream, error?: string) {
    if (streams.get(target.id) !== target) return;
    streams.delete(target.id);
    for (const sub of target.subs.values()) {
      slots.get(sub.client)?.delete(sub.slot);
      sub.client.emit({ type: 'terminal_stream_exit', payload: { terminalId: target.id, ...(error ? { error } : {}) } });
    }
    target.subs.clear();
    changed();
  }
  /** A stream whose attach failed and nobody watches is not kept. */
  function forget(target: Stream) {
    if (streams.get(target.id) === target && target.state === 'detached' && !target.subs.size) streams.delete(target.id);
  }
  /**
   * Terminals are off for Paseo: every stream ends, and every shell the bridge holds is closed in
   * alpd (best effort) before its connection goes, so none keeps running for alpd's reconnect time.
   */
  function shutdown(error: string) {
    const closing = [...streams.values()].map(target => target.conn?.request('terminal.close', { terminalId: target.id })
      .catch((failure: any) => log(`terminals: close ${target.id} failed: ${failure?.message ?? failure}`)));
    for (const target of [...streams.values()]) end(target, error);
    pendingSizes.clear();
    // The connection is no longer the bridge's from now on: a new stream opens another one.
    const connection = live;
    if (connection) { live = undefined; conn = undefined; }
    const settled = Promise.allSettled(closing);
    void Promise.race([settled, new Promise(resolve => setTimeout(resolve, 5_000).unref?.())]).then(() => { try { connection?.close(); } catch {} });
    changed();
  }

  function resize(target: Stream) {
    if (!target.size || target.state !== 'attached' || !target.conn) return;
    const { cols, rows } = target.size;
    target.conn.request('terminal.resize', { terminalId: target.id, cols, rows })
      .catch((error: any) => log(`terminals: resize ${target.id} failed: ${error?.message ?? error}`));
  }

  // ── Workspaces and lists ────────────────────────────────────────────────────────────────────
  /** The workspace a cwd (and maybe a workspace id) names: exactly its directory, never inside it. */
  function workspaceOf(all: TerminalWorkspace[], cwd: unknown, workspaceId?: unknown): TerminalWorkspace {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Refused('A terminal starts in a workspace\'s directory, given as an absolute path');
    const directory = path.resolve(cwd);
    if (workspaceId !== undefined) {
      const entry = all.find(workspace => workspace.id === workspaceId);
      if (!entry) throw new Refused('No such workspace');
      if (entry.directory !== directory) throw new Refused('That directory is not the workspace\'s own directory');
      return entry;
    }
    const entry = all.filter(workspace => workspace.directory === directory)
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))[0];
    if (!entry) throw new Refused('That directory is not a workspace of ALP\'s registry');
    return entry;
  }
  async function running() {
    const connection = await daemon();
    const [{ terminals }, all] = await Promise.all([connection.request('terminal.list', {}), workspaces()]);
    const byId = new Map(all.map(workspace => [workspace.id, workspace]));
    return { all, terminals: (terminals as TerminalInfo[]).filter(info => info.state === 'running' && byId.has(info.workspaceId)).map(info => ({ info, workspace: byId.get(info.workspaceId)! })) };
  }
  const paseo = (info: TerminalInfo, workspace: TerminalWorkspace) => ({ id: info.terminalId, name: info.title, cwd: workspace.directory, workspaceId: workspace.id, title: info.title });
  /** Terminals of one directory subscription; none when it names no workspace. */
  function listed(state: Awaited<ReturnType<typeof running>>, cwd: string, workspaceId?: string) {
    let workspace: TerminalWorkspace;
    try { workspace = workspaceOf(state.all, cwd, workspaceId); } catch { return []; }
    return state.terminals.filter(entry => entry.workspace.id === workspace.id).map(({ info }) => {
      const { cwd: _cwd, ...rest } = paseo(info, workspace);
      return rest;
    });
  }
  async function find(terminalId: string) {
    const state = await running();
    return state.terminals.find(entry => entry.info.terminalId === terminalId);
  }

  /** Something the bridge did changed the terminals: tell every directory subscription now. */
  function changed() {
    if (!directories.size) return;
    if (refreshing) { again = true; return; }
    refreshing = refresh().catch(error => log(`terminals: list failed: ${error?.message ?? error}`)).finally(() => {
      refreshing = undefined;
      if (again) { again = false; changed(); }
    });
  }
  async function refresh() {
    const on = await available();
    const state = on ? await running() : undefined;
    for (const [client, subs] of directories) for (const sub of subs.values()) {
      const terminals = state ? listed(state, sub.cwd, sub.workspaceId) : [];
      const text = JSON.stringify(terminals);
      if (text === sub.last) continue;
      sub.last = text;
      client.emit({ type: 'terminals_changed', payload: { cwd: sub.cwd, ...(sub.workspaceId ? { workspaceId: sub.workspaceId } : {}), terminals } });
    }
  }
  /** ALP has no list-change event: while a directory is watched, the list is read every pollMs. */
  function poll() {
    if (directories.size && !pollTimer) {
      pollTimer = setInterval(changed, pollMs);
      pollTimer.unref?.();
    } else if (!directories.size && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  function slotFor(client: ClientContext, terminalId: string) {
    const used = slots.get(client) ?? new Map<number, string>();
    slots.set(client, used);
    for (const [slot, id] of used) if (id === terminalId) return slot;
    for (let slot = 0; slot < SLOTS; slot++) if (!used.has(slot)) { used.set(slot, terminalId); return slot; }
    return undefined;
  }
  function unsubscribe(client: ClientContext, terminalId: string) {
    const target = streams.get(terminalId);
    const sub = target?.subs.get(client);
    if (target && sub) { target.subs.delete(client); slots.get(client)?.delete(sub.slot); }
    if (target?.owner === client) target.owner = undefined;
  }

  async function close(terminalId: string) {
    if (!await available()) return false;
    const entry = streams.get(terminalId) ?? (await find(terminalId));
    if (!entry) return false;
    try {
      await (await daemon()).request('terminal.close', { terminalId });
    } catch (error: any) {
      log(`terminals: close ${terminalId} failed: ${error?.message ?? error}`);
      return false;
    }
    const target = streams.get(terminalId);
    if (target) end(target);
    else changed();
    return true;
  }

  const handlers: Record<string, Handler> = {
    async list_terminals_request(message: Inbound<'list_terminals_request'>) {
      const reply = (terminals: PaseoTerminal[]) =>
        ({ type: 'list_terminals_response', payload: { requestId: message.requestId, ...(message.cwd ? { cwd: message.cwd } : {}), terminals } }) satisfies Outbound;
      if (!await available()) return reply([]);
      const state = await running();
      if (message.cwd === undefined && message.workspaceId === undefined) return reply(state.terminals.map(({ info, workspace }) => paseo(info, workspace)));
      if (message.cwd === undefined) {
        return reply(state.terminals.filter(entry => entry.workspace.id === message.workspaceId).map(({ info, workspace }) => paseo(info, workspace)));
      }
      let workspace: TerminalWorkspace;
      try { workspace = workspaceOf(state.all, message.cwd, message.workspaceId); } catch { return reply([]); }
      return reply(state.terminals.filter(entry => entry.workspace.id === workspace.id).map(({ info }) => paseo(info, workspace)));
    },

    async subscribe_terminals_request(message: Inbound<'subscribe_terminals_request'>, client) {
      const subs = directories.get(client) ?? new Map<string, DirectorySub>();
      directories.set(client, subs);
      const sub: DirectorySub = { cwd: message.cwd, ...(message.workspaceId ? { workspaceId: message.workspaceId } : {}) };
      subs.set(`${message.cwd}\0${message.workspaceId ?? ''}`, sub);
      poll();
      let terminals: ReturnType<typeof listed> = [];
      try { if (await available()) terminals = listed(await running(), message.cwd, message.workspaceId); } catch (error: any) {
        log(`terminals: list failed: ${error?.message ?? error}`);
      }
      sub.last = JSON.stringify(terminals);
      return { type: 'terminals_changed', payload: { ...(message.requestId ? { requestId: message.requestId } : {}), cwd: message.cwd, ...(message.workspaceId ? { workspaceId: message.workspaceId } : {}), terminals } } satisfies Outbound;
    },

    unsubscribe_terminals_request(message: Inbound<'unsubscribe_terminals_request'>, client) {
      const subs = directories.get(client);
      subs?.delete(`${message.cwd}\0${message.workspaceId ?? ''}`);
      if (subs && !subs.size) directories.delete(client);
      poll();
    },

    async create_terminal_request(message: Inbound<'create_terminal_request'>, client) {
      const reply = (fields: { terminal: PaseoTerminal & { cwd: string } | null; error: string | null }) =>
        ({ type: 'create_terminal_response', payload: { requestId: message.requestId, ...fields } }) satisfies Outbound;
      if (!await available()) return reply({ terminal: null, error: TERMINALS_OFF });
      if (message.command !== undefined || message.args !== undefined || message.agentId !== undefined) return reply({ terminal: null, error: SHELL_ONLY });
      let made: Stream | undefined;
      try {
        const workspace = workspaceOf(await workspaces(), message.cwd, message.workspaceId);
        const { cols, rows } = sizeOf(message.size);
        const connection = await daemon();
        const { terminal } = await connection.request('terminal.create', { workspaceId: workspace.id, cols, rows, requestId: `paseo:${createHash('sha256').update(`${client.clientId}\0${message.requestId}`).digest('hex')}` });
        const info = terminal as TerminalInfo;
        made = streams.get(info.terminalId) ?? stream(info, workspace);
        if (made.state === 'detached') await attach(made);
        changed();
        return reply({ terminal: paseo(info, workspace), error: null });
      } catch (error: any) {
        if (made) forget(made);
        return reply({ terminal: null, error: error instanceof Refused ? error.message : String(error?.message ?? error) });
      }
    },

    async subscribe_terminal_request(message: Inbound<'subscribe_terminal_request'>, client) {
      const fail = (error: string) => ({ type: 'subscribe_terminal_response', payload: { terminalId: message.terminalId, error, requestId: message.requestId } }) satisfies Outbound;
      if (!await available()) return fail(TERMINALS_OFF);
      let target = streams.get(message.terminalId);
      try {
        if (!target) {
          const entry = await find(message.terminalId);
          if (!entry) return fail('No such terminal');
          target = streams.get(message.terminalId) ?? stream(entry.info, entry.workspace);
        }
        if (target.state === 'detached') await attach(target);
        else if (target.state === 'attaching') await target.ready;
      } catch (error: any) {
        if (target) forget(target);
        return fail(String(error?.message ?? error));
      }
      if (streams.get(target.id) !== target) return fail('This terminal has ended');
      const slot = slotFor(client, target.id);
      if (slot === undefined) return fail('Too many terminals are open on this device');
      // The client registers the slot from this answer: it goes first, then the frames.
      client.emit({ type: 'subscribe_terminal_response', payload: { terminalId: target.id, slot, error: null, requestId: message.requestId } } satisfies Outbound);
      const sub: Sub = target.subs.get(client) ?? { client, slot, lagging: false };
      sub.lagging = false;
      target.subs.set(client, sub);
      restore(target, sub);
    },

    unsubscribe_terminal_request(message: Inbound<'unsubscribe_terminal_request'>, client) {
      unsubscribe(client, message.terminalId);
    },

    terminal_input(message: Inbound<'terminal_input'>, client) {
      const input = message.message;
      const target = streams.get(message.terminalId);
      if (input?.type === 'resize') {
        const { cols, rows } = sizeOf(input);
        if (!target) {
          // Before subscribe: kept for the attach, which alpd needs first.
          if (pendingSizes.size >= MAX_PENDING_SIZES && !pendingSizes.has(message.terminalId)) return;
          const kept = pendingSizes.get(message.terminalId);
          if (input.intent === 'update' && kept && kept.client !== client) return;
          pendingSizes.set(message.terminalId, { client, cols, rows });
          return;
        }
        if (input.intent === 'update' && target.owner && target.owner !== client) return;
        target.owner = client;
        target.size = { cols, rows };
        resize(target);
        return;
      }
      if (input?.type !== 'input' || typeof input.data !== 'string' || !input.data || !target || !target.subs.has(client)) return;
      // In order, in pieces alpd accepts, whole characters each; dropped while terminals are off.
      target.input = target.input.then(async () => {
        if (!await available() || streams.get(target.id) !== target || target.state !== 'attached' || !target.conn) return;
        for (const piece of frames(input.data, gate.limits.maxInputBytes)) await target.conn.request('terminal.input', { terminalId: target.id, data: piece });
      }).catch((error: any) => log(`terminals: input to ${target.id} failed: ${error?.message ?? error}`));
    },

    async kill_terminal_request(message: Inbound<'kill_terminal_request'>) {
      let success = false;
      try { success = await close(message.terminalId); } catch (error: any) { log(`terminals: kill failed: ${error?.message ?? error}`); }
      return { type: 'kill_terminal_response', payload: { terminalId: message.terminalId, success, requestId: message.requestId } } satisfies Outbound;
    },

    async close_items_request(message: Inbound<'close_items_request'>) {
      const terminals: { terminalId: string; success: boolean }[] = [];
      for (const terminalId of message.terminalIds ?? []) {
        let success = false;
        try { success = await close(terminalId); } catch (error: any) { log(`terminals: close failed: ${error?.message ?? error}`); }
        terminals.push({ terminalId, success });
      }
      // Paseo reports only successful agent archives; one failure must not hide other results.
      const agents: { agentId: string; archivedAt: string }[] = [];
      for (const agentId of message.agentIds ?? []) {
        try { agents.push(await archiveAgent(agentId)); }
        catch (error: any) { log(`agents: archive ${agentId} failed: ${error?.message ?? error}`); }
      }
      return { type: 'close_items_response', payload: { agents, terminals, requestId: message.requestId } } satisfies Outbound;
    },

    'terminal.rename.request': (message: Inbound<'terminal.rename.request'>) =>
      ({ type: 'terminal.rename.response', payload: { requestId: message.requestId, success: false, error: 'ALP cannot rename a terminal; the shell sets its title' } }) satisfies Outbound,
  };

  return {
    handlers,
    /** Mutated in place: workspaceTerminals follows the host switch at every check. */
    features,
    /** Checks the switch now (within checkMs), so the next server_info says whether terminals are on. */
    refresh: () => available(),
    /** A client left: its slots, subscriptions and size claims go; the terminals keep running. */
    drop(client: ClientContext) {
      for (const target of streams.values()) {
        target.subs.delete(client);
        if (target.owner === client) target.owner = undefined;
      }
      slots.delete(client);
      directories.delete(client);
      for (const [id, kept] of pendingSizes) if (kept.client === client) pendingSizes.delete(id);
      poll();
    },
    close() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (drainTimer) clearInterval(drainTimer);
      if (gateTimer) clearInterval(gateTimer);
      pollTimer = drainTimer = gateTimer = undefined;
      streams.clear();
      directories.clear();
      drop(live);
    },
  };
}

export type Terminals = ReturnType<typeof createTerminals>;
