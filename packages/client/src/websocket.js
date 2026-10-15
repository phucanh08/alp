import { MAX_FRAME } from '@anhlp/alp-protocol';
import { AlpClientError } from './rpc/errors.js';
import { utf8Length } from './rpc/framing.js';
import { timerDelay } from './rpc/timers.js';

/**
 * A WebSocket transport for the portable ALP client: the browser's WebSocket, React Native's, or
 * any implementation the caller injects (`ws` in Node, a test double). One JSON-RPC message per
 * text message; a message holding several newline-separated messages is accepted too. Binary
 * messages are refused: the socket is closed with 4003, a message over `maxFrame` with 4009
 * (application codes, since browsers refuse to send 1003 and 1009 themselves).
 *
 * How the connection is authenticated is the caller's business and is not designed here (Task 08):
 * `url` and `protocols` are passed through untouched, and `createSocket` builds the socket however
 * the deployment needs (for example Node `ws` with headers). Browsers cannot set arbitrary request
 * headers on a WebSocket, so nothing here relies on them.
 */

/**
 * @typedef {import('./rpc/client.js').AlpTransport} AlpTransport
 * @typedef {import('./rpc/client.js').TransportClose} TransportClose
 * @typedef {import('./rpc/client.js').AbortSignalLike} AbortSignalLike
 * @typedef {{
 *   readonly readyState: number,
 *   readonly bufferedAmount?: number,
 *   binaryType?: string,
 *   send(data: string): void,
 *   close(code?: number, reason?: string): void,
 *   addEventListener?(type: string, listener: (event: any) => void): void,
 *   removeEventListener?(type: string, listener: (event: any) => void): void,
 *   onopen?: ((event: any) => void) | null,
 *   onmessage?: ((event: any) => void) | null,
 *   onerror?: ((event: any) => void) | null,
 *   onclose?: ((event: any) => void) | null,
 * }} WebSocketLike
 * @typedef {new (url: string, protocols?: string | string[]) => WebSocketLike} WebSocketConstructor
 * @typedef {{ maxFrame?: number, maxBufferedBytes?: number }} WebSocketTransportOptions
 * @typedef {WebSocketTransportOptions & {
 *   WebSocket?: WebSocketConstructor,
 *   protocols?: string | string[],
 *   createSocket?: (url: string, protocols?: string | string[]) => WebSocketLike,
 *   signal?: AbortSignalLike,
 *   timeoutMs?: number,
 * }} ConnectWebSocketOptions
 */

const CONNECTING = 0;
const OPEN = 1;

/** Close codes this transport sends when the peer breaks the protocol. */
export const CLOSE_CODE = Object.freeze({ unsupportedData: 4003, tooLarge: 4009 });
/** How long an error waits for the close event that carries its code before ending the transport. */
const CLOSE_AFTER_ERROR_MS = 250;
/** A close reason may hold 123 UTF-8 bytes. */
const MAX_CLOSE_REASON = 123;

/** A URL fit for an error message: no credentials, query or fragment, which may carry a token. @param {string} url */
export function redactUrl(url) {
  // The userinfo runs to the last '@' before the path, so a password holding '@' goes with it.
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#\\]*@)?([^/?#\\@]*)([^?#]*)/i.exec(String(url));
  return match ? `${match[1]}${match[2]}${match[3]}` : '<websocket>';
}

/**
 * An error safe to show or log: the original's name and message with every URL redacted, and none
 * of its other properties (an implementation may keep the URL in `input`, `target` or `cause`).
 * @param {unknown} error @param {string} url
 */
function scrubbed(error, url) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  const message = (text.split(String(url)).join(redactUrl(url)) || 'WebSocket error')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, found => redactUrl(found));
  const clean = new Error(message);
  if (error instanceof Error && error.name) clean.name = error.name;
  return clean;
}

