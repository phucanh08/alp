import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
/**
 * A socket carrying Paseo's frames: the browser's WebSocket, or a device's decrypted relay socket
 * (ALPD §64), whose send may return a promise.
 */
export interface FrameSocket {
  readonly readyState: number;
  /** Bytes queued and not yet sent; a ws WebSocket and a relay socket both report it. */
  readonly bufferedAmount?: number;
  /** A string is a text frame; bytes are a binary frame (a terminal's stream, ALPD §62). */
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
  on(event: 'message' | 'close' | 'error', listener: (...args: any[]) => void): unknown;
}

/**
 * The ALP web app is Paseo's app (D31, ALPD §62), so alpd speaks Paseo's daemon protocol to it
 * on the page's own origin: a `hello` with the token as its password (or the `paseo.bearer.*`
 * subprotocol), then `server_info`, then session messages. ALP answers what it has and refuses the
 * rest with `rpc_error` code `not_implemented`, whose text the app shows as it is ("Tính năng đang
 * phát triển" in the user's language), so no request waits out the client's timeout.
 */

/** Paseo's protocol version and close codes (packages/server/src/server/websocket-server.ts there). */
export const PASEO_PROTOCOL_VERSION = 1;
const CLOSE_AUTH_FAILED = 4401;
const CLOSE_INCOMPATIBLE = 4003;
const CLOSE_INVALID_HELLO = 4002;
/** How long a socket may stay open without a good hello. */
const HELLO_TIMEOUT_MS = 15_000;
const OPEN = 1;

export const NOT_IMPLEMENTED = 'not_implemented';
export const BEARER_PREFIX = 'paseo.bearer.';

export type SessionMessage = { type: string; requestId?: string; [key: string]: unknown };
export type Outbound = { type: string; payload?: unknown; [key: string]: unknown };

export type ClientContext = {
  clientId: string;
  /** Socket lifetime, never derived from the untrusted hello identity. */
  assertActive?(): void;
  /** Sends one session message to this client. */
  emit(message: Outbound): void;
  /** Sends one binary frame, as Paseo's terminal stream does ([opcode, slot, payload]). */
  emitBinary(bytes: Uint8Array): void;
  /** Bytes waiting on this client's socket, so a slow client can be left behind and resynced. */
  buffered(): number;
};

/** A request handler: returns the reply, or emits by itself and returns nothing. */
export type Handler = (message: any, client: ClientContext) => Outbound | void | Promise<Outbound | void>;

export type GatewayOptions = {
  token: () => string;
  serverId: () => string;
  version: string;
  handlers: Record<string, Handler>;
  /** What the app may light up; anything absent stays hidden or answers "in development". */
  features: Record<string, boolean>;
  /** Runs before each server_info, so features that follow the host (terminals) are current. */
  beforeServerInfo?: () => Promise<unknown>;
  onClient?(client: ClientContext): () => void;
  onBinary?(bytes: Uint8Array, client: ClientContext): void;
  /** The text of a not_implemented answer, in the user's language. */
  inDevelopment?: () => string | Promise<string>;
  log?: (message: string) => void;
};

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The subprotocol a browser offers to carry its password; alpd answers with the same one. */
export function bearerOf(protocols: Iterable<string>) {
  for (const protocol of protocols) if (protocol.startsWith(BEARER_PREFIX)) return protocol;
  return undefined;
}

