// @ts-check
import { TERMINAL, isTerminalId } from '@anhlp/alp-protocol';
import { can } from './gateway.js';
import { registryWorkspaceOf } from './git.js';
import { describe } from './errors.js';

/**
 * The Terminal panel's logic (docs/protocol/alp-json-rpc-v1.md §12.10, issue #121 H), without the
 * DOM: one real shell on the daemon host per workspace tab, through the gateway. The view (xterm.js)
 * writes what `onOutput` gives it and passes keystrokes to `input` and its size to `resize`.
 *
 * - Opening the tab creates a terminal for the workspace (a registry workspaceId), attaches, and
 *   streams output; the id is kept for the page (sessionStorage), so a reload attaches the same
 *   terminal again from the start of the host's replay ring.
 * - Keystrokes are batched: one terminal.input at a time, in order, each at most `maxInputBytes`
 *   UTF-8 bytes; what is typed meanwhile goes with the next one. Nothing is sent again by itself:
 *   input a dropped connection may have lost is said so.
 * - Size changes are debounced into one terminal.resize.
 * - Events carry a `seq`: a replay never shows output twice, a reconnect attaches again with
 *   `after` = the last seq seen, and output the host no longer holds (an attach's `gap`, or a jump)
 *   shows as an "[output lost: …]" line.
 * - `exit` ends input and says how; `detached` `replaced` (another client took the stream) offers
 *   Reattach; `slow_consumer` attaches again by itself.
 */

/** What the panel says when it cannot offer a terminal: never a terminal that cannot work. */
export const TERMINAL_MESSAGES = Object.freeze({
  capability: 'The host has not allowed remote terminals (its owner runs: alp terminal allow --yes)',
  permission: 'Your access token cannot open terminals (it needs terminal.exec)',
  workspace: 'Open a workspace to use a terminal.',
  registry: 'This host does not list its workspaces, so it cannot open a terminal here. Update ALP on the host.',
  loading: 'Loading the host\'s workspaces…',
  unregistered: 'This workspace is not in the host\'s workspace list, so a terminal cannot open here.',
  offline: 'Not connected to the host.',
});

/** The honesty notice (the user's product decision): where the shell runs, and that nothing confines it. */
export const TERMINAL_NOTICE = 'This shell runs on the daemon host as the account that runs alpd. The workspace is not a sandbox: the shell can read and write anything that account can, and use the network.';
/** The same, as the panel's persistent header line. */
export const TERMINAL_HEADER = 'Runs on the daemon host as the account that runs alpd · the workspace is not a sandbox';

/** alpd's terminal refusals, for people (§12.10 reasons). */
const REFUSALS = /** @type {Record<string, string>} */ ({
  terminal_disabled: TERMINAL_MESSAGES.capability,
  terminal_unsupported: 'Terminals are not available on the daemon host (Windows, or its PTY module did not load).',
  terminal_limit: 'Too many terminals are open on the host. Close one and try again.',
  input_too_large: 'That input was too large for the terminal.',
});

const END_REASONS = /** @type {Record<string, string>} */ ({
  closed: 'closed',
  idle: 'ended after being idle',
  lifetime: 'reached its maximum lifetime',
  detached: 'nobody reattached in time',
  revoked: 'access was revoked',
  disabled: 'the host turned terminals off',
  shutdown: 'the host stopped',
});

/**
 * "Process exited (code N / reason)": the exit code or signal, and why it ended when that was not
 * the shell ending by itself.
 * @param {{ exitCode?: number | null, signal?: number | null, reason?: string }} exit
 */
export function exitText(exit) {
  const parts = [];
  if (Number.isSafeInteger(exit.exitCode)) parts.push(`code ${exit.exitCode}`);
  if (Number.isSafeInteger(exit.signal) && exit.signal) parts.push(`signal ${exit.signal}`);
  if (exit.reason && exit.reason !== 'exited') parts.push(END_REASONS[exit.reason] ?? exit.reason);
  return parts.length ? `Process exited (${parts.join(' / ')})` : 'Process exited';
}

