import { AlpRpcError, ERROR } from '@anhlp/alp-protocol';
import { AlpRpcClient } from './client.js';
import { AlpClientError } from './errors.js';

/**
 * Keeps an ALP connection up: connects, runs the caller's `onConnect` (handshake, reattach and
 * replay as the protocol defines them), and after a disconnect connects again with exponential
 * backoff until stopped. A connection counts as up only once it has stayed open `stableMs`; one
 * that drops sooner (a gateway closing right after the handshake) counts as a failed attempt, so
 * backoff and `maxAttempts` still apply. It never resends a request: requests in flight when the connection drops
 * reject as `disconnected`, and requests made while it is down reject at once. Whether and how to
 * retry belongs to the caller, who knows which methods are safe to repeat.
 */

/**
 * @typedef {import('./client.js').AlpTransport} AlpTransport
 * @typedef {import('./client.js').AlpRpcClientOptions} AlpRpcClientOptions
 * @typedef {import('./client.js').RequestOptions} RequestOptions
 * @typedef {import('./client.js').AbortSignalLike} AbortSignalLike
 * @typedef {'connecting' | 'open' | 'waiting' | 'stopped'} ReconnectState
 * @typedef {{ initialMs?: number, maxMs?: number, factor?: number, jitter?: number }} Backoff
 * @typedef {{
 *   connect(context: { attempt: number, signal: AbortSignalLike }): Promise<AlpTransport>,
 *   onConnect?(client: AlpRpcClient, context: { attempt: number, reconnect: boolean, signal: AbortSignalLike }): unknown,
 *   onDisconnect?(error: Error, context: { reconnect: boolean }): void,
 *   backoff?: Backoff,
 *   maxAttempts?: number,
 *   stableMs?: number,
 *   shouldRetry?(error: Error): boolean,
 *   client?: AlpRpcClientOptions,
 *   random?: () => number,
 * }} ReconnectOptions
 * @typedef {{
 *   readonly state: ReconnectState,
 *   readonly client: AlpRpcClient | undefined,
 *   readonly attempt: number,
 *   ready(options?: { signal?: AbortSignalLike }): Promise<AlpRpcClient>,
 *   request<T = any>(method: string, params?: unknown, options?: RequestOptions): Promise<T>,
 *   onEvent(listener: (envelope: any) => void): () => boolean,
 *   onNotification(listener: (method: string, params: any) => void): () => boolean,
 *   onState(listener: (state: ReconnectState, error?: Error) => void): () => boolean,
 *   stop(): void,
 * }} ReconnectingClient
 */

/** The delay before attempt `attempt` (1-based), with ±jitter. @param {number} attempt @param {Backoff} backoff @param {() => number} random */
export function backoffDelay(attempt, { initialMs = 250, maxMs = 10_000, factor = 2, jitter = 0.2 } = {}, random = Math.random) {
  const base = Math.min(maxMs, initialMs * factor ** Math.max(0, attempt - 1));
  return Math.max(0, Math.round(base * (1 + jitter * (2 * random() - 1))));
}

/**
 * Whether a failed connect or onConnect is worth another attempt: everything but alpd refusing the
 * handshake (ERROR.protocol, an unsupported protocol version), which retrying cannot fix.
 * @param {Error} error
 */
export function retryable(error) {
  return !(error instanceof AlpRpcError && error.code === ERROR.protocol);
}

