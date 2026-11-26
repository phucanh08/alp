/**
 * @anhlp/alp-gateway (docs/alp/remote-gateway.md): an authenticated WebSocket front for one OS
 * user's alpd. Remote clients speak ALP protocol v1 through it; it reaches alpd only through the
 * client SDK over the daemon's private IPC socket, and never exposes that socket.
 */
export { createGateway, SUBPROTOCOL, TICKET_PROTOCOL_PREFIX, TICKET_PATH, WEBSOCKET_PATH } from './server.ts';
export { ClientConnection, CLOSE_CODE } from './connection.ts';
export { DEFAULT_LIMITS, DEFAULT_PORT, resolveConfig, normalizeOrigin } from './config.ts';
export { CredentialStore, createCredential, reissueCredential, rotateCredential, updateCredential, revokeCredential, listCredentials, gatewayHome, credentialsFile, parseToken, renameWithRetry, RETRIABLE_RENAME_ERRORS } from './credentials.ts';
export { TicketBook } from './tickets.ts';
export { EXPOSURE, PERMISSIONS, FORWARDED_CAPABILITIES, GATEWAY_ERROR, GATEWAY_REASON, SPEC_FIELDS, CONTENT_TYPES, GATEWAY_PROMPT_IMAGES, promptImageLimits, exposureOf, unclassified, workspaceOf } from './policy.ts';
export { upstreamConnector, daemonMonitor } from './upstream.ts';
export { OWNER_LOOPBACK, FORWARDING_HEADERS, directLoopback, isForwardingHeader, ownerOptionError } from './owner.ts';
export { createGatewayLogger, scrubGatewaySecrets } from './log.ts';
