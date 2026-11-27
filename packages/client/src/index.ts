export { PROTOCOL_VERSION, MAX_FRAME, AlpRpcError, encodeFrame } from '@anhlp/alp-protocol';
// The Node entry carries the whole portable API and the WebSocket transport too, so Node callers need one import.
export * from './portable.ts';
export { connectWebSocket, createWebSocketTransport, redactUrl, CLOSE_CODE } from './connection/websocket.ts';
export { createSocketTransport } from './connection/ipc.ts';
export type { DaemonLockContents, DaemonLock, LiveLock, HoldOps } from './daemon/lock.ts';
export type { LifecycleOwner } from './daemon/lifecycle.ts';
export { alpHome, daemonPaths, assertPrivateDirectory, assertPrivateSocket, findDaemonEntry } from './daemon/paths.ts';
export { bootId, _setBootIdForTest, bootTime, isSameBoot, processBirth } from './daemon/boot.ts';
export { readLock, holdOps, lockAlive, acquireDaemonLock, releaseDaemonLock } from './daemon/lock.ts';
export { readDaemonLifecycle, daemonLifecycleWaitMs, withDaemonLifecycle, DAEMON_START_TIMEOUT_MS, daemonStartTimeoutMs, ensureDaemon } from './daemon/lifecycle.ts';
export type { SocketTransportOptions, AlpClientOptions } from './connection/connect.ts';
export { AlpClient, connectSocket, connect } from './connection/connect.ts';
export { assertIntegrationName, discoverIntegration, integrationAlive, startIntegration } from './integration/discover.ts';
