/**
 * The portable ALP client (docs/alp/client-sdk.md): the JSON-RPC engine, its errors, the reconnect
 * helper and NDJSON framing. It runs in Node, browsers and React Native without polyfills: no Node
 * built-ins, no process, no Buffer, no filesystem and no ALP core. Transports come separately:
 * `@anhlp/alp-client/websocket` here, the Unix socket and named pipe in the Node entry.
 */

export type { AlpTransport, TransportClose, TransportState, AbortSignalLike, RequestOptions, AlpRpcClientOptions } from './rpc/client.ts';
export type { ClientInfo } from './rpc/connection/handshake.ts';
export type { ReconnectOptions, ReconnectingClient, ReconnectState, Backoff } from './rpc/connection/reconnect.ts';
export { PROTOCOL_VERSION, MAX_FRAME, AlpRpcError, ERROR } from '@anhlp/alp-protocol';
export { AlpRpcClient, DEFAULT_MAX_PENDING } from './rpc/client.ts';
export { AlpClientError, CLIENT_ERROR, isAlpClientError } from './rpc/errors.ts';
export { createLineDecoder, utf8Length } from './rpc/framing.ts';
export { MAX_TIMER_MS, timerDelay } from './rpc/timers.ts';
export { AGENT_CAPABILITY, hello } from './rpc/connection/handshake.ts';
export { backoffDelay, createReconnectingClient, retryable } from './rpc/connection/reconnect.ts';
export { attachments, base64Encode, conversation, sha256Hex, workspaceRegistry } from './rpc/registry.ts';

export { watchTerminals } from "./rpc/terminal-directory.ts";
