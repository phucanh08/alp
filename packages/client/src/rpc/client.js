import { AlpRpcError, MAX_FRAME } from '@anhlp/alp-protocol';
import { AlpClientError } from './errors.js';
import { utf8Length } from './framing.js';

/**
 * The transport-independent JSON-RPC 2.0 engine of an ALP client (plans/reference/ALPD.md §3):
 * request correlation, the daemon's `event` and other notifications, requests the daemon sends
 * the client (extension.register), local timeouts and aborts, and cleanup when the connection
 * ends. It runs unchanged in Node, browsers and React Native; a transport moves whole frames.
 *
 * A transport carries one complete JSON-RPC message per frame, as text. Framing (newlines on a
 * socket, one WebSocket message per frame), byte decoding, connection setup and authentication
 * belong to the transport and whoever creates it, never to this engine.
 */

/**
 * @typedef {'open' | 'closed'} TransportState
 * @typedef {{ error?: Error, code?: number, reason?: string }} TransportClose
 *   Why a transport closed: `error` when it failed, `code`/`reason` when the peer said so.
 * @typedef {{
 *   readonly state: TransportState,
 *   send(frame: string): void,
 *   onMessage(listener: (frame: string) => void): () => void,
 *   onClose(listener: (close: TransportClose) => void): () => void,
 *   close(): void,
 * }} AlpTransport
 *   Contract (docs/alp/client-sdk.md): `send` delivers or throws, synchronously, and a throw means
 *   the frame did not leave; `onMessage` delivers frames in arrival order; `onClose` fires at most
 *   once, also after `close()`; nothing is delivered after it; `close` is idempotent.
 * @typedef {{
 *   readonly aborted: boolean,
 *   readonly reason?: unknown,
 *   addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void,
 *   removeEventListener(type: 'abort', listener: () => void): void,
 * }} AbortSignalLike
 * @typedef {{ signal?: AbortSignalLike, timeoutMs?: number }} RequestOptions
 *   Both end only this client's wait; neither tells the daemon to stop.
 * @typedef {{
 *   maxPending?: number,
 *   maxFrame?: number,
 *   timeoutMs?: number,
 *   onListenerError?: (error: unknown) => void,
 * }} AlpRpcClientOptions
 */

const CLOSED = 'ALP daemon connection closed';
/** Requests waiting for an answer at once; beyond it a request fails as `overloaded` and is not sent. */
export const DEFAULT_MAX_PENDING = 4096;

/** A listener's exception must not break dispatch to the others; it surfaces like an uncaught error. @param {unknown} error */
const rethrow = error => { setTimeout(() => { throw error; }, 0); };

/** @param {AlpTransport} transport */
function assertTransport(transport) {
  for (const name of ['send', 'onMessage', 'onClose', 'close']) {
    if (typeof /** @type {any} */ (transport)?.[name] !== 'function') throw new TypeError(`ALP transport must implement ${name}()`);
  }
}

/** @param {AbortSignalLike} signal */
const abortError = signal => new AlpClientError('ALP request aborted', { reason: 'aborted', cause: signal.reason });