/** The line written where output was lost. @param {number} fromSeq @param {number} toSeq */
export const gapMarker = (fromSeq, toSeq) => {
  const count = toSeq - fromSeq + 1;
  return `\r\n\x1b[2m[output lost: ${count} output ${count === 1 ? 'event' : 'events'} (#${fromSeq}${count > 1 ? `–${toSeq}` : ''}) are no longer kept by the host]\x1b[0m\r\n`;
};

/**
 * The terminal limits of a connection: the hello's `terminalLimits`, never above TERMINAL; absent
 * or malformed values take TERMINAL's.
 * @param {unknown} raw
 * @returns {import('@anhlp/alp-protocol').TerminalLimits}
 */
export function terminalLimits(raw) {
  const source = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' ? raw : {});
  /** @param {'maxPerPrincipal' | 'maxPerDaemon' | 'maxInputBytes' | 'maxOutputFrameBytes' | 'replayBytes' | 'idleMs' | 'maxLifetimeMs' | 'reconnectMs'} key */
  const pick = key => {
    const value = source[key];
    return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 1 ? Math.min(/** @type {number} */ (value), TERMINAL[key]) : TERMINAL[key];
  };
  return {
    maxPerPrincipal: pick('maxPerPrincipal'), maxPerDaemon: pick('maxPerDaemon'), maxInputBytes: pick('maxInputBytes'),
    maxOutputFrameBytes: pick('maxOutputFrameBytes'), replayBytes: pick('replayBytes'), idleMs: pick('idleMs'),
    maxLifetimeMs: pick('maxLifetimeMs'), reconnectMs: pick('reconnectMs'),
  };
}

/**
 * Whether this page may offer a terminal here: every reason it may not, in the order the panel
 * shows them (the host's switch, the token's permission, then the workspace), or the registry
 * workspace to open it in.
 * @param {{ connection: { phase: string, capabilities: string[] }, principal: import('./gateway.js').Principal | null, workspace: string | null, registry: { workspaces: import('@anhlp/alp-protocol').RegistryWorkspace[], loading?: boolean } }} state
 * @returns {{ ok: true, workspaceId: string } | { ok: false, reasons: Array<keyof typeof TERMINAL_MESSAGES>, messages: string[] }}
 */
export function terminalGate(state) {
  /** @type {Array<keyof typeof TERMINAL_MESSAGES>} */
  const reasons = [];
  if (!state.workspace) reasons.push('workspace');
  else if (state.connection.phase !== 'open' && !state.connection.capabilities.length) reasons.push('offline');
  else {
    if (!state.connection.capabilities.includes('terminal')) reasons.push('capability');
    if (!can(state.principal ?? undefined, 'terminal.exec')) reasons.push('permission');
    if (!reasons.length) {
      if (!state.connection.capabilities.includes('workspace.registry')) reasons.push('registry');
      else {
        const row = registryWorkspaceOf(/** @type {any} */ (state));
        if (row) return { ok: true, workspaceId: row.id };
        reasons.push(state.registry.loading ? 'loading' : 'unregistered');
      }
    }
  }
  return { ok: false, reasons, messages: reasons.map(reason => TERMINAL_MESSAGES[reason]) };
}

/**
 * Splits `text` at most `max` UTF-8 bytes in: [head, rest]. A character is never cut (a surrogate
 * pair stays whole); the head holds at least one character when `max` allows four bytes.
 * @param {string} text @param {number} max
 * @returns {[string, string]}
 */
export function splitUtf8(text, max) {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > max) break;
    bytes += size;
    index += code > 0xffff ? 2 : 1;
  }
  return [text.slice(0, index), text.slice(index)];
}

/** Clamps a size to §12.10's bounds. @param {number} cols @param {number} rows */
export function clampSize(cols, rows) {
  const fit = (/** @type {number} */ value, /** @type {number} */ min, /** @type {number} */ max) => Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value) : min));
  return { cols: fit(cols, TERMINAL.minCols, TERMINAL.maxCols), rows: fit(rows, TERMINAL.minRows, TERMINAL.maxRows) };
}