export function createPaseoGateway(options: GatewayOptions) {
  const { handlers, log = () => {} } = options;
  const inDevelopment = async () => { try { return await options.inDevelopment?.() ?? 'This feature is in development'; } catch { return 'This feature is in development'; } };
  const clients = new Set<ClientContext>();

  async function serverInfo() {
    // Voice and dictation say why they are off, so the app shows it instead of waiting on them.
    const off = { enabled: false, reason: await inDevelopment() };
    try { await options.beforeServerInfo?.(); } catch (error: any) { log(`paseo server_info: ${error?.message ?? error}`); }
    return {
      type: 'status',
      payload: {
        status: 'server_info',
        protocolVersion: PASEO_PROTOCOL_VERSION,
        serverId: options.serverId(),
        hostname: os.hostname(),
        version: options.version,
        features: options.features,
        capabilities: { voice: { dictation: off, voice: off } },
      },
    };
  }

  function attach(ws: FrameSocket, { bearer }: { bearer?: string } = {}) {
    let ended = false;
    let client: ClientContext | undefined;
    let detach: (() => void) | undefined;
    const write = (data: string | Uint8Array) => {
      if (ended || ws.readyState !== OPEN) return;
      // A relay socket's send fails as a promise when the device has gone; its close event follows.
      let sent: any;
      try { sent = ws.send(data); } catch { return; }
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    };
    const send = (frame: unknown) => write(JSON.stringify(frame));
    const close = (code: number, reason: string) => { try { ws.close(code, reason); } catch {} };
    const timer = setTimeout(() => { if (!client) close(CLOSE_AUTH_FAILED, 'Hello timed out'); }, HELLO_TIMEOUT_MS);
    const bearerOk = bearer !== undefined && same(bearer.slice(BEARER_PREFIX.length), options.token());

    async function hello(message: any) {
      if (ended || client) return;
      if (typeof message.clientId !== 'string' || !message.clientId.trim()) return close(CLOSE_INVALID_HELLO, 'Invalid hello');
      const reject = (reason: 'password_required' | 'incorrect_password' | 'incompatible_protocol') => {
        send({ type: 'hello.rejected', reason, accepts: ['password'] });
        close(reason === 'incompatible_protocol' ? CLOSE_INCOMPATIBLE : CLOSE_AUTH_FAILED, reason === 'incompatible_protocol' ? 'Incompatible protocol version' : reason === 'password_required' ? 'Password required' : 'Incorrect password');
      };
      if (typeof message.protocolVersion !== 'number' || message.protocolVersion < 1) return reject('incompatible_protocol');
      const password = message.auth?.kind === 'password' && typeof message.auth.password === 'string' ? message.auth.password : undefined;
      if (!bearerOk && password === undefined) return reject('password_required');
      if (!bearerOk && !same(password!, options.token())) return reject('incorrect_password');
      clearTimeout(timer);
      if (!client) {
        client = {
          clientId: message.clientId.trim(),
          assertActive: () => { if (ended) throw new Error('This connection is closed'); },
          emit: outbound => send({ type: 'session', message: outbound }),
          emitBinary: bytes => write(bytes),
          buffered: () => (typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0),
        };
        clients.add(client);
        detach = options.onClient?.(client);
      }
      client.emit(await serverInfo());
    }

    async function session(message: SessionMessage) {
      if (ended || !client || !message || typeof message.type !== 'string') return;
      if (process.env.ALP_PASEO_DEBUG) log(`paseo <- ${message.type}${message.requestId ? ` ${message.requestId}` : ''}`);
      if (message.type === 'ping' && typeof message.requestId === 'string') {
        const now = Date.now();
        client.emit({ type: 'pong', payload: { requestId: message.requestId, ...(typeof message.clientSentAt === 'number' ? { clientSentAt: message.clientSentAt } : {}), serverReceivedAt: now, serverSentAt: Date.now() } });
        return;
      }
      const handler = handlers[message.type];
      const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
      if (!handler) {
        // One-way messages ALP has no use for are dropped; a request gets an answer at once.
        if (requestId) client.emit({ type: 'rpc_error', payload: { requestId, requestType: message.type, error: await inDevelopment(), code: NOT_IMPLEMENTED } });
        return;
      }
      try {
        const reply = await handler(message, client);
        if (reply) client.emit(reply);
      } catch (error: any) {
        log(`paseo ${message.type} failed: ${error?.message ?? error}`);
        if (requestId) client.emit({ type: 'rpc_error', payload: { requestId, requestType: message.type, error: error?.message ?? String(error), ...(error?.code ? { code: String(error.code) } : {}) } });
      }
    }

    ws.on('message', (data: unknown, binary?: boolean) => {
      if (ended) return;
      if (binary || data instanceof ArrayBuffer || (binary === undefined && ArrayBuffer.isView(data))) {
        if (!client) return close(CLOSE_INVALID_HELLO, 'Hello required before binary frames');
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : Array.isArray(data) ? Buffer.concat(data) : undefined;
        if (bytes) { try { options.onBinary?.(bytes, client); } catch (error: any) { log(`paseo binary failed: ${error?.message ?? error}`); close(1002, 'Invalid binary frame'); } }
        return;
      }
      let frame: any;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (process.env.ALP_PASEO_DEBUG && frame?.type !== 'session') log(`paseo <= ${frame?.type}`);
      if (frame?.type === 'ping') send({ type: 'pong' });
      else if (frame?.type === 'hello') void hello(frame);
      else if (frame?.type === 'session') void session(frame.message);
    });
    if (process.env.ALP_PASEO_DEBUG) ws.on('close', (code: number, reason: unknown) => log(`paseo socket closed ${code} ${String(reason)} (client ${client?.clientId ?? 'none'})`));
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (client) clients.delete(client);
      detach?.();
      detach = undefined;
    };
    ws.on('close', end);
    ws.on('error', end);
  }

  return {
    attach,
    /** Sends a session message to every connected client. */
    broadcast(message: Outbound) { for (const client of clients) client.emit(message); },
    get clients() { return clients.size; },
  };
}

export type PaseoGateway = ReturnType<typeof createPaseoGateway>;
