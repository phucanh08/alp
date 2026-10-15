/**
 * Errors the client raises itself, as opposed to AlpRpcError, which carries an error alpd returned.
 * Portable: no Node built-ins, process or Buffer (plans/reference/ALPD.md §3, docs/alp/client-sdk.md).
 */

const BRAND = Symbol.for('@anhlp/alp-client/AlpClientError');

/**
 * Why a request or a connection ended on the client side.
 * - `closed`: this client was closed locally with close().
 * - `disconnected`: the transport closed or failed. A request that was already sent may or may not
 *   have run on the daemon; the client never resends it.
 * - `protocol`: the peer sent something that is not ALP JSON-RPC, so the client closed the connection.
 * - `send_failed`: the transport refused the frame; the request never left this client.
 * - `timeout` / `aborted`: the caller stopped waiting. Only the local wait ends; the daemon is not told.
 * - `overloaded`: too many requests are waiting for an answer already; nothing was sent.
 */
export const CLIENT_ERROR = Object.freeze({
  closed: 'closed',
  disconnected: 'disconnected',
  protocol: 'protocol',
  sendFailed: 'send_failed',
  timeout: 'timeout',
  aborted: 'aborted',
  overloaded: 'overloaded',
});

export class AlpClientError extends Error {
  /**
   * @param {string} message
   * @param {{ reason: 'closed' | 'disconnected' | 'protocol' | 'send_failed' | 'timeout' | 'aborted' | 'overloaded', cause?: unknown, data?: unknown }} details
   */
  constructor(message, { reason, cause, data }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AlpClientError';
    /** @type {'closed' | 'disconnected' | 'protocol' | 'send_failed' | 'timeout' | 'aborted' | 'overloaded'} */
    this.reason = reason;
    /** @type {unknown} */
    this.data = data;
    Object.defineProperty(this, BRAND, { value: true });
  }
}

/**
 * True for an AlpClientError, also one thrown by another copy of this module (a bundle may carry
 * two); `reason` narrows the check.
 * @param {unknown} error
 * @param {string} [reason]
 * @returns {error is AlpClientError}
 */
export function isAlpClientError(error, reason) {
  return typeof error === 'object' && error !== null && /** @type {any} */ (error)[BRAND] === true
    && (reason === undefined || /** @type {any} */ (error).reason === reason);
}