/**
 * @typedef {'idle' | 'starting' | 'attaching' | 'running' | 'reconnecting' | 'replaced' | 'exited' | 'gone' | 'failed' | 'closed'} TerminalStatus
 *   idle: not started yet. starting: terminal.create on its way. attaching: terminal.attach on its
 *   way (its replay is buffered). running: attached, input accepted. reconnecting: the connection
 *   dropped; attaches again once it is back. replaced: another client attached it. exited: the
 *   shell ended. gone: the host no longer knows it. failed: the host refused (`error`). closed:
 *   closed from this page.
 * @typedef {{
 *   status: TerminalStatus,
 *   terminalId?: string,
 *   exit?: { exitCode: number | null, signal: number | null, reason: string },
 *   error?: string,
 *   lost?: string,
 * }} TerminalView
 *   lost: input that may not have reached the shell, said once.
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} TerminalStorage
 * @typedef {{
 *   workspaceId: string,
 *   request: (method: string, params: Record<string, unknown>) => Promise<any>,
 *   limits?: import('@anhlp/alp-protocol').TerminalLimits,
 *   storage?: TerminalStorage,
 *   storageKey?: string,
 *   inputDelayMs?: number,
 *   resizeDelayMs?: number,
 *   maxHistoryChars?: number,
 *   newRequestId?: () => string,
 * }} TerminalOptions
 */

/** One terminal of a workspace tab. */
export class TerminalSession {
  /** @type {TerminalView} */ #view = { status: 'idle' };
  /** @type {Set<() => void>} */ #listeners = new Set();
  /** @type {Set<(text: string) => void>} */ #outputs = new Set();
  /** Output written so far, for a view that mounts later (capped, oldest dropped). @type {string[]} */ #history = [];
  #historyChars = 0;
  #lastSeq = 0;
  /** Events that arrived while an attach was on its way: its replay. @type {any[] | null} */ #buffer = null;
  /** The current attach or create, so a late answer of an older one does nothing. */
  #attempt = 0;
  /** A create whose answer was lost: repeated with the same requestId (alpd answers the same terminal). @type {string | null} */ #createId = null;
  #pending = '';
  #sending = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ #inputTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ #resizeTimer;
  /** The view's size, and the size the host last took. */
  #size = { cols: 80, rows: 24 };
  /** @type {{ cols: number, rows: number } | null} */ #sentSize = null;
  #connected = true;
  #options;