/** `reason` cut to what a close frame may carry. @param {string} reason */
function closeReason(reason) {
  let cut = reason;
  while (utf8Length(cut) > MAX_CLOSE_REASON) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Closes a socket that is not closed yet, with `code` where the implementation accepts it and
 * plainly where it does not, so the socket is always released.
 * @param {WebSocketLike} socket @param {number} [code] @param {string} [reason]
 */
function release(socket, code, reason) {
  if (socket.readyState !== CONNECTING && socket.readyState !== OPEN) return;
  try { if (code === undefined) socket.close(); else socket.close(code, closeReason(reason ?? '')); return; } catch {}
  try { socket.close(); } catch {}
}

/**
 * Keeps an 'error' listener on the socket for good: Node's `ws` throws an 'error' event that
 * nobody listens to as an uncaught exception, and one can follow a close or an abandoned connect.
 * @param {WebSocketLike} socket
 */
function absorbErrors(socket) {
  if (typeof socket.addEventListener === 'function') socket.addEventListener('error', () => {});
}

/** Subscribes with addEventListener where the socket has it, else through its on<type> property. @param {WebSocketLike} socket @param {string} type @param {(event: any) => void} listener */
function listen(socket, type, listener) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }
  const key = /** @type {'onopen' | 'onmessage' | 'onerror' | 'onclose'} */ (`on${type}`);
  const previous = socket[key];
  socket[key] = event => { previous?.(event); listener(event); };
  return () => { socket[key] = previous ?? null; };
}

/** The error an error event carries, never with an empty message. @param {any} event */
const errorOf = event => {
  const message = (event?.error instanceof Error && event.error.message) || (typeof event?.message === 'string' && event.message) || 'WebSocket error';
  return event?.error instanceof Error && event.error.message ? event.error : new Error(message);
};

/**
 * Wraps an open WebSocket in an ALP transport. The transport owns the socket from then on.
 * @param {WebSocketLike} socket
 * @param {WebSocketTransportOptions} [options]
 * @returns {AlpTransport}
 */
