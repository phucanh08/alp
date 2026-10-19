// @ts-check
/**
 * @anhlp/alp-gateway (docs/alp/remote-gateway.md): an authenticated WebSocket front for one OS
 * user's alpd. Remote clients speak ALP protocol v1 through it; it reaches alpd only through the
 * client SDK over the daemon's private IPC socket, and never exposes that socket.
 */
export { createGateway, SUBPROTOCOL, TICKET_PROTOCOL_PREFIX, TICKET_PATH, WEBSOCKET_PATH } from './server.js';
export { ClientConnection, CLOSE_CODE } from './connection.js';
export { DEFAULT_LIMITS, DEFAULT_PORT, resolveConfig, normalizeOrigin } from './config.js';
export { CredentialStore, createCredential, reissueCredential, rotateCredential, revokeCredential, listCredentials, gatewayHome, credentialsFile, parseToken } from './credentials.js';
export { TicketBook } from './tickets.js';
export { EXPOSURE, PERMISSIONS, FORWARDED_CAPABILITIES, GATEWAY_ERROR, GATEWAY_REASON, SPEC_FIELDS, CONTENT_TYPES, GATEWAY_PROMPT_IMAGES, promptImageLimits, exposureOf, unclassified, workspaceOf } from './policy.js';
export { upstreamConnector, daemonMonitor } from './upstream.js';
export { createGatewayLogger, scrubGatewaySecrets } from './log.js';
