import { MAX_FRAME } from '@anhlp/alp-protocol';

/**
 * Gateway settings (docs/alp/remote-gateway.md §7). The defaults serve one client host on
 * loopback: a reverse proxy in front terminates TLS for remote clients. Binding anything but
 * loopback needs TLS here, or `allowInsecure` for a private network the owner vouches for.
 */

export const DEFAULT_PORT = 7434;

export const DEFAULT_LIMITS = Object.freeze({
  /** Largest WebSocket message a client may send, in bytes; at most the protocol's MAX_FRAME. */
  maxFrame: 4 * 1024 * 1024,
  maxConnections: 64,
  maxConnectionsPerCredential: 8,
  /** Requests of one connection waiting for an answer at once. */
  maxPending: 32,
  /** Requests per second per connection, with bursts up to `burst`. */
  rate: 20,
  burst: 40,
  /** Refused requests after which a connection that keeps sending is closed. */
  maxStrikes: 100,
  handshakeMs: 10_000,
  /** How long the gateway waits for alpd to answer one request; the outcome is unknown after it. */
  requestTimeoutMs: 120_000,
  /** Bytes a client may leave unread (socket buffer plus queue) before it is closed as too slow. */
  maxBufferedBytes: 8 * 1024 * 1024,
  maxQueue: 10_000,
  closeGraceMs: 5_000,
  heartbeatMs: 30_000,
  ticketTtlMs: 30_000,
  /** Failed authentications per client address within `authWindowMs` before it is refused for the window. */
  authFailures: 20,
  authWindowMs: 5 * 60_000,
});
export type Limits = typeof DEFAULT_LIMITS;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const isLoopbackHost = (host: string) => LOOPBACK.has(host);
export const isLoopbackAddress = (address: string | undefined) => !!address && (address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'));

export type GatewayConfigInput = {
  host?: string, port?: number, tls?: { cert: string, key: string },
  origins?: string[], hosts?: string[], trustProxy?: string[], allowInsecure?: boolean,
  socketPath?: string, limits?: Partial<Limits>,
};
export type GatewayConfig = {
  host: string, port: number, tls?: { cert: string, key: string },
  origins: Set<string>, hosts: Set<string>, trustProxy: Set<string>, allowInsecure: boolean,
  socketPath?: string, limits: Limits,
};

/** A browser Origin as browsers send it: scheme, host and port only, lower case. */
export function normalizeOrigin(origin: string) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Origin ${origin} must be http or https`);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error(`Origin ${origin} must have no path, query or credentials`);
  return url.origin.toLowerCase();
}

/** Checked settings with defaults. */
export function resolveConfig(input: GatewayConfigInput = {}): GatewayConfig {
  const host = input.host ?? '127.0.0.1';
  const port = input.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be 0 to 65535');
  if (!isLoopbackHost(host) && !input.tls && input.allowInsecure !== true) {
    throw new Error(`Refusing to listen on ${host} without TLS. Keep the default loopback address behind a TLS reverse proxy, give tls.cert and tls.key, or set allowInsecure for a network you trust.`);
  }
  if (input.tls && (typeof input.tls.cert !== 'string' || typeof input.tls.key !== 'string')) throw new Error('tls needs cert and key file paths');
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  for (const [name, value] of Object.entries(limits)) if (typeof value !== 'number' || !(value > 0)) throw new Error(`limits.${name} must be a positive number`);
  if (limits.maxFrame > MAX_FRAME) throw new Error(`limits.maxFrame cannot exceed the protocol's ${MAX_FRAME} bytes`);
  return {
    host,
    port,
    ...(input.tls ? { tls: input.tls } : {}),
    origins: new Set((input.origins ?? []).map(normalizeOrigin)),
    hosts: new Set((input.hosts ?? []).map(name => String(name).toLowerCase())),
    trustProxy: new Set(input.trustProxy ?? []),
    allowInsecure: input.allowInsecure === true,
    ...(input.socketPath ? { socketPath: input.socketPath } : {}),
    limits,
  };
}