  /** @param {TerminalOptions} options */
  constructor(options) {
    this.#options = {
      limits: terminalLimits(undefined),
      inputDelayMs: 5,
      resizeDelayMs: 120,
      maxHistoryChars: TERMINAL.replayBytes,
      newRequestId: () => globalThis.crypto.randomUUID(),
      ...options,
    };
  }

  get workspaceId() { return this.#options.workspaceId; }
  /** @returns {TerminalView} */
  getState() { return this.#view; }
  get lastSeq() { return this.#lastSeq; }
  /** @param {() => void} listener */
  subscribe(listener) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  /** @param {(text: string) => void} listener */
  onOutput(listener) { this.#outputs.add(listener); return () => { this.#outputs.delete(listener); }; }
  /** Everything written so far (bounded), for a view that mounts now. */
  history() { return this.#history.join(''); }
  /** Whether input is taken now. */
  get accepting() { return this.#view.status === 'running'; }

  /** @param {Partial<TerminalView>} change */
  #set(change) {
    this.#view = { ...this.#view, ...change };
    for (const listener of [...this.#listeners]) listener();
  }

  /** @param {string} text */
  #write(text) {
    if (!text) return;
    this.#history.push(text);
    this.#historyChars += text.length;
    while (this.#historyChars > this.#options.maxHistoryChars && this.#history.length > 1) this.#historyChars -= /** @type {string} */ (this.#history.shift()).length;
    for (const listener of [...this.#outputs]) listener(text);
  }

  #stored() {
    const { storage, storageKey } = this.#options;
    try { const id = storage && storageKey ? storage.getItem(storageKey) : null; return isTerminalId(id) ? /** @type {string} */ (id) : undefined; } catch { return undefined; }
  }

  /** @param {string | undefined} id */
  #store(id) {
    const { storage, storageKey } = this.#options;
    if (!storage || !storageKey) return;
    try { if (id) storage.setItem(storageKey, id); else storage.removeItem(storageKey); } catch {}
  }

  /**
   * Opens the tab's terminal at the view's size: the one this page kept (a reload), else a new one.
   * Does nothing once started.
   * @param {number} [cols] @param {number} [rows]
   */
  start(cols, rows) {
    if (this.#view.status !== 'idle') return;
    if (cols !== undefined && rows !== undefined) this.#size = clampSize(cols, rows);
    const kept = this.#stored();
    if (kept) { this.#set({ terminalId: kept }); void this.#attach(0, true); }
    else void this.#create();
  }

  /** A new terminal in place of one that ended, was lost or refused. */
  restart() {
    const { status, terminalId } = this.#view;
    if (!['exited', 'gone', 'failed', 'closed'].includes(status)) return;
    // An exited terminal is kept by the host for a while: forget it there.
    if (terminalId && status === 'exited') this.#options.request('terminal.close', { terminalId }).catch(() => {});
    this.#store(undefined);
    this.#reset();
    this.#write('\x1bc');
    this.#history = [];
    this.#historyChars = 0;
    this.#view = { status: 'idle' };
    void this.#create();
  }

  #reset() {
    this.#attempt += 1;
    this.#lastSeq = 0;
    this.#buffer = null;
    this.#pending = '';
    this.#sentSize = null;
    this.#createId = null;
  }

  async #create() {
    const attempt = ++this.#attempt;
    this.#createId ??= this.#options.newRequestId();
    this.#set({ status: 'starting', error: undefined });
    let result;
    try {
      result = await this.#options.request('terminal.create', { workspaceId: this.#options.workspaceId, cols: this.#size.cols, rows: this.#size.rows, requestId: this.#createId });
    } catch (error) {
      if (attempt !== this.#attempt) return;
      const failure = describe(error);
      // Its outcome is unknown (the connection dropped): the same requestId again on reconnect.
      if (failure.sent !== 'yes') { this.#set({ status: 'reconnecting' }); if (this.#connected) this.#retrySoon(); return; }
      this.#createId = null;
      this.#set({ status: 'failed', error: refusal(error) });
      return;
    }
    if (attempt !== this.#attempt) return;
    const terminalId = result?.terminal?.terminalId;
    if (!isTerminalId(terminalId)) { this.#createId = null; this.#set({ status: 'failed', error: 'The host sent something this app does not understand.' }); return; }
    this.#createId = null;
    this.#sentSize = { cols: result.terminal.cols, rows: result.terminal.rows };
    this.#store(terminalId);
    this.#set({ terminalId });
    await this.#attach(0, false);
  }

  /** A create or attach whose request could not go out while connected: once more shortly. */
  #retrySoon() {
    setTimeout(() => { if (this.#connected && this.#view.status === 'reconnecting') this.connected(); }, 1000);
  }

  /**
   * Attaches this connection to the terminal after `after`: its replay is held until the answer, so
   * a gap's line comes before the output that follows it.
   * @param {number} after @param {boolean} kept the id came from this page's storage (a reload)
   */
  async #attach(after, kept) {
    const terminalId = /** @type {string} */ (this.#view.terminalId);
    const attempt = ++this.#attempt;
    this.#buffer = [];
    this.#set({ status: 'attaching', error: undefined });
    let result;
    try {
      result = await this.#options.request('terminal.attach', { terminalId, ...(after > 0 ? { after } : {}) });
    } catch (error) {
      if (attempt !== this.#attempt) return;
      this.#buffer = null;
      const failure = describe(error);
      if (failure.sent !== 'yes') { this.#set({ status: 'reconnecting' }); if (this.#connected) this.#retrySoon(); return; }
      if (failure.code === 1001) {
        this.#store(undefined);
        // A page that kept an id the host forgot (it ended meanwhile) opens a fresh terminal.
        if (kept && !this.#lastSeq) { this.#set({ terminalId: undefined }); void this.#create(); return; }
        this.#set({ status: 'gone', error: 'This terminal has ended and the host no longer keeps it.' });
        return;
      }
      this.#set({ status: 'failed', error: refusal(error) });
      return;
    }
    if (attempt !== this.#attempt) return;
    const buffered = this.#buffer ?? [];
    this.#buffer = null;
    const gap = result?.gap;
    if (gap && Number.isSafeInteger(gap.fromSeq) && Number.isSafeInteger(gap.toSeq) && gap.toSeq >= gap.fromSeq && gap.toSeq > this.#lastSeq) {
      this.#write(gapMarker(Math.max(gap.fromSeq, this.#lastSeq + 1), gap.toSeq));
      this.#lastSeq = gap.toSeq;
    }
    const terminal = result?.terminal;
    if (terminal && Number.isSafeInteger(terminal.cols)) this.#sentSize ??= { cols: terminal.cols, rows: terminal.rows };
    this.#set({ status: 'running' });
    for (const event of buffered) this.#apply(event);
    if (this.#view.status === 'running' && terminal?.state === 'exited') {
      this.#set({ status: 'exited', exit: { exitCode: terminal.exitCode ?? null, signal: terminal.signal ?? null, reason: terminal.endReason ?? 'exited' } });
    }
    if (this.#view.status === 'running') this.#scheduleResize(0);
  }

  /**
   * A terminal.event notification of this connection.
   * @param {any} event
   */
  event(event) {
    if (!event || event.terminalId !== this.#view.terminalId) return;
    if (this.#buffer) { this.#buffer.push(event); return; }
    this.#apply(event);
  }

  /** @param {any} event */
  #apply(event) {
    if (event.type === 'detached') {
      if (event.reason === 'slow_consumer') { if (this.#connected) void this.#attach(this.#lastSeq, false); else this.#set({ status: 'reconnecting' }); return; }
      this.#attempt += 1;
      this.#pending = '';
      this.#set({ status: 'replaced' });
      return;
    }
    if (!Number.isSafeInteger(event.seq) || event.seq <= this.#lastSeq) return;
    if (event.seq > this.#lastSeq + 1) this.#write(gapMarker(this.#lastSeq + 1, event.seq - 1));
    this.#lastSeq = event.seq;
    if (event.type === 'output' && typeof event.data === 'string') this.#write(event.data);
    else if (event.type === 'exit') {
      this.#pending = '';
      this.#set({ status: 'exited', exit: { exitCode: event.exitCode ?? null, signal: event.signal ?? null, reason: typeof event.reason === 'string' ? event.reason : 'exited' } });
    }
  }

  /**
   * What was typed: sent in order, batched, never more than maxInputBytes in one request. Ignored
   * (false) unless the terminal is running here.
   * @param {string} data
   */
  input(data) {
    if (!this.accepting || typeof data !== 'string' || !data) return false;
    this.#pending += data;
    if (!this.#sending && this.#inputTimer === undefined) this.#inputTimer = setTimeout(() => { this.#inputTimer = undefined; void this.#flush(); }, this.#options.inputDelayMs);
    return true;
  }

  async #flush() {
    if (this.#sending || !this.#pending || !this.accepting) return;
    const [chunk, rest] = splitUtf8(this.#pending, this.#options.limits.maxInputBytes);
    if (!chunk) { this.#pending = ''; return; }
    this.#pending = rest;
    this.#sending = true;
    const terminalId = this.#view.terminalId;
    try {
      await this.#options.request('terminal.input', { terminalId, data: chunk });
    } catch (error) {
      const failure = describe(error);
      this.#pending = '';
      // An exited or replaced terminal says so through its own event; anything else is said here.
      if (failure.reason !== 'terminal_exited' && failure.reason !== 'not_attached') {
        const lost = failure.sent === 'yes' ? `Input was not delivered: ${refusal(error)}` : 'The last input may not have reached the shell (the connection dropped). It is not sent again.';
        this.#set({ lost });
        this.#write(`\r\n\x1b[2m[${lost}]\x1b[0m\r\n`);
      }
    } finally {
      this.#sending = false;
    }
    if (this.#pending) void this.#flush();
  }

  /**
   * The view's size changed: one terminal.resize after it settles.
   * @param {number} cols @param {number} rows
   */
  resize(cols, rows) {
    this.#size = clampSize(cols, rows);
    this.#scheduleResize(this.#options.resizeDelayMs);
  }

  /** @param {number} delay */
  #scheduleResize(delay) {
    if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => { this.#resizeTimer = undefined; void this.#sendResize(); }, delay);
  }

  async #sendResize() {
    if (!this.accepting) return;
    const size = this.#size;
    if (this.#sentSize && this.#sentSize.cols === size.cols && this.#sentSize.rows === size.rows) return;
    try {
      const result = await this.#options.request('terminal.resize', { terminalId: this.#view.terminalId, cols: size.cols, rows: size.rows });
      this.#sentSize = { cols: Number(result?.cols ?? size.cols), rows: Number(result?.rows ?? size.rows) };
    } catch {
      // Not attached any more, or the connection dropped: the next attach sends the size again.
      this.#sentSize = null;
    }
  }

  /** Another client took the stream: take it back, after the last output seen here. */
  reattach() {
    if (this.#view.status !== 'replaced' || !this.#view.terminalId) return;
    void this.#attach(this.#lastSeq, false);
  }

  /** The connection to the host is up again: attach after the last seq seen, or repeat a lost create. */
  connected() {
    this.#connected = true;
    const { status, terminalId } = this.#view;
    if (status !== 'reconnecting' && status !== 'attaching' && status !== 'starting' && status !== 'running') return;
    this.#sentSize = null;
    if (terminalId) void this.#attach(this.#lastSeq, false);
    else if (this.#createId) void this.#create();
  }

  /** The connection dropped: no input until attached again. */
  disconnected() {
    this.#connected = false;
    this.#attempt += 1;
    this.#buffer = null;
    if (this.#pending) { this.#pending = ''; this.#set({ lost: 'Input typed while the connection dropped was not sent.' }); }
    if (['running', 'attaching', 'starting'].includes(this.#view.status)) this.#set({ status: 'reconnecting' });
  }

  /** The tab closed: the terminal ends on the host (terminal.close) and is forgotten here. */
  async close() {
    const { terminalId, status } = this.#view;
    this.dispose();
    this.#store(undefined);
    this.#set({ status: 'closed' });
    if (!terminalId || status === 'gone' || status === 'closed') return;
    try { await this.#options.request('terminal.close', { terminalId }); } catch {}
  }

  /** Stops timers and listeners; the host's terminal is left alone. */
  dispose() {
    this.#attempt += 1;
    if (this.#inputTimer !== undefined) clearTimeout(this.#inputTimer);
    if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
    this.#inputTimer = this.#resizeTimer = undefined;
    this.#pending = '';
    this.#outputs.clear();
  }

  /** Clears the "may not have reached" note once the user saw it. */
  dismissLost() { if (this.#view.lost) this.#set({ lost: undefined }); }
}

/** A terminal refusal for people. @param {unknown} error */
export function refusal(error) {
  const failure = describe(error);
  if (failure.reason && REFUSALS[failure.reason]) return REFUSALS[failure.reason];
  if (failure.code === 1003 && failure.reason === 'grant') return TERMINAL_MESSAGES.permission;
  if (failure.code === 1003 && failure.reason === 'outside_workspace') return 'This workspace is not granted to your access token.';
  return failure.message;
}