export function createWebSocketTransport(socket, { maxFrame = MAX_FRAME, maxBufferedBytes = 4 * MAX_FRAME } = {}) {
  if (socket.readyState !== OPEN) throw new AlpClientError('WebSocket is not open', { reason: 'disconnected' });
  absorbErrors(socket);
  try { socket.binaryType = 'arraybuffer'; } catch {}
  /** @type {Set<(frame: string) => void>} */
  const messages = new Set();
  /** @type {Set<(close: TransportClose) => void>} */
  const closes = new Set();
  /** @type {TransportClose | undefined} */
  let ended;
  /** @type {Array<() => void>} */
  const detach = [];
  /** An error event waiting for the close event that follows it. @type {Error | undefined} */
  let failed;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let failTimer;
  /** @param {TransportClose} close */
  const end = close => {
    if (ended) return;
    ended = close;
    if (failTimer !== undefined) clearTimeout(failTimer);
    for (const remove of detach.splice(0)) remove();
    messages.clear();
    const listeners = [...closes];
    closes.clear();
    for (const listener of listeners) listener(close);
  };
  /** @param {string} message @param {number} code */
  const violate = (message, code) => {
    const error = new AlpClientError(message, { reason: 'protocol' });
    release(socket, code, message);
    end({ error });
  };
  detach.push(listen(socket, 'message', event => {
    if (ended) return;
    const data = event?.data;
    if (typeof data !== 'string') return violate('Binary WebSocket messages are not ALP frames', CLOSE_CODE.unsupportedData);
    if (utf8Length(data) > maxFrame) return violate(`ALP frame exceeds ${maxFrame} bytes`, CLOSE_CODE.tooLarge);
    for (const line of data.includes('\n') ? data.split('\n') : [data]) {
      if (ended) return;
      if (line.trim()) for (const listener of [...messages]) listener(line);
    }
  }));
  detach.push(listen(socket, 'close', event => end({ error: failed, code: typeof event?.code === 'number' ? event.code : undefined, reason: typeof event?.reason === 'string' && event.reason ? event.reason : undefined })));
  // An error comes before its close event, which carries the code (1006 for a dropped
  // connection); the transport ends with both. Not every implementation sends the close, so it
  // ends without it shortly after.
  detach.push(listen(socket, 'error', event => {
    if (failed) return;
    failed = errorOf(event);
    failTimer = setTimeout(() => end({ error: failed }), CLOSE_AFTER_ERROR_MS);
    release(socket);
  }));
  return {
    get state() { return ended || socket.readyState !== OPEN ? 'closed' : 'open'; },
    send(frame) {
      if (ended || socket.readyState !== OPEN) throw new AlpClientError('WebSocket is not open', { reason: 'send_failed' });
      if ((socket.bufferedAmount ?? 0) + utf8Length(frame) > maxBufferedBytes) throw new AlpClientError(`WebSocket send buffer is over ${maxBufferedBytes} bytes`, { reason: 'send_failed' });
      socket.send(frame);
    },
    onMessage(listener) {
      if (ended) return () => false;
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onClose(listener) {
      if (ended) return () => false;
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close() {
      release(socket, 1000, 'client closed');
      end({ code: 1000, reason: 'client closed' });
    },
  };
}

/**
 * Opens a WebSocket to `url` and resolves with its transport once it is open. The socket comes
 * from `createSocket`, else `new WebSocket(url, protocols)` with the injected or global WebSocket.
 * Errors name the URL without its credentials, query or fragment.
 * @param {string} url
 * @param {ConnectWebSocketOptions} [options]
 * @returns {Promise<AlpTransport>}
 */
export function connectWebSocket(url, { WebSocket: Implementation, protocols, createSocket, signal, timeoutMs = 15_000, ...options } = {}) {
  const where = redactUrl(url);
  /** @type {number | undefined} */
  let delay;
  try { delay = timerDelay(timeoutMs); } catch (error) { return Promise.reject(error); }
  if (signal?.aborted) return Promise.reject(new AlpClientError(`Connecting to ${where} was aborted`, { reason: 'aborted', cause: signal.reason }));
  const Constructor = Implementation ?? /** @type {any} */ (globalThis).WebSocket;
  if (!createSocket && typeof Constructor !== 'function') return Promise.reject(new TypeError('No WebSocket implementation: pass options.WebSocket or options.createSocket'));
  /** @type {WebSocketLike} */
  let socket;
  try {
    socket = createSocket ? createSocket(url, protocols) : protocols === undefined ? new Constructor(url) : new Constructor(url, protocols);
  } catch (error) {
    // The raw error may hold the whole URL (a TypeError's `input`, for one); only a scrubbed copy goes on.
    return Promise.reject(new AlpClientError(`Could not connect to ${where}`, { reason: 'disconnected', cause: scrubbed(error, url) }));
  }
  absorbErrors(socket);
  return new Promise((resolve, reject) => {
    /** @type {Array<() => void>} */
    const detach = [];
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const settle = () => {
      for (const remove of detach.splice(0)) remove();
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    /** @param {AlpClientError} error */
    const fail = error => {
      settle();
      release(socket);
      reject(error);
    };
    const onAbort = () => fail(new AlpClientError(`Connecting to ${where} was aborted`, { reason: 'aborted', cause: signal?.reason }));
    const open = () => {
      settle();
      try { resolve(createWebSocketTransport(socket, options)); } catch (error) { reject(error); }
    };
    if (socket.readyState === OPEN) return open();
    detach.push(listen(socket, 'open', open));
    detach.push(listen(socket, 'error', event => fail(new AlpClientError(`Could not connect to ${where}`, { reason: 'disconnected', cause: scrubbed(errorOf(event), url) }))));
    detach.push(listen(socket, 'close', event => fail(new AlpClientError(`Could not connect to ${where}`, { reason: 'disconnected', data: { code: event?.code, reason: event?.reason || undefined } }))));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (delay !== undefined) timer = setTimeout(() => fail(new AlpClientError(`Connecting to ${where} timed out after ${timeoutMs} ms`, { reason: 'timeout' })), delay);
  });
}