/** The platform's AbortController, whose signal fetch and AbortSignal.any accept; a minimal one where there is none. */
function controller() {
  if (typeof globalThis.AbortController === 'function') {
    const native = new globalThis.AbortController();
    return { signal: /** @type {AbortSignalLike} */ (native.signal), /** @param {unknown} reason */ abort: reason => native.abort(reason) };
  }
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const signal = {
    aborted: false,
    /** @type {unknown} */ reason: undefined,
    /** @param {'abort'} _type @param {() => void} listener */
    addEventListener(_type, listener) { listeners.add(listener); },
    /** @param {'abort'} _type @param {() => void} listener */
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  return {
    signal,
    /** @param {unknown} reason */
    abort(reason) {
      if (signal.aborted) return;
      signal.aborted = true;
      signal.reason = reason;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

/**
 * @param {ReconnectOptions} options
 * @returns {ReconnectingClient}
 */
export function createReconnectingClient({ connect, onConnect, onDisconnect, backoff = {}, maxAttempts = Infinity, stableMs = 5_000, shouldRetry = retryable, client: clientOptions, random = Math.random }) {
  if (typeof connect !== 'function') throw new TypeError('createReconnectingClient needs connect()');
  /** @type {ReconnectState} */
  let state = 'connecting';
  /** @type {AlpRpcClient | undefined} */
  let current;
  let attempt = 0;
  let connectedBefore = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  // One run for the client's whole life: stop() is final and aborts it.
  const run = controller();
  /** @type {Set<(envelope: any) => void>} */
  const events = new Set();
  /** @type {Set<(method: string, params: any) => void>} */
  const notifications = new Set();
  /** @type {Set<(state: ReconnectState, error?: Error) => void>} */
  const states = new Set();
  /** @type {Set<{ resolve(client: AlpRpcClient): void, reject(error: Error): void }>} */
  const waiters = new Set();

  const onListenerError = clientOptions?.onListenerError ?? (error => { setTimeout(() => { throw error; }, 0); });
  /** @param {Function} listener @param {unknown[]} args */
  const dispatch = (listener, ...args) => { try { listener(...args); } catch (error) { onListenerError(error); } };

  /** @param {ReconnectState} next @param {Error} [error] */
  const enter = (next, error) => {
    state = next;
    for (const listener of [...states]) {
      dispatch(listener, next, error);
      // A listener that called stop() has moved the state on; later ones must not hear a stale one.
      if (state !== next) return;
    }
    if (next === 'open' && current) for (const waiter of [...waiters]) { waiters.delete(waiter); waiter.resolve(current); }
    if (next === 'stopped') for (const waiter of [...waiters]) { waiters.delete(waiter); waiter.reject(error ?? new AlpClientError('ALP connection stopped', { reason: 'closed' })); }
  };

  /** @param {Error} error */
  const retry = error => {
    if (state === 'stopped') return;
    if (attempt >= maxAttempts || !shouldRetry(error)) return enter('stopped', error);
    enter('waiting', error);
    if (state !== 'waiting') return;
    timer = setTimeout(() => { timer = undefined; void open(); }, backoffDelay(attempt, backoff, random));
  };

  const open = async () => {
    if (state === 'stopped') return;
    attempt++;
    enter('connecting');
    const { signal } = run;
    if (state !== 'connecting' || signal.aborted) return;
    /** @type {AlpRpcClient | undefined} */
    let candidate;
    // stop() during the handshake closes the connection being set up: its pending requests reject
    // and nothing more is sent on it.
    const closeCandidate = () => candidate?.close();
    signal.addEventListener('abort', closeCandidate, { once: true });
    try {
      const transport = await connect({ attempt, signal });
      if (signal.aborted) { try { transport.close(); } catch {} return; }
      candidate = new AlpRpcClient(transport, clientOptions);
      // Listeners go on before onConnect so a replay it requests reaches them.
      // Each caller listener runs on its own, as on AlpRpcClient: one that throws does not stop the rest.
      candidate.onEvent(envelope => { for (const listener of [...events]) dispatch(listener, envelope); });
      candidate.onNotification((method, params) => { for (const listener of [...notifications]) dispatch(listener, method, params); });
      if (onConnect) await onConnect(candidate, { attempt, reconnect: connectedBefore, signal });
      if (signal.aborted) { candidate.close(); return; }
      if (candidate.closed) throw new AlpClientError('ALP connection closed during onConnect', { reason: 'disconnected' });
    } catch (error) {
      candidate?.close();
      if (signal.aborted) return;
      return retry(error instanceof Error ? error : new Error(String(error)));
    } finally {
      signal.removeEventListener('abort', closeCandidate);
    }
    const connected = /** @type {AlpRpcClient} */ (candidate);
    current = connected;
    const reconnect = connectedBefore;
    connectedBefore = true;
    const openedAt = Date.now();
    connected.onClose(error => {
      if (current !== connected) return;
      current = undefined;
      // Only a connection that stayed up starts the next one from a fresh backoff.
      if (Date.now() - openedAt >= stableMs) attempt = 0;
      dispatch(() => onDisconnect?.(error, { reconnect }));
      retry(error);
    });
    enter('open');
  };

  void open();

  return {
    get state() { return state; },
    get client() { return current; },
    get attempt() { return attempt; },
    ready({ signal } = {}) {
      if (state === 'open' && current) return Promise.resolve(current);
      if (state === 'stopped') return Promise.reject(new AlpClientError('ALP connection stopped', { reason: 'closed' }));
      return new Promise((resolve, reject) => {
        const waiter = {
          /** @param {AlpRpcClient} client */ resolve: client => { signal?.removeEventListener('abort', onAbort); resolve(client); },
          /** @param {Error} error */ reject: error => { signal?.removeEventListener('abort', onAbort); reject(error); },
        };
        const onAbort = () => { waiters.delete(waiter); reject(new AlpClientError('Waiting for the ALP connection was aborted', { reason: 'aborted', cause: signal?.reason })); };
        if (signal?.aborted) return onAbort();
        waiters.add(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    request(method, params, options) {
      if (state !== 'open' || !current) return Promise.reject(new AlpClientError('ALP daemon connection closed', { reason: state === 'stopped' ? 'closed' : 'disconnected' }));
      return current.request(method, params, options);
    },
    onEvent(listener) { events.add(listener); return () => events.delete(listener); },
    onNotification(listener) { notifications.add(listener); return () => notifications.delete(listener); },
    onState(listener) { states.add(listener); return () => states.delete(listener); },
    stop() {
      if (state === 'stopped') return;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      run.abort(new AlpClientError('ALP connection stopped', { reason: 'closed' }));
      const last = current;
      current = undefined;
      enter('stopped');
      last?.close();
      events.clear();
      notifications.clear();
      states.clear();
    },
  };
}
