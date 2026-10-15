import { MAX_FRAME } from '@anhlp/alp-protocol';
import { AlpClientError } from './rpc/errors.js';
import { utf8Length } from './rpc/framing.js';

/**
 * A WebSocket transport for the portable ALP client: the browser's WebSocket, React Native's, or
 * any implementation the caller injects (`ws` in Node, a test double). One JSON-RPC message per
 * text message; a message holding several newline-separated messages is accepted too. Binary
 * messages are refused.
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
const CLOSED = 3;

/** A URL fit for an error message: no credentials, query or fragment, which may carry a token. @param {string} url */
export function redactUrl(url) {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^@/?#]*@)?([^/?#]*)([^?#]*)/i.exec(String(url));
  return match ? `${match[1]}${match[2]}${match[3]}` : '<websocket>';
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

/** @param {any} event */
const errorOf = event => event?.error instanceof Error ? event.error : new Error(typeof event?.message === 'string' && event.message ? event.message : 'WebSocket error');

/**
 * Wraps an open WebSocket in an ALP transport. The transport owns the socket from then on.
 * @param {WebSocketLike} socket
 * @param {WebSocketTransportOptions} [options]
 * @returns {AlpTransport}
 */
export function createWebSocketTransport(socket, { maxFrame = MAX_FRAME, maxBufferedBytes = 4 * MAX_FRAME } = {}) {
  if (socket.readyState !== OPEN) throw new AlpClientError('WebSocket is not open', { reason: 'disconnected' });
  try { socket.binaryType = 'arraybuffer'; } catch {}
  /** @type {Set<(frame: string) => void>} */
  const messages = new Set();
  /** @type {Set<(close: TransportClose) => void>} */
  const closes = new Set();
  /** @type {TransportClose | undefined} */
  let ended;
  /** @type {Array<() => void>} */
  const detach = [];
  /** @param {TransportClose} close */
  const end = close => {
    if (ended) return;
    ended = close;
    for (const remove of detach.splice(0)) remove();
    messages.clear();
    const listeners = [...closes];
    closes.clear();
    for (const listener of listeners) listener(close);
  };
  /** @param {string} message @param {number} code */
  const violate = (message, code) => {
    const error = new AlpClientError(message, { reason: 'protocol' });
    try { socket.close(code, message.slice(0, 120)); } catch {}
    end({ error });
  };
  detach.push(listen(socket, 'message', event => {
    if (ended) return;
    const data = event?.data;
    if (typeof data !== 'string') return violate('Binary WebSocket messages are not ALP frames', 1003);
    if (utf8Length(data) > maxFrame) return violate(`ALP frame exceeds ${maxFrame} bytes`, 1009);
    for (const line of data.includes('\n') ? data.split('\n') : [data]) {
      if (ended) return;
      if (line.trim()) for (const listener of [...messages]) listener(line);
    }
  }));
  detach.push(listen(socket, 'close', event => end({ code: typeof event?.code === 'number' ? event.code : undefined, reason: typeof event?.reason === 'string' && event.reason ? event.reason : undefined })));
  // An error is followed by close in browsers, but not every implementation promises it.
  detach.push(listen(socket, 'error', event => { const error = errorOf(event); try { socket.close(); } catch {} end({ error }); }));
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
      if (ended) return;
      try { if (socket.readyState !== CLOSED) socket.close(1000, 'client closed'); } catch {}
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
  if (signal?.aborted) return Promise.reject(new AlpClientError(`Connecting to ${where} was aborted`, { reason: 'aborted', cause: signal.reason }));
  /** @type {WebSocketLike} */
  let socket;
  try {
    if (createSocket) socket = createSocket(url, protocols);
    else {
      const Constructor = Implementation ?? /** @type {any} */ (globalThis).WebSocket;
      if (typeof Constructor !== 'function') throw new TypeError('No WebSocket implementation: pass options.WebSocket or options.createSocket');
      socket = protocols === undefined ? new Constructor(url) : new Constructor(url, protocols);
    }
  } catch (error) {
    return Promise.reject(error instanceof TypeError ? error : new AlpClientError(`Could not connect to ${where}`, { reason: 'disconnected', cause: error }));
  }
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
      try { if (socket.readyState === CONNECTING || socket.readyState === OPEN) socket.close(); } catch {}
      reject(error);
    };
    const onAbort = () => fail(new AlpClientError(`Connecting to ${where} was aborted`, { reason: 'aborted', cause: signal?.reason }));
    const open = () => {
      settle();
      try { resolve(createWebSocketTransport(socket, options)); } catch (error) { reject(error); }
    };
    if (socket.readyState === OPEN) return open();
    detach.push(listen(socket, 'open', open));
    detach.push(listen(socket, 'error', event => fail(new AlpClientError(`Could not connect to ${where}`, { reason: 'disconnected', cause: errorOf(event) }))));
    detach.push(listen(socket, 'close', event => fail(new AlpClientError(`Could not connect to ${where}`, { reason: 'disconnected', data: { code: event?.code, reason: event?.reason || undefined } }))));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined && timeoutMs !== Infinity) timer = setTimeout(() => fail(new AlpClientError(`Connecting to ${where} timed out after ${timeoutMs} ms`, { reason: 'timeout' })), timeoutMs);
  });
}
