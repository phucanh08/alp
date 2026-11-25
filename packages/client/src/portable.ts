/**
 * The portable ALP client (docs/alp/client-sdk.md): the JSON-RPC engine, its errors, the reconnect
 * helper and NDJSON framing. It runs in Node, browsers and React Native without polyfills: no Node
 * built-ins, no process, no Buffer, no filesystem and no ALP core. Transports come separately:
 * `@anhlp/alp-client/websocket` here, the Unix socket and named pipe in the Node entry.
 */

export type { AlpTransport, TransportClose, TransportState, AbortSignalLike, RequestOptions, AlpRpcClientOptions } from './rpc/client.js';
export type { ClientInfo } from './rpc/connection/handshake.js';
export type { ReconnectOptions, ReconnectingClient, ReconnectState, Backoff } from './rpc/connection/reconnect.js';
export { PROTOCOL_VERSION, MAX_FRAME, AlpRpcError, ERROR } from '@anhlp/alp-protocol';
export { AlpRpcClient, DEFAULT_MAX_PENDING } from './rpc/client.js';
export { AlpClientError, CLIENT_ERROR, isAlpClientError } from './rpc/errors.js';
export { createLineDecoder, utf8Length } from './rpc/framing.js';
export { MAX_TIMER_MS, timerDelay } from './rpc/timers.js';
export { AGENT_CAPABILITY, hello } from './rpc/connection/handshake.js';
export { backoffDelay, createReconnectingClient, retryable } from './rpc/connection/reconnect.js';
export { attachments, base64Encode, conversation, sha256Hex, workspaceRegistry } from './rpc/registry.js';

export { watchTerminals } from "./rpc/terminal-directory.js";
