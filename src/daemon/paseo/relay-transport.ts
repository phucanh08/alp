// Copied from Paseo (https://github.com/getpaseo/paseo, commit b63a325, packages/server/src/server/relay-transport.ts
// and websocket/encrypted-relay-socket.ts), Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0 (paseo-web/LICENSE).
// Changed for ALP: a plain log function instead of pino, no socket metadata, and the two files in one.
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createDaemonChannel, type KeyPair, type Transport } from '@getpaseo/relay/e2ee';
import { buildRelayWebSocketUrl } from '@getpaseo/protocol/daemon-endpoints';

/** What the gateway is given for each paired device: a socket carrying Paseo's frames, decrypted. */
export interface RelaySocketLike {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send: (data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => void | Promise<void>;
  close: (code?: number, reason?: string) => void;
  terminate?: () => void;
  on: (event: 'message' | 'close' | 'error', listener: (...args: any[]) => void) => void;
  once: (event: 'close' | 'error', listener: (...args: any[]) => void) => void;
}

interface RelayWebSocketLike {
  readyState: number;
  bufferedAmount: number;
  send: (data: string | ArrayBuffer | Uint8Array, callback?: (error?: Error) => void) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  ping: () => void;
  on: (event: 'open' | 'message' | 'close' | 'error' | 'pong', listener: (...args: any[]) => void) => void;
}

export type RelayWebSocketFactory = (url: string) => RelayWebSocketLike;

type ControlMessage =
  | { type: 'sync'; connectionIds: string[] }
  | { type: 'connected'; connectionId: string }
  | { type: 'disconnected'; connectionId: string }
  | { type: 'ping' }
  | { type: 'pong' };

const CONTROL_PING_INTERVAL_MS = 10_000;
const CONTROL_STALE_TIMEOUT_MS = 30_000;
const CONTROL_READY_TIMEOUT_MS = 8_000;
const DATA_OPEN_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Paseo's high-water mark for a socket's queued bytes (websocket/physical-socket.ts there). */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const OPEN = 1;
const CLOSED = 3;

const createDefaultWebSocket: RelayWebSocketFactory = url => new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false });