/** @param {object} value @param {string} key */
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export class AlpRpcClient {
  /** @type {AlpTransport} */ #transport;
  #sequence = 0;
  /** @type {Map<number, { resolve(value: unknown): void, reject(error: unknown): void, cleanup(): void }>} */
  #pending = new Map();
  /** @type {Set<(envelope: any) => void>} */ #events = new Set();
  /** @type {Set<(method: string, params: any) => void>} */ #notifications = new Set();
  /** @type {Set<(error: Error) => void>} */ #closes = new Set();
  /** @type {Set<(method: string, params: any) => unknown>} */ #requestHandlers = new Set();
  /** @type {Array<() => void>} */ #detach = [];
  /** @type {AlpClientError | undefined} */ #closeError;
  #maxPending;
  #maxFrame;
  #timeoutMs;
  #onListenerError;

  /**
   * @param {AlpTransport} transport an open transport; the client owns it from now on
   * @param {AlpRpcClientOptions} [options]
   */
  constructor(transport, { maxPending = DEFAULT_MAX_PENDING, maxFrame = MAX_FRAME, timeoutMs, onListenerError = rethrow } = {}) {
    assertTransport(transport);
    this.#transport = transport;
    this.#maxPending = maxPending;
    this.#maxFrame = maxFrame;
    this.#timeoutMs = timeoutMs;
    this.#onListenerError = onListenerError;
    this.#detach.push(transport.onMessage(frame => this.#receive(frame)));
    this.#detach.push(transport.onClose(close => this.#finish(this.#disconnected(close))));
    if (transport.state === 'closed') this.#finish(new AlpClientError(CLOSED, { reason: 'disconnected' }));
  }

  /** True once the connection is gone, for whatever reason. */
  get closed() { return this.#closeError !== undefined; }
  /** Requests sent and still waiting for an answer. */
  get pendingCount() { return this.#pending.size; }

  /**
   * Sends one request and resolves with its result, or rejects with AlpRpcError (the daemon
   * answered with an error) or AlpClientError (the client gave up: see CLIENT_ERROR). Requests are
   * never resent, also not after a reconnect.
   * @template [T=any]
   * @param {string} method
   * @param {unknown} [params]
   * @param {RequestOptions} [options]
   * @returns {Promise<T>}
   */
  request(method, params = {}, { signal, timeoutMs = this.#timeoutMs } = {}) {
    if (this.#closeError) return Promise.reject(new AlpClientError(CLOSED, { reason: this.#closeError.reason === 'closed' ? 'closed' : 'disconnected', cause: this.#closeError }));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.#pending.size >= this.#maxPending) return Promise.reject(new AlpClientError(`Too many ALP requests waiting for an answer (${this.#maxPending})`, { reason: 'overloaded' }));
    const id = ++this.#sequence;
    let frame;
    try { frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }); } catch (error) { return Promise.reject(error); }
    if (utf8Length(frame) > this.#maxFrame) return Promise.reject(new AlpClientError(`ALP request ${method} exceeds the ${this.#maxFrame}-byte frame limit`, { reason: 'send_failed' }));
    return new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const onAbort = () => { if (this.#pending.delete(id)) { cleanup(); reject(abortError(/** @type {AbortSignalLike} */ (signal))); } };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.#pending.set(id, { resolve, reject, cleanup });
      if (timeoutMs !== undefined && timeoutMs !== Infinity) {
        timer = setTimeout(() => {
          if (!this.#pending.delete(id)) return;
          cleanup();
          reject(new AlpClientError(`ALP request ${method} timed out after ${timeoutMs} ms`, { reason: 'timeout' }));
        }, timeoutMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.#transport.send(frame);
      } catch (error) {
        if (this.#pending.delete(id)) {
          cleanup();
          reject(new AlpClientError(`Could not send ALP request ${method}: ${error instanceof Error ? error.message : String(error)}`, { reason: 'send_failed', cause: error }));
        }
      }
    });
  }

  /** Every `event` notification: an envelope of a session the connection attached to. Returns a remover. @param {(envelope: any) => void} listener */
  onEvent(listener) { return this.#add(this.#events, listener); }

  /** Every notification from the daemon, `event` included; for methods this client does not know yet. @param {(method: string, params: any) => void} listener */
  onNotification(listener) { return this.#add(this.#notifications, listener); }

  /**
   * Answers requests the daemon sends this client (the extension RPC of ALPD §61). The first
   * handler answers; its result, or its error's numeric `code`, `message` and `data`, goes back.
   * @param {(method: string, params: any) => unknown} handler
   */
  onRequest(handler) { return this.#add(this.#requestHandlers, handler); }

  /** Called once when the connection ends, with the error pending requests were rejected with. @param {(error: Error) => void} listener */
  onClose(listener) { return this.#add(this.#closes, listener); }

  /** Ends the connection; waiting requests reject with reason `closed`. Idempotent. */
  close() {
    if (this.#closeError) return;
    this.#finish(new AlpClientError(CLOSED, { reason: 'closed' }));
  }

  /** @template F @param {Set<F>} set @param {F} listener */
  #add(set, listener) {
    if (typeof listener !== 'function') throw new TypeError('ALP client listener must be a function');
    if (this.#closeError) return () => false;
    set.add(listener);
    return () => set.delete(listener);
  }

  /** @param {TransportClose} [close] */
  #disconnected(close = {}) {
    if (close.error instanceof AlpClientError) return close.error;
    const data = close.code !== undefined || close.reason ? { code: close.code, reason: close.reason } : undefined;
    return new AlpClientError(close.error?.message ?? CLOSED, { reason: 'disconnected', cause: close.error, data });
  }

  /** @param {string} message */
  #violation(message) {
    this.#finish(new AlpClientError(message, { reason: 'protocol' }));
  }

  /** @param {Function} listener @param {unknown[]} args */
  #call(listener, ...args) {
    try { listener(...args); } catch (error) { this.#onListenerError(error); }
  }

  /** @param {string} frame */
  #receive(frame) {
    if (this.#closeError) return;
    if (typeof frame !== 'string') return this.#violation('Invalid frame from ALP daemon');
    let message;
    try { message = JSON.parse(frame); } catch { return this.#violation('Invalid frame from ALP daemon'); }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return this.#violation('Invalid frame from ALP daemon');
    const hasId = message.id !== undefined && message.id !== null;
    if (message.method === 'event') {
      for (const listener of [...this.#events]) this.#call(listener, message.params);
      for (const listener of [...this.#notifications]) this.#call(listener, message.method, message.params);
      return;
    }
    if (typeof message.method === 'string' && hasId && !own(message, 'result') && !own(message, 'error')) return this.#answer(message.id, message.method, message.params ?? {});
    if (typeof message.method === 'string' && !hasId) {
      for (const listener of [...this.#notifications]) this.#call(listener, message.method, message.params);
      return;
    }
    // A response to a request this client no longer waits for (timed out, aborted) or never sent,
    // and an error the daemon could not tie to a request (id null), have nobody to go to.
    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    waiter.cleanup();
    if (own(message, 'error') && typeof message.error === 'object' && message.error !== null) waiter.reject(new AlpRpcError(message.error));
    else if (own(message, 'result') && !own(message, 'error')) waiter.resolve(message.result);
    else waiter.reject(new AlpClientError('Malformed response from ALP daemon', { reason: 'protocol', data: { id: message.id } }));
  }

  /** @param {unknown} id @param {string} method @param {unknown} params */
  #answer(id, method, params) {
    const reply = (/** @type {object} */ body) => {
      if (this.#closeError) return;
      try { this.#transport.send(JSON.stringify({ jsonrpc: '2.0', id, ...body })); } catch {}
    };
    const [handler] = this.#requestHandlers;
    if (!handler) return reply({ error: { code: -32601, message: `Unknown method '${method}'` } });
    Promise.resolve().then(async () => {
      try {
        const result = await handler(method, params);
        reply({ result: result === undefined ? {} : result });
      } catch (error) {
        const code = (error && typeof (/** @type {any} */ (error)).code === 'number') ? /** @type {any} */ (error).code : 1000;
        const text = error instanceof Error ? error.message : String(error);
        const data = (error && /** @type {any} */ (error).data !== undefined) ? { data: /** @type {any} */ (error).data } : {};
        reply({ error: { code, message: text.length > 2000 ? `${text.slice(0, 2000)}...` : text, ...data } });
      }
    });
  }

  /** @param {AlpClientError} error */
  #finish(error) {
    if (this.#closeError) return;
    this.#closeError = error;
    for (const detach of this.#detach.splice(0)) { try { detach(); } catch {} }
    try { this.#transport.close(); } catch {}
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const waiter of pending) { waiter.cleanup(); waiter.reject(error); }
    const closes = [...this.#closes];
    this.#events.clear();
    this.#notifications.clear();
    this.#requestHandlers.clear();
    this.#closes.clear();
    for (const listener of closes) this.#call(listener, error);
  }
}
