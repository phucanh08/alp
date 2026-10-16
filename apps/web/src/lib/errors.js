// @ts-check
import { AlpRpcError, isAlpClientError } from '@anhlp/alp-client/portable';

/**
 * What a failed request means for the person using the app: whether it reached the host, whether
 * its outcome is known, and whether trying again can help. Codes come from
 * docs/protocol/alp-json-rpc-v1.md §5 and the gateway's refusals (docs/alp/remote-gateway.md §5.2);
 * messages are written for people and never echo a credential.
 */

/** The gateway refused the credential (HTTP 401): reconnecting cannot help until it is replaced. */
export class AuthenticationError extends Error {
  constructor(message = 'The gateway refused this access token. It may be mistyped, revoked, rotated or expired.') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/** The gateway or host cannot serve this app as configured (origin, TLS, host name, version). */
export class ConfigurationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/** The gateway is unreachable or busy for now: worth another try after a pause. */
export class TransientError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TransientError';
  }
}

/**
 * @typedef {{
 *   message: string,
 *   code?: number,
 *   reason?: string,
 *   sent: 'no' | 'yes' | 'unknown',
 *   terminal: boolean,
 * }} Failure
 *   sent: 'no' when the request never left (safe to send again), 'yes' when the host answered,
 *   'unknown' when it may or may not have run. terminal: the connection cannot recover by retrying.
 */

/** @param {unknown} error @returns {string | undefined} */
const reasonOf = error => (error && typeof error === 'object' && /** @type {any} */ (error).data && typeof /** @type {any} */ (error).data.reason === 'string') ? /** @type {any} */ (error).data.reason : undefined;

/** An error the host answered with (a JSON-RPC error), also one built by another copy of the SDK. @param {unknown} error @returns {error is AlpRpcError} */
const isRpcError = error => error instanceof AlpRpcError || (!!error && typeof error === 'object' && typeof /** @type {any} */ (error).code === 'number' && !isAlpClientError(error));

/** Session-level verdicts that end a root on reattach: gone, refused, malformed (09B-2 lesson). @param {unknown} error */
export function endsRoot(error) {
  const code = isRpcError(error) ? error.code : undefined;
  return code === 1001 || code === 1003 || code === -32601 || code === -32602;
}

/** @param {unknown} error @returns {Failure} */
export function describe(error) {
  if (error instanceof AuthenticationError) return { message: error.message, sent: 'no', terminal: true };
  if (error instanceof ConfigurationError) return { message: error.message, sent: 'no', terminal: true };
  if (error instanceof TransientError) return { message: error.message, sent: 'no', terminal: false };
  if (isAlpClientError(error)) {
    switch (error.reason) {
      case 'send_failed': case 'overloaded':
        return { message: 'The request could not be sent. Nothing reached the host.', sent: 'no', terminal: false };
      case 'closed':
        return { message: 'Disconnected from the host.', sent: 'unknown', terminal: false };
      case 'timeout':
        return { message: 'The host did not answer in time. The request may still have run.', sent: 'unknown', terminal: false };
      case 'aborted':
        return { message: 'Stopped waiting for the host. The request may still have run.', sent: 'unknown', terminal: false };
      case 'protocol':
        return { message: 'The host sent something this app does not understand.', sent: 'unknown', terminal: false };
      default:
        return { message: 'The connection dropped before the host answered. The request may still have run.', sent: 'unknown', terminal: false };
    }
  }
  if (isRpcError(error)) {
    const code = typeof error.code === 'number' ? error.code : 1000;
    const reason = reasonOf(error);
    const base = { code, ...(reason ? { reason } : {}), sent: /** @type {const} */ ('yes'), terminal: false };
    if (code === 1000 && (reason === 'gateway_timeout' || reason === 'daemon_disconnected')) {
      return { ...base, sent: 'unknown', message: reason === 'gateway_timeout' ? 'The host took too long to answer. The request may still have run.' : 'The gateway lost the host before it answered. The request may still have run.' };
    }
    if (code === 1004 && reason === 'outcome_unknown') return { ...base, sent: 'unknown', message: 'The host cannot tell whether the agent received this message. Check the conversation before sending it again.' };
    if (code === 1005 && reason === 'not_sent') return { ...base, sent: 'no', message: 'The gateway was too busy to pass the request on. Nothing reached the host.' };
    if (code === 1005 && reason === 'rate_limited') return { ...base, sent: 'no', message: 'Too many requests at once. Wait a moment and try again.' };
    if (code === 1005 && reason === 'too_many_pending') return { ...base, sent: 'no', message: 'Too many requests are waiting. Wait a moment and try again.' };
    if (code === 1005 && reason === 'busy') return { ...base, message: 'Tasks are locked by another writer on the host. Try again in a moment.' };
    if (code === 1003 && reason === 'grant') {
      const permission = /** @type {any} */ (error).data?.permission;
      return { ...base, message: `Your access token does not allow this${permission ? ` (needs ${permission})` : ''}.` };
    }
    if (code === 1003 && reason === 'mode') return { ...base, message: 'Your access token cannot drive a session in this mode. Ask the host owner for a token with that mode, or use a session in a granted mode.' };
    if (code === 1003 && reason === 'outside_workspace') return { ...base, message: 'That workspace is not granted to your access token.' };
    if (code === 1003 && reason === 'spec_field') return { ...base, message: 'The host refused one of the session settings.' };
    if (code === 1003) return { ...base, message: 'The host refused this request.' };
    if (code === 1001) return { ...base, message: 'Not found on the host. It may have been removed or expired.' };
    if (code === 1004 && reason === 'revision_conflict') return { ...base, message: 'It changed on the host meanwhile. The latest version is shown; try again if you still want to.' };
    if (code === 1004 && reason === 'task_state') return { ...base, message: 'The task\'s current state does not allow that.' };
    if (code === 1004 && reason === 'key_conflict') return { ...base, message: 'That request id was already used for something else.' };
    if (code === -32601) return { ...base, message: 'The host does not offer this through the gateway.' };
    if (code === -32602) return { ...base, message: 'The host refused the request as invalid.' };
    if (code === 1006) return { ...base, terminal: true, message: 'This host speaks a different protocol version. Update ALP on the host or this app.' };
    return { ...base, message: error.message ? `The host could not do that: ${error.message}` : 'The host could not do that.' };
  }
  return { message: error instanceof Error && error.message ? error.message : 'Something went wrong.', sent: 'unknown', terminal: false };
}

/** Whether a failure may be retried by the connection loop (everything but a terminal verdict). @param {unknown} error */
export function retryableConnect(error) {
  return !describe(error).terminal;
}
