/**
 * The portable ALP client (docs/alp/client-sdk.md): the JSON-RPC engine, its errors, the reconnect
 * helper and NDJSON framing. It runs in Node, browsers and React Native without polyfills: no Node
 * built-ins, no process, no Buffer, no filesystem and no ALP core. Transports come separately:
 * `@anhlp/alp-client/websocket` here, the Unix socket and named pipe in the Node entry.
 */

/**
 * @typedef {import('./rpc/client.js').AlpTransport} AlpTransport
 * @typedef {import('./rpc/client.js').TransportClose} TransportClose
 * @typedef {import('./rpc/client.js').TransportState} TransportState
 * @typedef {import('./rpc/client.js').AbortSignalLike} AbortSignalLike
 * @typedef {import('./rpc/client.js').RequestOptions} RequestOptions
 * @typedef {import('./rpc/client.js').AlpRpcClientOptions} AlpRpcClientOptions
 * @typedef {import('./rpc/handshake.js').ClientInfo} ClientInfo
 * @typedef {import('./rpc/reconnect.js').ReconnectOptions} ReconnectOptions
 * @typedef {import('./rpc/reconnect.js').ReconnectingClient} ReconnectingClient
 * @typedef {import('./rpc/reconnect.js').ReconnectState} ReconnectState
 * @typedef {import('./rpc/reconnect.js').Backoff} Backoff
 */
export { PROTOCOL_VERSION, MAX_FRAME, AlpRpcError, ERROR } from '@anhlp/alp-protocol';
export { AlpRpcClient, DEFAULT_MAX_PENDING } from './rpc/client.js';
export { AlpClientError, CLIENT_ERROR, isAlpClientError } from './rpc/errors.js';
export { createLineDecoder, utf8Length } from './rpc/framing.js';
export { MAX_TIMER_MS, timerDelay } from './rpc/timers.js';
export { hello } from './rpc/handshake.js';
export { backoffDelay, createReconnectingClient, retryable } from './rpc/reconnect.js';
export { attachments, base64Encode, conversation, sha256Hex, workspaceRegistry } from './rpc/registry.js';

export { watchTerminals } from "./rpc/terminal-directory.js";