function parseControl(raw: unknown): ControlMessage | null {
  try {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.type === 'ping' || parsed.type === 'pong') return { type: parsed.type };
    if (parsed.type === 'sync' && Array.isArray(parsed.connectionIds)) {
      return { type: 'sync', connectionIds: parsed.connectionIds.filter((id: unknown) => typeof id === 'string' && id.trim().length > 0) };
    }
    if ((parsed.type === 'connected' || parsed.type === 'disconnected') && typeof parsed.connectionId === 'string' && parsed.connectionId.trim()) {
      return { type: parsed.type, connectionId: parsed.connectionId.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Keeps a control socket open to the relay as this server, and opens a data socket for each
 * device the relay says is connected. Each data socket is end-to-end encrypted with the daemon's
 * key pair and handed to `attachSocket` once the device's handshake is done.
 */
export function startRelayTransport({ log, attachSocket, relayEndpoint, relayUseTls, serverId, daemonKeyPair, createWebSocket = createDefaultWebSocket }: {
  log: (message: string) => void;
  attachSocket: (socket: RelaySocketLike) => void;
  /** "host:port" */
  relayEndpoint: string;
  relayUseTls: boolean;
  serverId: string;
  daemonKeyPair: KeyPair;
  createWebSocket?: RelayWebSocketFactory;
}) {
  let stopped = false;
  let control: RelayWebSocketLike | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let keepalive: NodeJS.Timeout | null = null;
  let readyTimer: NodeJS.Timeout | null = null;
  let lastSeenAt = 0;
  let connected = false;
  const dataSockets = new Map<string, RelayWebSocketLike>();
  const listeners = new Set<(connected: boolean) => void>();
  const setConnected = (value: boolean) => {
    if (connected === value) return;
    connected = value;
    for (const listener of listeners) listener(value);
  };

  const clearControlTimers = () => {
    if (keepalive) { clearInterval(keepalive); keepalive = null; }
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  };

  const connectControl = () => {
    if (stopped) return;
    const url = buildRelayWebSocketUrl({ endpoint: relayEndpoint, useTls: relayUseTls, serverId, role: 'server' });
    const socket = createWebSocket(url);
    control = socket;
    let ready = false;
    const markReady = () => {
      if (control !== socket || ready) return;
      ready = true;
      reconnectAttempt = 0;
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      setConnected(true);
      log(`relay connected to ${relayEndpoint}`);
    };

    socket.on('open', () => {
      if (control !== socket) return;
      lastSeenAt = Date.now();
      clearControlTimers();
      readyTimer = setTimeout(() => {
        if (stopped || control !== socket || ready) return;
        log(`relay ${relayEndpoint} sent nothing for ${CONTROL_READY_TIMEOUT_MS / 1000} s; reconnecting`);
        try { socket.terminate(); } catch {}
      }, CONTROL_READY_TIMEOUT_MS);
      // A half-open socket may never close by itself: protocol pings find it out.
      keepalive = setInterval(() => {
        if (stopped || control !== socket || socket.readyState !== OPEN) return;
        if (Date.now() - lastSeenAt > CONTROL_STALE_TIMEOUT_MS) {
          log('relay went quiet; reconnecting');
          try { socket.terminate(); } catch {}
          return;
        }
        try { socket.ping(); } catch { try { socket.terminate(); } catch {} }
      }, CONTROL_PING_INTERVAL_MS);
      try { socket.ping(); } catch { try { socket.terminate(); } catch {} }
    });

    socket.on('close', (code: number, reason: unknown) => {
      if (control !== socket) return;
      log(`relay disconnected (${code}${reason ? ` ${String(reason)}` : ''})`);
      control = null;
      clearControlTimers();
      setConnected(false);
      scheduleReconnect();
    });
    // The close that follows schedules the reconnect.
    socket.on('error', (error: Error) => { if (control === socket) log(`relay error: ${error?.message ?? error}`); });
    socket.on('pong', () => { if (control === socket) lastSeenAt = Date.now(); });

    socket.on('message', (data: unknown) => {
      if (control !== socket) return;
      lastSeenAt = Date.now();
      const message = parseControl(data);
      if (!message) return;
      markReady();
      if (message.type === 'ping') { try { socket.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch {} return; }
      if (message.type === 'sync') { for (const id of message.connectionIds) ensureDataSocket(id); return; }
      if (message.type === 'connected') { ensureDataSocket(message.connectionId); return; }
      if (message.type === 'disconnected') {
        const existing = dataSockets.get(message.connectionId);
        if (existing) { try { existing.close(1001, 'Client disconnected'); } catch {} dataSockets.delete(message.connectionId); }
      }
    });
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectControl(); }, Math.min(30_000, 1000 * reconnectAttempt));
  };

  const ensureDataSocket = (connectionId: string) => {
    if (stopped || !connectionId || dataSockets.has(connectionId)) return;
    const url = buildRelayWebSocketUrl({ endpoint: relayEndpoint, useTls: relayUseTls, serverId, role: 'server', connectionId });
    const socket = createWebSocket(url);
    dataSockets.set(connectionId, socket);
    let attached = false;
    const openTimer = setTimeout(() => {
      if (stopped || socket.readyState === OPEN) return;
      try { socket.terminate(); } catch {}
    }, DATA_OPEN_TIMEOUT_MS);
    socket.on('open', () => {
      clearTimeout(openTimer);
      if (attached) return;
      attached = true;
      void attachEncrypted(socket, daemonKeyPair, attachSocket, log);
    });
    socket.on('close', () => {
      clearTimeout(openTimer);
      if (dataSockets.get(connectionId) === socket) dataSockets.delete(connectionId);
    });
    socket.on('error', (error: Error) => log(`relay device socket error: ${error?.message ?? error}`));
  };

  connectControl();

  return {
    /** Whether the relay acknowledged this server's control socket. */
    get connected() { return connected; },
    onConnected(listener: (connected: boolean) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      clearControlTimers();
      if (control) { try { control.close(); } catch {} control = null; }
      for (const socket of dataSockets.values()) { try { socket.close(); } catch {} }
      dataSockets.clear();
      setConnected(false);
      listeners.clear();
    },
  };
}

export type RelayTransportController = ReturnType<typeof startRelayTransport>;

/** Runs the device's E2EE handshake, then hands the decrypted socket on; messages before that wait. */
async function attachEncrypted(socket: RelayWebSocketLike, keyPair: KeyPair, attachSocket: (socket: RelaySocketLike) => void, log: (message: string) => void) {
  const timer = setTimeout(() => { log('relay device handshake timed out'); socket.terminate(); }, HANDSHAKE_TIMEOUT_MS);
  try {
    const emitter = new EventEmitter();
    const pending: Array<string | ArrayBuffer> = [];
    let attached = false;
    const channel = await createDaemonChannel(transportOf(socket), keyPair, {
      onmessage: data => { if (attached) emitter.emit('message', data); else pending.push(data); },
      onclose: (code, reason) => emitter.emit('close', code, reason),
      onerror: error => emitter.emit('error', error),
    });
    clearTimeout(timer);
    let readyState = OPEN;
    channel.setState('open');
    emitter.on('close', () => { readyState = CLOSED; });
    const terminate = () => { if (readyState === CLOSED) return; readyState = CLOSED; socket.terminate(); };
    const encrypted: RelaySocketLike = {
      get readyState() { return readyState; },
      get bufferedAmount() { return socket.bufferedAmount ?? 0; },
      send(data) {
        if (readyState !== OPEN) return Promise.reject(new Error('Encrypted relay socket is not open'));
        const outbound = typeof data === 'string' || data instanceof ArrayBuffer ? data : copyBuffer(data);
        if ((socket.bufferedAmount ?? 0) + channel.outboundWireByteLength(outbound) > MAX_BUFFERED_BYTES) {
          terminate();
          return Promise.reject(new Error('Encrypted relay socket exceeded its outbound high-water mark'));
        }
        return channel.send(outbound).catch(error => { emitter.emit('error', error); throw error; });
      },
      close(code, reason) { if (readyState === CLOSED) return; readyState = CLOSED; channel.close(code, reason); },
      terminate,
      on(event, listener) { emitter.on(event, listener); },
      once(event, listener) { emitter.once(event, listener); },
    };
    attachSocket(encrypted);
    attached = true;
    for (const message of pending) emitter.emit('message', message);
  } catch (error: any) {
    log(`relay device handshake failed: ${error?.message ?? error}`);
    try { socket.close(1011, 'E2EE handshake failed'); } catch {}
  } finally {
    clearTimeout(timer);
  }
}

function transportOf(socket: RelayWebSocketLike): Transport {
  const transport: Transport = {
    send: data => new Promise<void>((resolve, reject) => {
      try { socket.send(data, error => (error ? reject(error) : resolve())); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    }),
    close: (code, reason) => socket.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.on('message', (data: unknown, isBinary: boolean) => transport.onmessage?.({ data: messageData(data, isBinary === true), isBinary: isBinary === true }));
  socket.on('close', (code: unknown, reason: unknown) => transport.onclose?.(typeof code === 'number' ? code : 1006, String(reason ?? '')));
  socket.on('error', (error: unknown) => transport.onerror?.(error instanceof Error ? error : new Error(String(error))));
  return transport;
}

function messageData(data: unknown, binary: boolean): string | ArrayBuffer {
  if (!binary) {
    if (typeof data === 'string') return data;
    const buffer = bufferOf(data);
    return buffer ? buffer.toString('utf8') : String(data);
  }
  if (data instanceof ArrayBuffer) return data;
  const buffer = bufferOf(data);
  return buffer ? copyBuffer(buffer) : String(data);
}

function copyBuffer(view: ArrayBufferView): ArrayBuffer {
  const out = new Uint8Array(view.byteLength);
  out.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return out.buffer;
}

function bufferOf(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) {
    const parts: Buffer[] = [];
    for (const part of data) {
      if (Buffer.isBuffer(part)) parts.push(part);
      else if (part instanceof ArrayBuffer) parts.push(Buffer.from(part));
      else if (ArrayBuffer.isView(part)) parts.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
      else if (typeof part === 'string') parts.push(Buffer.from(part, 'utf8'));
      else return null;
    }
    return Buffer.concat(parts);
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
