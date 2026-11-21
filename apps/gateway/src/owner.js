// @ts-check
import { isLoopbackHost } from './config.js';

/**
 * The host owner (t-a95b, docs/alp/remote-gateway.md §5.19): the one connection that may call the
 * methods the exposure matrix marks `owner` (policy.js). Only alp dashboard creates a gateway with
 * an `owner` option; standalone `alp-gateway serve` never does, so behind it no connection is the
 * owner and an owner method answers exactly as a denied one (-32601 not_exposed).
 *
 * A connection is the owner while ALL of these hold, the credential part checked again on every
 * request (connection.js #isOwner):
 *   1. the gateway was created with `owner` (and so listens on plain loopback: ownerOptionError);
 *   2. its credential is the one `owner.credentialId()` names NOW: after `alp dashboard rotate` or a
 *      revoke the old token is no longer the owner, even on a connection that is still open;
 *   3. its WebSocket came in on a direct loopback socket (directLoopback below): 127.0.0.1, ::1 or
 *      ::ffff:127.0.0.1 as the socket's own peer address, through no trusted proxy, and with no
 *      forwarding header (isForwardingHeader), so a local reverse proxy that says it forwards for
 *      someone is not the owner. A plain TCP forwarder (ssh -R, socat) adds no header and looks like a
 *      direct client; it still needs the dashboard token;
 *   4. the connection is not marked as an ALP agent's (an agent credential, or a hello that says an
 *      agent started the client): what only the user may do stays the user's.
 * No credential permission grants it: a permission string added by hand to credentials.json is
 * either refused by the store or is one of PERMISSIONS, none of which is the owner.
 *
 * The Paseo relay (`alp dashboard pair --on`) never reaches this listener: it is the Paseo
 * integration's own process, which attaches relay sockets to its Paseo bridge and speaks to alpd
 * on its private IPC socket with its own token (integrations/paseo/server/paseo/index.ts, createRelay
 * → gateway.attach, and connect(lock.socket)); it holds neither this listener's address nor the
 * dashboard credential.
 */

/** The socket peer addresses that count as this machine for the owner (exactly these, not 127/8). */
export const OWNER_LOOPBACK = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Request headers that say a request was forwarded for another client. Any one of them on the
 * WebSocket upgrade means the connection is not the owner, whatever the socket's address: a proxy
 * or tunnel on this machine would connect from loopback.
 */
export const FORWARDING_HEADERS = Object.freeze(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'via', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip']);

/**
 * Whether a (lower-case) header name says the request was forwarded: one of FORWARDING_HEADERS, or
 * any name in the families proxies use for it (`*forwarded*`, `x-real-*`, `x-original-*`,
 * `*-client-ip`, `*-connecting-ip`), so a proxy's own variant (x-forwarded-server,
 * x-original-forwarded-for, x-cluster-client-ip, fastly-client-ip) is caught too. A plain TCP
 * forwarder adds no header at all and cannot be told from a direct client (docs §5.19).
 * @param {string} name
 */
export function isForwardingHeader(name) {
  return FORWARDING_HEADERS.includes(name) || name.includes('forwarded') || name.startsWith('x-real-') || name.startsWith('x-original-') || name.endsWith('-client-ip') || name.endsWith('connecting-ip');
}

/**
 * Whether an upgrade request came straight from this machine: the socket's own peer address is
 * loopback, the peer was not resolved through a trusted proxy, and no forwarding header is present.
 * @param {{ socket: { remoteAddress?: string }, headers: Record<string, unknown> }} request
 * @param {{ proxied: boolean }} peer what server.js peerOf made of the request
 */
export function directLoopback(request, peer) {
  if (peer.proxied) return false;
  if (!OWNER_LOOPBACK.includes(request.socket.remoteAddress ?? '')) return false;
  return !Object.keys(request.headers).some(name => isForwardingHeader(name.toLowerCase()));
}

/**
 * An owner handler: runs in the gateway's process (alp dashboard's, as the user) for an owner
 * connection only, after the matrix and the owner check. `params` holds only the entry's `params`
 * when it lists them, else the request's params as sent: a handler checks its own. `daemon.request`
 * sends a request to alpd on this connection's own alpd connection. A thrown error with a numeric
 * `code` (and optional `data`) reaches the client as that error; any other throw is logged and
 * answered as "<method> failed in the gateway".
 * @typedef {(context: { method: string, params: Record<string, any>, principal: string, daemon: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> } }) => unknown} OwnerHandler
 */

/**
 * @typedef {{
 *   credentialId: () => string | undefined,
 *   methods?: Readonly<Record<string, OwnerHandler>>,
 * }} OwnerOption
 *   `credentialId` is read on every request, so it must answer the credential the owner holds now.
 */

/**
 * Why an owner option cannot be used with this config, or undefined. The owner is a plain loopback
 * listener: no TLS (its clients are on this machine), no trusted proxy, a loopback bind address.
 * @param {OwnerOption | undefined} owner @param {import('./config.js').GatewayConfig} config
 */
export function ownerOptionError(owner, config) {
  if (!owner) return undefined;
  if (typeof owner.credentialId !== 'function') return 'owner.credentialId must be a function';
  if (owner.methods !== undefined && (owner.methods === null || typeof owner.methods !== 'object')) return 'owner.methods must be an object of handlers';
  for (const [name, handler] of Object.entries(owner.methods ?? {})) if (typeof handler !== 'function') return `owner.methods[${JSON.stringify(name)}] is not a function`;
  if (!isLoopbackHost(config.host)) return `an owner gateway listens on loopback only, not ${config.host}`;
  if (config.tls) return 'an owner gateway does not terminate TLS: its clients are on this machine';
  if (config.trustProxy.size) return 'an owner gateway trusts no proxy';
  if (config.allowInsecure) return 'an owner gateway does not allow insecure remote clients';
  return undefined;
}
